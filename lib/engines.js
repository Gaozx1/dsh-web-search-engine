/**
 * 各搜索引擎的实现。每个引擎返回统一形状：
 *   { sources: WebSearchSource[], truncated: boolean }
 * 失败时抛 Error（可带 code）。
 *
 * 取数方式：
 *   - bing       ：抓 bing.com/search 结果页；解析不到时退回 Bing 的 RSS 结果流。
 *   - duckduckgo ：抓 html.duckduckgo.com（结果链接是 uddg= 跳转，需解码）。
 *   - mojeek     ：抓 mojeek.com 结果页（独立索引；对部分出口 IP 会要求验证码）。
 *   - google     ：优先用官方 Programmable Search JSON API（需要 apiKey + cx）；
 *                  没有凭据时尝试抓结果页——Google 对非浏览器客户端普遍返回
 *                  "需要 JavaScript"的占位页，此时给出可操作的报错。
 *   - brave      ：官方 Brave Search API（需要 apiKey）。
 *   - *-web      ：用常驻无头浏览器（lib/browser.js）取数，见下方 BROWSER_ENGINE_SPECS。
 *                  给那些"普通 HTTP 拿不到、真实浏览器能拿到"的引擎用：
 *                  brave-web（无需 key，推荐）、ddg-web、google-web。
 */

import { clampSnippet, cleanText, decodeEntities, dedupeSources, normalizeResultUrl, sourceKey } from "./text.js";
import { browserDiagnostics } from "./browser.js";

const BROWSER_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function browserHeaders(language) {
  return { ...BROWSER_HEADERS, "accept-language": language };
}

/** 把 http 层的结果包成"非 2xx 即报错"，并把跳转链带上便于排错。 */
function assertOk(response, engine, url) {
  if (response.status >= 200 && response.status < 300) return response;
  const hint =
    response.status === 429
      ? "（触发限流，稍后重试或更换引擎）"
      : response.status === 403
        ? "（被拒绝：可能是出口 IP 被判定为自动化流量，需要代理或凭据）"
        : response.status >= 300 && response.status < 400
          ? "（重定向未被跟随，可能是出口地区跳转异常）"
          : "";
  const trail =
    Array.isArray(response.redirects) && response.redirects.length > 0
      ? `\n跳转链：\n${response.redirects.join("\n")}\n最终：${response.finalUrl}`
      : "";
  throw new Error(`${engine} 返回 HTTP ${response.status}${hint}：${url}${trail}`);
}

/** 识别"被挡下来了"的页面，给出比"没解析出结果"更有用的错误。 */
function assertNotBlocked(html, engine) {
  const head = html.slice(0, 4000);
  if (/<title[^>]*>\s*Captcha\s*<\/title>/i.test(head) || /captcha/i.test(head) && html.length < 20000) {
    throw new Error(`${engine} 要求人机验证（该出口 IP 被判定为自动化流量），换代理或稍后再试`);
  }
  if (/automated queries|unusual traffic|not a robot/i.test(head)) {
    throw new Error(`${engine} 判定为自动化流量并拒绝服务，换代理或稍后再试`);
  }
}

// ── Bing ────────────────────────────────────────────────────────────────────

function bingSearchUrl(baseUrl, query, options, format) {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options.requestCount));
  url.searchParams.set("first", "1");
  if (format !== undefined) url.searchParams.set("format", format);
  if (options.region.length > 0) url.searchParams.set("mkt", options.region);
  if (options.setLang.length > 0) url.searchParams.set("setlang", options.setLang);
  url.searchParams.set("safeSearch", options.safeSearch ? "moderate" : "off");
  return url.toString();
}

/** 解析 Bing 结果页：每条结果是 <li class="b_algo">，标题在 h2>a，摘要在第一个 p。 */
export function parseBingHtml(html, baseUrl, limit) {
  const blocks = html.split(/(?=<li[^>]*class="[^"]*\bb_algo\b)/i).slice(1);
  const sources = [];
  for (const rawBlock of blocks) {
    if (sources.length >= limit) break;
    const block = rawBlock.slice(0, 8000);
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (anchor === null) continue;
    const url = normalizeResultUrl(anchor[1], baseUrl);
    if (url === undefined) continue;
    const title = cleanText(anchor[2]);
    // 无标题的块是词典/天气之类的卡片，不是自然结果——放进去会污染整份列表。
    if (title.length === 0) continue;
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const dateMatch = block.match(/<span[^>]*class="[^"]*news_dt[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    sources.push({
      url,
      title,
      snippet: snippetMatch === null ? "" : clampSnippet(snippetMatch[1]),
      publishedAt: dateMatch === null ? "" : cleanText(dateMatch[1]),
    });
  }
  return dedupeSources(sources).slice(0, limit);
}

