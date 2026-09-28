// lib/browser.js —— 无头浏览器取数层（零 npm 依赖）
//
// 为什么需要它：有些搜索引擎（Google / Brave / Startpage / Ecosia）对普通 HTTP 客户端
// 返回"需要 JavaScript"的占位页或直接回 403/429，但真实浏览器能正常出结果。
//
// 实现方式：直接驱动 Chrome / Edge 的 DevTools Protocol。
//   - 只用一个常驻实例 + 一个常驻 tab，靠 `Page.navigate` 复用渲染进程；
//     冷启动约 1s，之后单次搜索 0.7~3s（实测）。
//   - 用 Node 内置的 `WebSocket`（Node ≥ 22）发 CDP 消息，不需要 puppeteer/playwright。
//   - 结果在页面内用 CSS 选择器提取，避免把整页 HTML 搬回来再解析。
//   - 空闲超过 `idleMs` 自动关掉浏览器，不常驻占内存。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── 浏览器可执行文件探测 ─────────────────────────────────────────────

const WIN_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe'),
];

const UNIX_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** 找到可用的浏览器可执行文件；找不到返回 null。 */
export function findBrowser(explicit) {
  const list = explicit ? [explicit] : process.platform === 'win32' ? WIN_CANDIDATES : UNIX_CANDIDATES;
  for (const p of list) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** 供设置页/诊断用：报告探测到的浏览器与是否可用。 */
export function browserDiagnostics(explicit) {
  const found = findBrowser(explicit);
  return {
    platform: process.platform,
    explicit: explicit || null,
    path: found,
    ready: Boolean(found),
    hasWebSocket: typeof globalThis.WebSocket === 'function',
    reason: found
      ? null
      : typeof globalThis.WebSocket !== 'function'
        ? `Node ${process.version} 没有内置 WebSocket（需要 Node ≥ 22）`
        : '没有找到 Chrome/Edge，请在设置里手动填写可执行文件路径',
  };
}

// ── 极简 CDP 客户端 ─────────────────────────────────────────────────

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.onClose = null;
    ws.addEventListener('message', (ev) => this.#dispatch(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
      if (this.onClose) this.onClose();
    });
    ws.addEventListener('error', () => { /* close 事件会紧随其后 */ });
  }

  #dispatch(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 浏览器实例 ──────────────────────────────────────────────────────

class BrowserInstance {
  constructor({ exe, proxy, headless, userAgent, window_size, idleMs, verbose, userDataDir }) {
    Object.assign(this, { exe, proxy, headless, userAgent, idleMs, verbose });
    this.windowSize = window_size || '1440,900';
    this.child = null;
    this.client = null;
    this.sessionId = null;
    this.targetId = null;
    this.ownsProfile = !userDataDir;          // 自建临时 profile 才由我们负责删
    this.profileDir = userDataDir || null;    // 配置的持久 profile（跨进程复用 Cookie）
    this.userDataDir = null;                  // 本次运行实际用的目录
    this.booting = null;
    this.queue = Promise.resolve();   // 串行化同一实例上的导航
    this.idleTimer = null;
    this.navigations = 0;
    this.searchCount = 0;
  }

  log(...args) { if (this.verbose) console.log('[web-search/browser]', ...args); }

