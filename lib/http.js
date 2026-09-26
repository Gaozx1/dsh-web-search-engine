/**
 * HTTP 取数层：用 node:http / node:https 自己发请求，并自行跟随重定向。
 *
 * 为什么不用 globalThis.fetch：实测在本机 DSH 宿主进程里，fetch 返回的响应
 * **头部为空、正文是乱码**（同一个 URL 在子进程里完全正常），于是
 * `redirect: "follow"` 也跟不动跳转——Bing 的 www.bing.com → cn.bing.com
 * 302 会被当成最终响应。根因是 @deepseek-ai/dsh-http-proxy 把一份 userland
 * undici 的 Agent 写进了 Node 的全局 dispatcher 槽位，与 Node 内置 fetch
 * 自带的 undici 版本不一致（该包 README 自己把这条隐式耦合列为已知风险）。
 * 走 node:https 就完全绕开了它。
 *
 * 为什么不用 undici 的 ProxyAgent：本插件刻意保持"零依赖"——安装时不需要访问
 * npm registry。代理隧道只用 node:http / node:tls / node:zlib 实现。
 */

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";

const DEFAULT_TIMEOUT_MS = 15000;
/** 单次请求最多跟随多少次重定向。 */
const MAX_REDIRECTS = 5;

function abortError() {
  return Object.assign(new Error("搜索已取消"), { code: "WEB_ABORTED" });
}

/** 把底层网络错误整理成一句可读的话。 */
function describeNetworkError(error, url) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  const detail =
    code === undefined ? error?.message ?? String(error) : `${code}${cause?.message ? ` (${cause.message})` : ""}`;
  return `请求 ${url} 失败：${detail}`;
}

/** 按响应头解压正文（node:https 不会自动解压）。 */
function decompress(buffer, encoding) {
  try {
    if (encoding.includes("gzip")) return zlib.gunzipSync(buffer);
    if (encoding.includes("deflate")) return zlib.inflateSync(buffer);
    if (encoding.includes("br")) return zlib.brotliDecompressSync(buffer);
    return buffer;
  } catch (error) {
    throw new Error(`响应解压失败（content-encoding: ${encoding || "无"}）：${error.message}`, { cause: error });
  }
}

/** 3xx + Location 才算可跟随的重定向。 */
function redirectTarget(status, location, current) {
  if (status < 300 || status >= 400) return undefined;
  if (typeof location !== "string" || location.length === 0) return undefined;
  try {
    const next = new URL(location, current).toString();
    return next === current ? undefined : next;
  } catch {
    return undefined;
  }
}

/** 把 Node 的 IncomingHttpHeaders 归一成小写字符串表。 */
function collectHeaders(raw) {
  const collected = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") collected[key.toLowerCase()] = value;
    else if (Array.isArray(value)) collected[key.toLowerCase()] = value.join(", ");
  }
  return collected;
}

/**
 * 用 node:http / node:https 直接请求一次（不跟随重定向）。
 *
 * 这里刻意不用 globalThis.fetch：在宿主进程里实测 fetch 返回的响应头部为空、
 * 正文是乱码（同一个 URL 在子进程里完全正常），无法用于抓取结果页。
 * node:https 走自己的连接与解析，不受 undici 全局 dispatcher 影响。
 *
 * @returns {Promise<{status:number, headers:Record<string,string>, readText:()=>Promise<string>, discard:()=>Promise<void>}>}
 */
function directOnce(url, { headers, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      request.destroy(abortError());
    };
    if (signal?.aborted === true) return finish(abortError());
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const request = transport.request(
      target,
      {
        method: "GET",
        headers: { "accept-encoding": "gzip, deflate, br", ...headers },
        // 每次请求单独建连：不复用可能已失效的长连接。
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", (error) => finish(describeError(error, url)));
        response.on("end", () => {
          try {
            const headers = collectHeaders(response.headers);
            const body = decompress(Buffer.concat(chunks), String(headers["content-encoding"] ?? "").toLowerCase());
            finish(undefined, {
              status: response.statusCode ?? 0,
              headers,
              readText: async () => body.toString("utf8"),
              discard: async () => {},
            });
          } catch (error) {
            finish(error);
          }
        });
      },
    );
    function describeError(error, target) {
      return new Error(describeNetworkError(error, target), { cause: error });
    }
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    request.once("error", (error) => finish(describeError(error, url)));
    request.end();
  });
}

/**
 * 解码分块传输编码（chunked），并以"是否读到 0 号结束块"判定正文完整性。
 * 隧道尾部可能混入 TLS 噪声，所以不能用"结束块必须在缓冲区末尾"来判断。
 */
function readChunked(buffer) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return { complete: false };
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("latin1").split(";")[0], 16);
    if (Number.isFinite(size) === false) return { complete: false };
    if (size === 0) return { complete: true, body: Buffer.concat(parts) };
    if (lineEnd + 2 + size > buffer.length) return { complete: false };
    parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
}

/** 按响应头解压正文（隧道那条路径不会自动解压）。 */
function decompressBody(buffer, encoding) {
  if (encoding.includes("gzip")) return zlib.gunzipSync(buffer);
  if (encoding.includes("deflate")) return zlib.inflateSync(buffer);
  if (encoding.includes("br")) return zlib.brotliDecompressSync(buffer);
  return buffer;
}

/**
 * 解析一个 HTTP/1.1 响应；正文不完整时抛错（用于把"隧道尾部的 TLS 噪声"
 * 与"真正截断的响应"区分开）。
 */