/** 解析 Bing RSS：结构稳定，作为结果页解析失败时的退路。 */
export function parseBingRss(xml, baseUrl, limit) {
  const stripCdata = (value) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const pick = (item, tag) => {
    const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    return match === null ? "" : stripCdata(match[1]);
  };
  const sources = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (sources.length >= limit) break;
    const item = match[1];
    const url = normalizeResultUrl(decodeEntities(pick(item, "link")), baseUrl);
    if (url === undefined) continue;
    sources.push({
      url,
      title: cleanText(pick(item, "title")),
      snippet: clampSnippet(pick(item, "description")),
      publishedAt: cleanText(pick(item, "pubDate")),
    });
  }
  return dedupeSources(sources).slice(0, limit);
}

export async function searchBing(query, options, request, signal) {
  const baseUrl = options.bing.baseUrl;
  const pageUrl = bingSearchUrl(baseUrl, query, options);
  const page = assertOk(
    await request(pageUrl, { headers: browserHeaders(options.language), signal, timeoutMs: options.timeoutMs }),
    "Bing",
    pageUrl,
  );
  assertNotBlocked(page.text, "Bing");
  let sources = parseBingHtml(page.text, baseUrl, options.maxResults);
  if (sources.length === 0 && options.bing.rss) {
    const rssUrl = bingSearchUrl(baseUrl, query, options, "rss");
    const rss = await request(rssUrl, { headers: browserHeaders(options.language), signal, timeoutMs: options.timeoutMs });
    if (rss.status >= 200 && rss.status < 300) sources = parseBingRss(rss.text, baseUrl, options.maxResults);
  }
  if (sources.length === 0) {
    throw new Error(`Bing 未返回可解析的结果（可能是查询无结果，或结果页结构变化）：${pageUrl}`);
  }
  return { sources, truncated: false };
}

// ── DuckDuckGo ──────────────────────────────────────────────────────────────

function duckDuckGoUrl(baseUrl, query, options) {
  const url = new URL("/html/", baseUrl);
  url.searchParams.set("q", query);
  if (options.duckduckgo.region.length > 0) url.searchParams.set("kl", options.duckduckgo.region);
  url.searchParams.set("kp", options.safeSearch ? "1" : "-2");
  return url.toString();
}

/** 解开 DuckDuckGo 的跳转包装：//duckduckgo.com/l/?uddg=<encoded> */
function unwrapDuckDuckGo(raw) {
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target !== null && target.length > 0 ? target : raw;
  } catch {
    return raw;
  }
}

/** 解析 DuckDuckGo HTML 版：结果在 a.result__a，摘要在 a.result__snippet。 */
export function parseDuckDuckGoHtml(html, baseUrl, limit) {
  const anchorPattern = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(anchorPattern)];
  const sources = [];
  for (let index = 0; index < matches.length && sources.length < limit; index += 1) {
    const match = matches[index];
    const url = normalizeResultUrl(unwrapDuckDuckGo(decodeEntities(match[1])), baseUrl);
    if (url === undefined) continue;
    const blockEnd = index + 1 < matches.length ? matches[index + 1].index : html.length;
    const block = html.slice(match.index, blockEnd);
    const snippetMatch =
      block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    sources.push({
      url,
      title: cleanText(match[2]),
      snippet: snippetMatch === null ? "" : clampSnippet(snippetMatch[1]),
    });
  }
  return dedupeSources(sources).slice(0, limit);
}