  async ensureUp() {
    if (this.client && !this.client.closed && this.child && this.child.exitCode === null) return;
    if (this.booting) return this.booting;
    this.booting = this.#boot()
      .catch((err) => { this.#teardownQuiet(); throw err; })
      .finally(() => { this.booting = null; });
    return this.booting;
  }

  async #boot() {
    if (this.profileDir) {
      // 持久 profile：复用 Cookie（Cloudflare 的 cf_clearance、同意 Cookie 之类）
      try { mkdirSync(this.profileDir, { recursive: true }); } catch (e) {
        throw new Error(`无法创建浏览器 profile 目录 ${this.profileDir}：${e.message}`);
      }
      this.userDataDir = this.profileDir;
      this.ownsProfile = false;
    } else {
      this.userDataDir = mkdtempSync(join(tmpdir(), 'dsh-websearch-'));
      this.ownsProfile = true;
    }
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-service-autorun',
      '--password-store=basic',
      '--use-mock-keychain',
      // 后台 tab 降频会让 SPA 结果迟迟不出，关掉这三个
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      '--hide-scrollbars',
      `--window-size=${this.windowSize}`,
      `--user-agent=${this.userAgent || DEFAULT_UA}`,
      '--accept-lang=zh-CN,zh;q=0.9,en;q=0.8',
    ];
    if (this.headless !== false) args.unshift('--headless=new');
    if (this.proxy) args.unshift(`--proxy-server=${this.proxy}`);
    args.push('about:blank');

    this.log('启动', this.exe, this.headless === false ? '(有头)' : '(无头)');
    this.child = spawn(this.exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    // DevTools 端口是从 stderr 里读出来的，没有别的办法（port=0 表示随机端口）
    let errBuf = '';
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('浏览器 20s 内没吐出 DevTools 端口')), 20000);
      const onData = (d) => {
        errBuf += d.toString();
        const m = errBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      };
      this.child.stderr.on('data', onData);
      this.child.on('error', (e) => { clearTimeout(timer); reject(new Error(`启动浏览器失败：${e.message}`)); });
      this.child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`浏览器提前退出 (code ${c})`)); });
    });

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); });
    });
    this.client = new CDPClient(ws);
    this.client.onClose = () => { this.log('CDP 断开，下次搜索会重启浏览器'); };
    this.browserVersion = version.Browser;

    const { targetId } = await this.client.send('Target.createTarget', { url: 'about:blank' });
    this.targetId = targetId;
    ({ sessionId: this.sessionId } = await this.client.send('Target.attachToTarget', { targetId, flatten: true }));
    await this.client.send('Page.enable', {}, this.sessionId);
    await this.client.send('Runtime.enable', {}, this.sessionId);
    this.log('就绪', version.Browser);
  }

  #teardownQuiet() {
    try { this.client?.close(); } catch { /* ignore */ }
    this.client = null;
    this.sessionId = null;
    try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
    this.child = null;
    if (this.userDataDir && this.ownsProfile) {
      // Chrome 退出后临时目录可能还被占，删不掉就算了（系统会清 temp）
      try { rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    this.userDataDir = null;
  }

  shutdown() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.#teardownQuiet();
  }

  #touchIdle() {
    clearTimeout(this.idleTimer);
    if (!this.idleMs || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => { this.log('空闲回收'); this.shutdown(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * 打开一个 URL，等结果容器出现（或页面加载完），在页面内提取结果。
   * @returns {Promise<{items: Array, title: string, finalUrl: string, blocked: boolean, waitedMs: number}>}
   */
  async search({ url, resultSelector, titleSelector, linkSelector, limit = 8, settleRounds = 2, waitMs = 10000, noResultMs = 4000, challengeRetryLimit = 2 }) {
    const run = this.queue.then(async () => {
      await this.ensureUp();
      const t0 = Date.now();
      this.navigations += 1;
      const client = this.client;
      const sessionId = this.sessionId;

      let loadCount = 0;
      const onLoad = () => { loadCount += 1; };
      client.on('Page.loadEventFired', onLoad);

      const evalIn = async (expression) => {
        const res = await client.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        );
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || '页面内脚本异常');
        return res.result?.value;
      };

      try {
        await client.send('Page.navigate', { url }, sessionId);

        const probe = `(() => {
          const n = document.querySelectorAll(${JSON.stringify(resultSelector)}).length;
          return { n, t: document.title, u: location.href };
        })()`;

        let hits = 0;
        let title = '';
        let finalUrl = url;
        let everLoaded = false;
        let stableRounds = 0;      // 结果条数连续几轮没变
        let navMs = null;          // 首个结果出现（或页面加载完）的耗时
        let challengeRetries = 0;  // Cloudflare 挑战重试次数
        const deadline = Date.now() + waitMs;
        const noResultDeadline = Date.now() + noResultMs;
        while (Date.now() < deadline) {
          if (loadCount > 0) everLoaded = true;
          const st = await evalIn(probe).catch(() => null);
          if (st) {
            const grew = st.n > hits;
            hits = st.n;
            title = st.t || '';
            finalUrl = st.u || url;

            // 已经确认被拦（验证码 / Google sorry 页）就别再烧预算
            if (/\/sorry\/index|[?&](captcha|showcaptcha)|人机验证/i.test(finalUrl)) break;

            if (hits > 0) {
              // 结果容器出现 ≠ 结果渲染完（Brave/DDG 是边出边填的骨架屏）。
              // 连续 `settleRounds` 轮条数不再增长才认为稳定。
              if (navMs === null) navMs = Date.now() - t0;
              stableRounds = grew ? 0 : stableRounds + 1;
              if (stableRounds >= settleRounds) break;
            } else {
              if (everLoaded && navMs === null) navMs = Date.now() - t0;
              // Cloudflare 之类的"稍等一下"中间页：重载一两次，通常自动放行
              const isChallenge = /just a moment|请稍候|checking your browser|attention required|verify(ing)? you/i.test(title);
              if (isChallenge && challengeRetries < challengeRetryLimit && everLoaded && Date.now() - t0 > 1200) {
                challengeRetries += 1;
                this.log(`遇到中间页「${title}」，重试 ${challengeRetries}/${challengeRetryLimit}`);
                await sleep(900);
                await client.send('Page.navigate', { url }, sessionId).catch(() => {});
                await sleep(1200);
                continue;
              }
              // 一直没结果：给挑战留出自动放行的时间，但别等到总预算
              if (everLoaded && Date.now() > noResultDeadline) break;
            }
          }
          await sleep(250);
        }

        const waitedMs = Date.now() - t0;
        let blocked = /\/sorry\/index|[?&](captcha|showcaptcha)|人机验证/i.test(`${finalUrl} ${title}`);

        // 有些站点（实测 Brave）限流时给的是一个"正常标题 + 极短正文"的页面：
        // URL 和 title 都看不出被拦，必须看正文才知道。这里补一次探测，
        // 免得把"被限流"误报成"选择器没匹配上"。
        let pageNote = "";
        if (hits === 0) {
          const diag = await evalIn(`(() => {
            const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
            return { len: text.length, head: text.slice(0, 300), html: document.documentElement.outerHTML.length };
          })()`).catch(() => null);
          if (diag) {
            pageNote = diag.head;
            const looksLikeChallenge = /captcha|robot|unusual traffic|rate limit|too many requests|人机验证|自动化流量|访问过于频繁|请稍候|just a moment/i.test(diag.head);
            if (looksLikeChallenge || (diag.len < 400 && diag.html < 120000)) blocked = true;
          }
        }

        const items = hits
          ? (await evalIn(`(() => {
              const nodes = [...document.querySelectorAll(${JSON.stringify(resultSelector)})];
              const TITLE = ${JSON.stringify(titleSelector || 'h3, h2, [class*="title"]')};
              const LINK = ${JSON.stringify(linkSelector || 'a[href]')};
              // Google 的 /url?q=... /url?url=... 跳转壳，剥掉拿真实地址
              const unwrap = (href) => {
                try {
                  const u = new URL(href);
                  if (/(^|\\.)google\\./.test(u.hostname) && /^\\/url$/.test(u.pathname)) {
                    const real = u.searchParams.get('q') || u.searchParams.get('url');
                    if (real && /^https?:/i.test(real)) return real;
                  }
                } catch { /* 保持原样 */ }
                return href;
              };
              const out = [];
              const seen = new Set();
              for (const node of nodes) {
                const titleEl = node.querySelector(TITLE);
                // 优先取"包着标题的 <a>"，其次 node 自身/后代/祖先。
                // 直接取 node.querySelector('a') 会抓到 favicon、"site:" 精炼链接之类的旁支。
                const a =
                  (titleEl && titleEl.closest(LINK)) ||
                  (titleEl && titleEl.querySelector(LINK)) ||
                  (node.matches?.(LINK) ? node : null) ||
                  node.querySelector(LINK) ||
                  node.closest(LINK);
                if (!a) continue;
                const raw = a.getAttribute('href') || '';
                if (!raw || raw.startsWith('#')) continue;
                const href = unwrap(a.href);          // a.href 已按页面 base 解析成绝对地址
                if (!/^https?:/i.test(href)) continue;
                const t = titleEl || a;
                const title = (t.textContent || '').replace(/\\s+/g, ' ').trim();
                const snippet = (node.textContent || '').replace(/\\s+/g, ' ').trim();
                if (seen.has(href)) continue;
                seen.add(href);
                out.push({ url: href, title, snippet });
                if (out.length >= ${limit}) break;
              }
              return out;
            })()`)) || []
          : [];

        return { items, title, finalUrl, blocked, waitedMs, hits, pageNote };
      } finally {
        // 移除这一轮的监听，避免长会话里累积
        const arr = client.listeners.get('Page.loadEventFired');
        if (arr) {
          const i = arr.indexOf(onLoad);
          if (i >= 0) arr.splice(i, 1);
        }
      }
    });

    // 无论成功失败都让队列继续（一道失败不阻塞后续搜索）
    this.queue = run.then(() => undefined, () => undefined);
    try {
      const out = await run;
      this.searchCount += 1;
      this.#touchIdle();
      return out;
    } catch (err) {
      // 实例可能已经坏了：拆掉，下一次重建
      if (this.client?.closed || !this.client) this.shutdown();
      this.#touchIdle();
      throw err;
    }
  }
}