function parseResponse(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error("响应头不完整");
  const head = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = head.split("\r\n");
  const status = Number((lines[0].match(/^HTTP\/\d\.\d (\d{3})/) ?? [])[1]);
  if (Number.isFinite(status) === false) throw new Error("响应状态行无法解析");
  const headers = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  let body = buffer.subarray(headerEnd + 4);
  const chunked = (headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked");
  if (chunked) {
    const decoded = readChunked(body);
    if (decoded.complete === false) throw new Error("分块正文未结束");
    body = decoded.body;
  } else if (headers["content-length"] !== undefined) {
    const expected = Number(headers["content-length"]);
    if (Number.isFinite(expected) && body.length < expected) throw new Error("正文被截断");
  }
  return { status, headers, text: decompressBody(body, (headers["content-encoding"] ?? "").toLowerCase()).toString("utf8") };
}

/**
 * 经 HTTP 代理请求一次（仅支持 https 目标，CONNECT 隧道，不跟随重定向）。
 * @returns {Promise<{status:number, headers:Record<string,string>, readText:()=>Promise<string>, discard:()=>Promise<void>}>}
 */
function proxiedOnce(url, proxyUrl, { headers, signal, timeoutMs }) {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  if (target.protocol !== "https:") throw new Error(`proxy 仅支持 https 目标，收到 ${target.protocol}`);
  const targetPort = Number(target.port || 443);

  return new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error(`请求 ${url} 超时（${timeoutMs}ms）`)), timeoutMs);
    const onAbort = () => finish(abortError());
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    }
    /** 隧道尾部常见"TLS 记录噪声"：只要响应本身完整就当作正常结束。 */
    function finishFromBuffer(fallbackError) {
      try {
        const parsed = parseResponse(received);
        finish(undefined, {
          status: parsed.status,
          headers: parsed.headers,
          readText: async () => parsed.text,
          discard: async () => {},
        });
      } catch {
        finish(fallbackError);
      }
    }
    if (signal?.aborted === true) return finish(abortError());
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const connect = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: {
        host: `${target.hostname}:${targetPort}`,
        ...(proxy.username
          ? {
              "proxy-authorization": `Basic ${Buffer.from(
                `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
              ).toString("base64")}`,
            }
          : {}),
      },
    });
    connect.once("error", (error) =>
      finish(new Error(`连接代理 ${proxyUrl} 失败：${error.message}`, { cause: error })),
    );
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return finish(new Error(`代理 CONNECT 返回 HTTP ${response.statusCode}`));
      }
      // 代理可能已经转发了隧道里的前几个字节，必须先还回 socket 再做 TLS 握手。
      if (head !== undefined && head.length > 0) socket.unshift(head);
      const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ["http/1.1"] });
      secure.once("error", (error) =>
        finishFromBuffer(new Error(`代理隧道 TLS 失败：${error.message}`, { cause: error })),
      );
      secure.once("secureConnect", () => {
        secure.write(
          [
            `GET ${target.pathname}${target.search} HTTP/1.1`,
            `Host: ${target.host}`,
            "Accept-Encoding: gzip, deflate, br",
            "Connection: close",
            ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
            "",
            "",
          ].join("\r\n"),
        );
      });
      secure.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
      });
      secure.once("end", () => finishFromBuffer(new Error("代理隧道提前关闭")));
    });
    connect.end();
  });
}

/** 反复跟随重定向，直到非 3xx 响应；把跳转链带在结果里便于排错。 */
async function followRedirects(once, url, options) {
  let current = url;
  const trail = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await once(current, options);
    const next = redirectTarget(response.status, response.headers.location, current);
    if (next === undefined) return { ...response, finalUrl: current, redirects: trail };
    trail.push(`${response.status} → ${current}`);
    await response.discard();
    current = next;
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次：${[...trail, current].join("\n")}`);
}

/**
 * 造一个取数函数：显式 proxy 走隧道，否则直连。两种方式都自行跟随重定向。
 *
 * `proxy` 留空时会退回进程环境里的 https_proxy / HTTPS_PROXY / all_proxy / ALL_PROXY
 * （DSH 启动器会把解析后的代理策略发布到这些变量上），这样"导出 HTTPS_PROXY 即生效"
 * 的既有行为对插件仍然成立。
 *
 * @param {{proxy?: string}} options
 * @returns {(url: string, options?: {headers?: Record<string,string>, signal?: AbortSignal, timeoutMs?: number}) => Promise<{status:number, headers:Record<string,string>, text:string, finalUrl:string, redirects:string[]}>}
 */
export function createRequester({ proxy = "" } = {}) {
  const configured = typeof proxy === "string" ? proxy.trim() : "";
  const trimmed = configured.length > 0 ? configured : environmentProxy();
  let once;
  if (trimmed.length === 0) {
    once = directOnce;
  } else {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`proxy 不是合法 URL：${trimmed}（示例：http://127.0.0.1:7890）`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`proxy 仅支持 http:// 或 https:// 开头的地址，收到 ${trimmed}`);
    }
    once = (url, options) => proxiedOnce(url, trimmed, options);
  }
  return async (url, options = {}) => {
    const response = await followRedirects(once, url, { timeoutMs: DEFAULT_TIMEOUT_MS, ...options });
    const text = await response.readText();
    return {
      status: response.status,
      headers: response.headers,
      text,
      finalUrl: response.finalUrl,
      redirects: response.redirects,
    };
  };
}

/** 进程环境里的代理（大小写都认，空值视为未设置）。 */
function environmentProxy() {
  for (const name of ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "http_proxy", "HTTP_PROXY"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}