export async function searchDuckDuckGo(query, options, request, signal) {
  const baseUrl = options.duckduckgo.baseUrl;
  const url = duckDuckGoUrl(baseUrl, query, options);
  const page = assertOk(
    await request(url, { headers: browserHeaders(options.language), signal, timeoutMs: options.timeoutMs }),
    "DuckDuckGo",
    url,
  );
  assertNotBlocked(page.text, "DuckDuckGo");
  const sources = parseDuckDuckGoHtml(page.text, baseUrl, options.maxResults);
  if (sources.length === 0) throw new Error(`DuckDuckGo 未返回可解析的结果：${url}`);
  return { sources, truncated: false };
}

// ── Mojeek ──────────────────────────────────────────────────────────────────

function mojeekUrl(baseUrl, query, options) {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("t", String(Math.max(options.maxResults, 10)));
  if (options.safeSearch) url.searchParams.set("safe", "1");
  return url.toString();
}

/**
 * 解析 Mojeek 结果页：结果在 ul.results-standard 的 <li> 里，
 * 标题是 <h2><a href>，摘要在 <p class="s">。
 *
 * 注意：Mojeek 对部分出口 IP（含本机所在的网络）直接返回验证码页，
 * 所以这段解析在本机未能实测；解析器对多种写法做了兜底。
 */