// ── 实例池：按代理分组复用 ──────────────────────────────────────────

const instances = new Map();

function keyOf(cfg) {
  return [cfg.exe, cfg.proxy || '', cfg.headless === false ? 'headful' : 'headless', cfg.userAgent || '', cfg.profileDir || ''].join('|');
}

/**
 * 用一个（按代理分组的）常驻无头浏览器打开页面并取结果。
 * @param {object} cfg  { exe, proxy, headless, userAgent, idleMs, verbose, windowSize }
 */
export async function browserFetch(cfg, job) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error(`当前 Node ${process.version} 没有内置 WebSocket，无头抓取需要 Node ≥ 22`);
  }
  const exe = findBrowser(cfg.exe);
  if (!exe) throw new Error('没有找到 Chrome/Edge 可执行文件（可在设置里手动指定路径）');

  const key = keyOf({ ...cfg, exe });
  let inst = instances.get(key);
  if (!inst) {
    inst = new BrowserInstance({ ...cfg, exe });
    instances.set(key, inst);
  }
  try {
    return await inst.search(job);
  } catch (err) {
    // 启动类失败就把这个实例从池里摘掉，避免一直复用坏实例
    if (inst.client?.closed || !inst.child || inst.child.exitCode !== null) instances.delete(key);
    throw err;
  }
}

/** 关闭所有浏览器（插件卸载 / 进程退出时调用）。 */
export function closeAllBrowsers() {
  for (const inst of instances.values()) inst.shutdown();
  instances.clear();
}

/** 供诊断：当前有几个常驻实例、各自状态。 */
export function browserPoolStatus() {
  return [...instances.entries()].map(([key, inst]) => ({
    key,
    browser: inst.browserVersion || null,
    navigations: inst.navigations,
    searches: inst.searchCount,
    alive: Boolean(inst.child && inst.child.exitCode === null),
  }));
}