export function parseMojeekHtml(html, baseUrl, limit) {
  const list = html.match(/<ul[^>]+class="[^"]*results-standard[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  const scope = list === null ? html : list[1];
  const sources = [];
  for (const rawBlock of scope.split(/(?=<li\b)/i).slice(1)) {
    if (sources.length >= limit) break;
    const anchor =
      rawBlock.match(/<h2[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
      rawBlock.match(/<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (anchor === null) continue;
    const url = normalizeResultUrl(decodeEntities(anchor[1]), baseUrl);
    if (url === undefined) continue;
    const snippetMatch =
      rawBlock.match(/<p[^>]+class="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
      rawBlock.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    sources.push({
      url,
      title: cleanText(anchor[2]),
      snippet: snippetMatch === null ? "" : clampSnippet(snippetMatch[1]),
    });
  }
  return dedupeSources(sources).slice(0, limit);
}

export async function searchMojeek(query, options, request, signal) {
  const baseUrl = options.mojeek.baseUrl;
  const url = mojeekUrl(baseUrl, query, options);
  const page = assertOk(
    await request(url, { headers: browserHeaders(options.language), signal, timeoutMs: options.timeoutMs }),
    "Mojeek",
    url,
  );
  assertNotBlocked(page.text, "Mojeek");
  const sources = parseMojeekHtml(page.text, baseUrl, options.maxResults);
  if (sources.length === 0) throw new Error(`Mojeek 未返回可解析的结果：${url}`);
  return { sources, truncated: false };
}

// ── Google ──────────────────────────────────────────────────────────────────

/** 官方 Programmable Search JSON API。需要 apiKey + cx。 */
export async function searchGoogleApi(query, options, request, signal) {
  const url = new URL(options.google.baseUrl);
  url.searchParams.set("key", options.google.apiKey);
  url.searchParams.set("cx", options.google.cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(options.requestCount, 10)));
  if (options.language.length > 0) url.searchParams.set("hl", options.language);
  url.searchParams.set("safe", options.safeSearch ? "active" : "off");

  const response = assertOk(
    await request(url.toString(), { headers: { accept: "application/json" }, signal, timeoutMs: options.timeoutMs }),
    "Google Custom Search",
    url.toString(),
  );
  let body;
  try {
    body = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`Google Custom Search 返回了非 JSON 响应：${response.text.slice(0, 200)}`, { cause: error });
  }
  if (body.error !== undefined) {
    throw new Error(`Google Custom Search 报错：${body.error.message ?? JSON.stringify(body.error)}`);
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const sources = dedupeSources(
    items.map((item) => ({
      url: normalizeResultUrl(item.link, options.google.webBaseUrl),
      title: cleanText(item.title ?? ""),
      snippet: clampSnippet(item.snippet ?? ""),
    })),
  ).slice(0, options.maxResults);
  return { sources, truncated: false };
}

/** 抓 Google 结果页 HTML（无凭据时的退路）。 */
export function parseGoogleHtml(html, baseUrl, limit) {
  const sources = [];
  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    if (sources.length >= limit) break;
    let raw = decodeEntities(match[1]);
    if (raw.startsWith("/url?")) {
      const value = new URLSearchParams(raw.slice(5)).get("q");
      if (value === null) continue;
      raw = value;
    }
    const url = normalizeResultUrl(raw, baseUrl);
    if (url === undefined) continue;
    const title = cleanText(match[2]);
    if (title.length === 0) continue;
    const tail = html.slice(match.index + match[0].length, match.index + match[0].length + 3000);
    const snippetMatch =
      tail.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ??
      tail.match(/<span[^>]*class="[^"]*\bst\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    sources.push({ url, title, snippet: snippetMatch === null ? "" : clampSnippet(snippetMatch[1]) });
  }
  return dedupeSources(sources).slice(0, limit);
}

/** Google 对非浏览器客户端返回占位页时的可操作提示。 */
const GOOGLE_JS_GATE_HINT =
  "Google 只返回了“需要 JavaScript”的占位页，服务端抓取拿不到结果。" +
  "请改用官方 Programmable Search：在 https://programmablesearchengine.google.com/ 建一个搜索引擎拿到 cx，" +
  "再到 Google Cloud 开通 Custom Search API 拿到 API key，然后填进本插件的 google.apiKey / google.cx。" +
  "（www.googleapis.com 在部分网络下需要走代理，可在本插件 proxy 里填本地代理，例如 http://127.0.0.1:7890。）";

export async function searchGoogleHtml(query, options, request, signal) {
  const url = new URL("/search", options.google.webBaseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(options.requestCount, 20)));
  if (options.language.length > 0) url.searchParams.set("hl", options.language);
  const response = assertOk(
    await request(url.toString(), { headers: browserHeaders(options.language), signal, timeoutMs: options.timeoutMs }),
    "Google",
    url.toString(),
  );
  // 先判占位页：它里面也有 <a>，先解析会得到"重试/帮助"这类噪声结果。
  if (/enablejs|httpservice\/retry/i.test(response.text)) throw new Error(GOOGLE_JS_GATE_HINT);
  const sources = parseGoogleHtml(response.text, options.google.webBaseUrl, options.maxResults);
  if (sources.length > 0) return { sources, truncated: false };
  throw new Error(`Google 结果页未解析出任何结果（可能被限流或页面结构变化）：${url.toString()}`);
}

/** 是否配置了 Google 的凭据。 */
export function googleReady(options) {
  return options.google.apiKey.length > 0 && options.google.cx.length > 0;
}

// ── Brave Search API ────────────────────────────────────────────────────────

export async function searchBrave(query, options, request, signal) {
  if (options.brave.apiKey.length === 0) throw new Error("Brave 需要 apiKey（Brave Search API）");
  const url = new URL(options.brave.baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(options.maxResults, 1), 20)));
  if (options.language.length > 0) url.searchParams.set("search_lang", options.language.split("-")[0]);
  url.searchParams.set("safesearch", options.safeSearch ? "moderate" : "off");

  const response = assertOk(
    await request(url.toString(), {
      headers: {
        accept: "application/json",
        "x-subscription-token": options.brave.apiKey,
        ...(options.language.length > 0 ? { "accept-language": options.language } : {}),
      },
      signal,
      timeoutMs: options.timeoutMs,
    }),
    "Brave",
    url.toString(),
  );
  let body;
  try {
    body = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`Brave 返回了非 JSON 响应：${response.text.slice(0, 200)}`, { cause: error });
  }
  const items = Array.isArray(body?.web?.results) ? body.web.results : [];
  const sources = dedupeSources(
    items.map((item) => ({
      url: normalizeResultUrl(item.url, options.brave.baseUrl),
      title: cleanText(item.title ?? ""),
      snippet: clampSnippet(item.description ?? ""),
      publishedAt: typeof item.age === "string" ? item.age : "",
    })),
  ).slice(0, options.maxResults);
  return { sources, truncated: false };
}

/** 是否配置了 Brave 的凭据。 */
export function braveReady(options) {
  return options.brave.apiKey.length > 0;
}

// ── 无头浏览器引擎 ──────────────────────────────────────────────────────────
//
// 有些引擎对普通 HTTP 客户端不给结果（403/429/JavaScript 门），
// 但真实浏览器能正常出结果。这些引擎交给 lib/browser.js 的常驻浏览器去取。
//
// 实测（Windows + Chrome 153 + 本地代理）：
//   brave-web  ✅ 20 条，1.5~3.5s，无需 key，连续多次不限流 —— 最划算
//   ddg-web    ✅ 10 条，2.4~9s，比 html.duckduckgo.com 稳定
//   google-web ⚠️ 只有"有头"模式能过（无头必跳 /sorry/index），且连搜几次就被限流
//
// 每个引擎声明：搜索 URL 怎么拼 → 结果容器选择器 → 标题选择器。

const BROWSER_ENGINE_SPECS = {
  "brave-web": {
    label: "Brave（浏览器）",
    build(query, options) {
      const url = new URL("/search", "https://search.brave.com");
      url.searchParams.set("q", query);
      url.searchParams.set("source", "web");
      if (options.safeSearch) url.searchParams.set("safesearch", "moderate");
      return url.toString();
    },
    resultSelector: 'div.snippet[data-type="web"]',
    titleSelector: '[class*="title"]',
    linkSelector: "a[href]",
  },
  "ddg-web": {
    label: "DuckDuckGo（浏览器）",
    build(query, options) {
      const url = new URL("/", "https://duckduckgo.com");
      url.searchParams.set("q", query);
      url.searchParams.set("ia", "web");
      if (options.safeSearch) url.searchParams.set("kp", "1");
      if (options.language.length > 0) url.searchParams.set("kl", options.language.startsWith("zh") ? "cn-zh" : "us-en");
      return url.toString();
    },
    resultSelector: 'article[data-testid="result"]',
    titleSelector: '[data-testid="result-title-a"], h2',
    linkSelector: 'a[data-testid="result-title-a"], a[href]',
  },
  "google-web": {
    label: "Google（浏览器）",
    build(query, options) {
      const url = new URL("/search", "https://www.google.com");
      url.searchParams.set("q", query);
      url.searchParams.set("num", String(Math.min(Math.max(options.maxResults, 1), 20)));
      if (options.language.length > 0) url.searchParams.set("hl", options.language.split("-")[0]);
      if (options.safeSearch) url.searchParams.set("safe", "active");
      return url.toString();
    },
    // Google 是 <a><h3>标题</h3></a>：容器选 h3，靠 closest('a') 找到链接。
    resultSelector: 'div#search a h3, div#rso a h3',
    titleSelector: "h3",
    linkSelector: "a[href]",
  },
};

/** 支持"浏览器取数"的引擎 id。 */
export const BROWSER_ENGINE_IDS = Object.keys(BROWSER_ENGINE_SPECS);

function browserOptions(options) {
  const browser = options.browser ?? {};
  return {
    exe: browser.exe || "",
    proxy: browser.proxy !== undefined && browser.proxy !== null && browser.proxy.length > 0 ? browser.proxy : options.proxy,
    headless: browser.headless !== false,
    idleMs: browser.idleMs ?? 120000,
    profileDir: browser.profileDir || "",
    verbose: browser.verbose === true,
  };
}

async function searchWithBrowser(engineId, query, options) {
  const spec = BROWSER_ENGINE_SPECS[engineId];
  if (!spec) throw new Error(`未知的浏览器引擎 "${engineId}"`);
  const browser = options.browser ?? {};
  if (browser.enabled !== true) {
    throw new Error(`${spec.label} 需要开启 browser.enabled`);
  }
  // Google 在有头模式下才有机会过掉它的自动化检测；无头基本必被拦。
  const headless = engineId === "google-web" && browser.headlessForGoogle === true ? false : browser.headless !== false;

  const { browserFetch } = await import("./browser.js");
  const url = spec.build(query, options);
  let result;
  try {
    result = await browserFetch({ ...browserOptions(options), headless }, {
      url,
      resultSelector: spec.resultSelector,
      titleSelector: spec.titleSelector,
      linkSelector: spec.linkSelector,
      limit: options.maxResults,
      waitMs: browser.waitMs ?? 8000,
    });
  } catch (error) {
    throw new Error(`${spec.label} 取数失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (result.blocked) {
    throw new Error(
      `${spec.label} 被目标站点拦截（人机验证 / 限流 / 自动化流量判定）` +
        (result.pageNote ? `：${result.pageNote.slice(0, 120)}` : "") +
        (engineId === "google-web"
          ? "。Google 只对「有头」浏览器放行，且连续搜索会被限流；可打开 browser.headlessForGoogle 或改用 brave-web。"
          : "。换代理、稍后重试，或先换成别的引擎。"),
    );
  }
  if (result.items.length === 0) {
    throw new Error(
      `${spec.label} 没有解析出结果（页面已打开但没有匹配的结果容器；可能是站点改版，需要调整选择器）`,
    );
  }

  const sources = dedupeSources(
    result.items.map((item) => ({
      url: normalizeResultUrl(item.url, url),
      title: cleanText(item.title ?? ""),
      snippet: clampSnippet(item.snippet ?? ""),
      publishedAt: "",
    })),
  ).slice(0, options.maxResults);
  return { sources, truncated: result.hits > sources.length };
}

// ── 调度 ────────────────────────────────────────────────────────────────────

/**
 * 按配置派发到具体引擎。
 * @param {string} engineId
 * @returns {Promise<{sources: Array, truncated: boolean}>}
 */
export async function runEngine(engineId, query, options, request, signal) {
  if (BROWSER_ENGINE_IDS.includes(engineId)) {
    // 浏览器取数不受 HTTP requester 控制（自己起浏览器），但要尊重调用方的取消/总预算：
    // 超时就先返回失败，浏览器那一轮仍在后台跑完（下次搜索正好复用）。
    if (signal?.aborted === true) throw new Error("搜索已取消");
    const pending = searchWithBrowser(engineId, query, options);
    if (signal === undefined || signal === null) return await pending;
    let onAbort;
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          onAbort = () => reject(new Error("搜索预算用尽"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      // 后台那轮失败不要变成未处理的 rejection
      pending.catch(() => {});
    }
  }
  switch (engineId) {
    case "bing":
      return await searchBing(query, options, request, signal);
    case "duckduckgo":
      return await searchDuckDuckGo(query, options, request, signal);
    case "mojeek":
      return await searchMojeek(query, options, request, signal);
    case "google":
      return googleReady(options)
        ? await searchGoogleApi(query, options, request, signal)
        : await searchGoogleHtml(query, options, request, signal);
    case "brave":
      return await searchBrave(query, options, request, signal);
    default:
      throw new Error(
        `未知的搜索引擎 "${engineId}"（可用：bing、duckduckgo、mojeek、google、brave、${BROWSER_ENGINE_IDS.join("、")}）`,
      );
  }
}

/**
 * 某个引擎是否"值得调用"：需要凭据但没配的引擎直接跳过，
 * 免得白等一次连接超时。
 * @returns {{ready: boolean, reason?: string}}
 */
export function engineReadiness(engineId, options) {
  if (BROWSER_ENGINE_IDS.includes(engineId)) {
    if (options.browser?.enabled !== true) {
      return { ready: false, reason: `浏览器取数未开启（设置里打开「浏览器取数」后才能用 ${engineId}）` };
    }
    const diag = browserDiagnostics(options.browser?.exe || "");
    if (diag.ready === false) return { ready: false, reason: diag.reason || "找不到可用的浏览器" };
    return { ready: true };
  }
  if (engineId === "google" && googleReady(options) === false && options.google.allowHtmlFallback !== true) {
    return { ready: false, reason: "未配置 google.apiKey / google.cx（抓页路径已被 Google 的 JS 门挡住）" };
  }
  if (engineId === "brave" && braveReady(options) === false) {
    return { ready: false, reason: "未配置 brave.apiKey" };
  }
  return { ready: true };
}

/**
 * 把多个引擎的结果按"名次轮转"混成一份列表：每个引擎的第 1 名、
 * 再每个引擎的第 2 名……这样排在前面的结果来自不同引擎，同时按 URL 去重。
 * @param {Array<Array>} lists - 每个引擎的结果（按名次排好）
 * @param {number} cap - 最多返回多少条
 */
export function interleaveSources(lists, cap) {
  const seen = new Set();
  const out = [];
  const depth = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let rank = 0; rank < depth; rank += 1) {
    for (const list of lists) {
      const source = list[rank];
      // 用归一化后的键去重：不同引擎对同一页面常给不同写法（带不带 www、尾斜杠）。
      if (source === undefined) continue;
      const key = sourceKey(source.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(source);
      if (out.length >= cap) return out;
    }
  }
  return out;
}
