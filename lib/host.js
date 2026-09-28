/**
 * dsh-web-search-bing-google（Host 半边）— 用 Bing / Google 替代 DSH 默认的搜索。
 *
 * 它向 `ctx.web` 注册一个 WebSearchProvider（id: `web-search-multi`），
 * `web_search` 工具因此按配置调用搜索引擎：第一个出结果即返回，全部失败才汇总报错。
 *
 * 装配方式见同目录 cordis.patch.yml：插入本插件行，并把 `web` 行的
 * `searchProvider` 指向 `web-search-multi`。
 *
 * 配置既可以在 cordis.patch.yml 里写，也可以在 Web 的「设置 → 搜索」里改
 * （本包声明了 Config schema，`settings` 服务据此生成表单）。
 */

import z from "@deepseek-ai/schemastery";

import { engineReadiness, interleaveSources, runEngine } from "./engines.js";
import { createRequester } from "./http.js";
import { browserDiagnostics, browserPoolStatus, closeAllBrowsers, findBrowser } from "./browser.js";

/** Cordis 插件名（用于加载器诊断）。 */
const name = "web-search-multi";

/** 需要 web 服务就绪才能注册 provider。 */
const inject = ["web"];

/** 注册到 `ctx.web` 的 provider id，必须与 cordis.patch.yml 里的 searchProvider 一致。 */
const PROVIDER_ID = "web-search-multi";

/** 支持的引擎 id。 */
const KNOWN_ENGINES = ["bing", "duckduckgo", "mojeek", "google", "brave", "brave-web", "ddg-web", "google-web"];

/** 两种结果组合方式。 */
const KNOWN_MODES = ["merge", "fallback"];

/**
 * 配置 schema。两个作用：
 *  1) 加载器在激活时校验 `cordis.patch.yml` 里写的配置；
 *  2) `settings` 服务把 schema 投影成表单，设置页因此能读写这些字段。
 *
 * 每个字段都标了 `.volatile()`：`settings` 服务只把 volatile 字段投影成可编辑表单，
 * 而本插件的配置确实是"改了立刻生效、不需要重挂插件"的（每次搜索重新读配置）。
 * 带 `role('secret')` 的字段不会被读回，只报告"是否已配置"。
 */
const Config = z.object({
  mode: z
    .string()
    .default("merge")
    .volatile()
    .description("结果组合方式：merge=并行问所有引擎并混合结果；fallback=按顺序试，第一个出结果就用。"),
  preferOfficial: z
    .boolean()
    .default(false)
    .volatile()
    .description("优先使用官方 DeepSeek 搜索；它不可用时自动回退到下面的引擎。"),
  officialProviderId: z
    .string()
    .default("deepseek-official")
    .volatile()
    .description("官方搜索 provider 的 id（ctx.web 注册表里的键）。"),
  engines: z
    .array(z.string())
    .default(["bing", "duckduckgo", "google"])
    .volatile()
    .description("启用的引擎及顺序：bing、duckduckgo、mojeek、google、brave、brave-web、ddg-web、google-web。"),
  maxResults: z
    .number()
    .step(1)
    .min(1)
    .max(20)
    .default(6)
    .volatile()
    .description("每个引擎取多少条（混合后总条数会更多）。"),
  timeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .max(120000)
    .default(12000)
    .volatile()
    .description("单次搜索的总预算（毫秒）；混合模式下到点就用已经拿到的结果。"),
  language: z
    .string()
    .default("zh-CN")
    .volatile()
    .description("Accept-Language，同时作为 Bing setlang / Google hl。"),
  region: z.string().default("").volatile().description("Bing 的 mkt 市场参数，留空按出口 IP 判断。"),
  safeSearch: z.boolean().default(true).volatile().description("是否开启安全搜索。"),
  proxy: z
    .string()
    .default("")
    .volatile()
    .description("出站 HTTP 代理，例如 http://127.0.0.1:7890；留空直连。注意 Bing 默认直连（走代理会拿到国际版结果），要改就设 bing.proxy。"),
  bing: z
    .object({
      baseUrl: z.string().default("https://www.bing.com").volatile(),
      rss: z.boolean().default(true).volatile().description("结果页解析不到时是否退回 RSS 结果流。"),
      proxy: z
        .string()
        .default("")
        .volatile()
        .description("只给 Bing 用的代理；留空由全局 proxy 决定，但 Bing 在全局代理下会改成直连（见 proxy 说明）。"),
    })
    .description("Bing 引擎。"),
  duckduckgo: z
    .object({
      baseUrl: z.string().default("https://html.duckduckgo.com").volatile(),
      region: z.string().default("cn-zh").volatile().description("DuckDuckGo 的 kl 地区参数，留空为默认。"),
      proxy: z.string().default("").volatile().description("只给 DuckDuckGo 用的代理；留空用全局 proxy。"),
    })
    .description("DuckDuckGo 引擎（国内网络通常需要代理）。"),
  mojeek: z
    .object({
      baseUrl: z.string().default("https://www.mojeek.com").volatile(),
      proxy: z.string().default("").volatile().description("只给 Mojeek 用的代理；留空用全局 proxy。"),
    })
    .description("Mojeek 引擎（独立索引；对部分出口 IP 会要求人机验证）。"),
  google: z
    .object({
      baseUrl: z.string().default("https://www.googleapis.com/customsearch/v1").volatile(),
      webBaseUrl: z.string().default("https://www.google.com").volatile(),
      proxy: z.string().default("").volatile().description("只给 Google 用的代理；留空用全局 proxy。"),
      apiKey: z.string().role("secret").default("").volatile().description("官方 Programmable Search API key。"),
      apiKeyEnv: z.string().role("credential-ref").default("GOOGLE_CSE_API_KEY").volatile(),
      cx: z.string().default("").volatile().description("Programmable Search 的搜索引擎 id（cx）。"),
      cxEnv: z.string().role("credential-ref").default("GOOGLE_CSE_CX").volatile(),
      allowHtmlFallback: z
        .boolean()
        .default(false)
        .volatile()
        .description("没有凭据时是否仍尝试抓结果页（Google 现在普遍返回“需要 JavaScript”占位页，一般没用）。"),
    })
    .description("Google 引擎。"),
  brave: z
    .object({
      baseUrl: z.string().default("https://api.search.brave.com/res/v1/web/search").volatile(),
      proxy: z.string().default("").volatile().description("只给 Brave 用的代理；留空用全局 proxy。"),
      apiKey: z.string().role("secret").default("").volatile().description("Brave Search API key。"),
      apiKeyEnv: z.string().role("credential-ref").default("BRAVE_SEARCH_API_KEY").volatile(),
    })
    .description("Brave 引擎（需要 API key）。"),
  browser: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .volatile()
        .description("开启「浏览器取数」：用本机 Chrome/Edge 打开结果页再提取，能拿到 HTTP 拿不到的结果。"),
      exe: z.string().default("").volatile().description("浏览器可执行文件路径；留空自动探测 Chrome / Edge。"),
      headless: z.boolean().default(true).volatile().description("无头模式（不弹窗口）；关掉会弹出一个浏览器窗口。"),
      headlessForGoogle: z
        .boolean()
        .default(false)
        .volatile()
        .description("google-web 使用有头模式（实测只有有头能过 Google 的自动化检测）；会弹窗口。"),
      proxy: z.string().default("").volatile().description("浏览器专用代理；留空用全局 proxy。"),
      profileDir: z
        .string()
        .default("")
        .volatile()
        .description("浏览器 profile 目录；填了就能跨次数复用 Cookie（有助于过一些站的验证）。"),
      idleMs: z.number().step(1).min(0).max(3600000).default(120000).volatile()
        .description("浏览器空闲多久后自动关闭（毫秒）；0 = 不自动关。"),
      waitMs: z.number().step(500).min(2000).max(60000).default(8000).volatile()
        .description("单个浏览器引擎最多等多久出结果（毫秒）。"),
      verbose: z.boolean().default(false).volatile().description("把浏览器调度日志打到 Host 控制台，排错用。"),
    })
    .description("浏览器取数（无头 Chrome / Edge）。"),
});

/** 代码里的默认值（与上面的 schema 保持一致，供没有 schema 时兜底）。 */
const DEFAULTS = {
  mode: "merge",
  preferOfficial: false,
  officialProviderId: "deepseek-official",
  engines: ["bing", "duckduckgo", "google"],
  maxResults: 6,
  timeoutMs: 12000,
  language: "zh-CN",
  region: "",
  safeSearch: true,
  proxy: "",
  bing: { baseUrl: "https://www.bing.com", rss: true, proxy: "" },
  duckduckgo: { baseUrl: "https://html.duckduckgo.com", region: "cn-zh", proxy: "" },
  mojeek: { baseUrl: "https://www.mojeek.com", proxy: "" },
  google: {
    baseUrl: "https://www.googleapis.com/customsearch/v1",
    webBaseUrl: "https://www.google.com",
    proxy: "",
    apiKey: "",
    apiKeyEnv: "GOOGLE_CSE_API_KEY",
    cx: "",
    cxEnv: "GOOGLE_CSE_CX",
    allowHtmlFallback: false,
  },
  brave: {
    baseUrl: "https://api.search.brave.com/res/v1/web/search",
    proxy: "",
    apiKey: "",
    apiKeyEnv: "BRAVE_SEARCH_API_KEY",
  },
  browser: {
    enabled: false,
    exe: "",
    headless: true,
    headlessForGoogle: false,
    proxy: "",
    profileDir: "",
    idleMs: 120000,
    waitMs: 8000,
    verbose: false,
  },
};

/** 声明了 Config schema 时，cordis 把每个字段包成带 `.get()` 的访问器（可热更新）。 */
function unwrap(node) {
  return node !== null && typeof node === "object" && typeof node.get === "function" ? node.get() : node;
}

/**
 * 把 cordis 交给插件的 config 归一成普通对象：既支持"纯对象"（没有 schema 时），
 * 也支持"访问器对象"（有 schema 时，字段与嵌套字段各自带 `.get()`）。
 */
function readRawConfig(config) {
  if (config === undefined || config === null) return {};
  const source = unwrap(config);
  if (typeof source !== "object" || Array.isArray(source)) return source;
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const direct = unwrap(value);
    if (direct !== null && typeof direct === "object" && Array.isArray(direct) === false) {
      const nested = {};
      for (const [childKey, childValue] of Object.entries(direct)) nested[childKey] = unwrap(childValue);
      out[key] = nested;
    } else {
      out[key] = direct;
    }
  }
  return out;
}

function configError(message) {
  return new Error(`web-search-multi 配置有误：${message}`);
}

function readString(raw, key, fallback) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw configError(`\`${key}\` 必须是字符串`);
  return value;
}

function readBoolean(raw, key, fallback) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw configError(`\`${key}\` 必须是布尔值`);
  return value;
}

function readInteger(raw, key, fallback, { min, max }) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || Number.isInteger(value) === false) throw configError(`\`${key}\` 必须是整数`);
  if (value < min || value > max) throw configError(`\`${key}\` 必须在 ${min}~${max} 之间`);
  return value;
}

function readSection(raw, key) {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw configError(`\`${key}\` 必须是一个对象`);
  return value;
}

/** Bing 的 setlang 只认语言标签，把 zh-CN 之类映射过去。 */
function bingSetLang(language) {
  const lower = language.toLowerCase();
  if (lower.startsWith("zh-cn") || lower === "zh-hans") return "zh-hans";
  if (lower.startsWith("zh-tw") || lower.startsWith("zh-hk") || lower === "zh-hant") return "zh-hant";
  return lower.split("-")[0];
}

/** 校验并补全配置；任何非法值都直接报错，不静默降级。 */
export function normalizeConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw;
  if (typeof source !== "object" || Array.isArray(source)) throw configError("config 必须是一个对象");

  const enginesRaw = source.engines;
  let engines = DEFAULTS.engines;
  if (enginesRaw !== undefined && enginesRaw !== null) {
    if (Array.isArray(enginesRaw) === false) throw configError("`engines` 必须是数组，例如 [bing, google]");
    engines = enginesRaw.map((entry) => {
      if (typeof entry !== "string") throw configError("`engines` 的每一项都必须是字符串");
      const id = entry.trim().toLowerCase();
      if (KNOWN_ENGINES.includes(id) === false) {
        throw configError(`未知引擎 "${entry}"，可用：${KNOWN_ENGINES.join("、")}`);
      }
      return id;
    });
    if (engines.length === 0) throw configError("`engines` 至少要有一个引擎");
  }

  const modeRaw = readString(source, "mode", DEFAULTS.mode).trim().toLowerCase();
  if (KNOWN_MODES.includes(modeRaw) === false) throw configError(`\`mode\` 只能是 ${KNOWN_MODES.join(" 或 ")}`);
  const mode = modeRaw;
  const preferOfficial = readBoolean(source, "preferOfficial", DEFAULTS.preferOfficial);
  const officialProviderId =
    readString(source, "officialProviderId", DEFAULTS.officialProviderId).trim() || DEFAULTS.officialProviderId;
  const maxResults = readInteger(source, "maxResults", DEFAULTS.maxResults, { min: 1, max: 20 });
  const timeoutMs = readInteger(source, "timeoutMs", DEFAULTS.timeoutMs, { min: 1000, max: 120000 });
  const language = readString(source, "language", DEFAULTS.language).trim() || DEFAULTS.language;
  const region = readString(source, "region", DEFAULTS.region).trim();
  const safeSearch = readBoolean(source, "safeSearch", DEFAULTS.safeSearch);
  const proxy = readString(source, "proxy", DEFAULTS.proxy).trim();

  const bingRaw = readSection(source, "bing");
  const bing = {
    baseUrl: readString(bingRaw, "baseUrl", DEFAULTS.bing.baseUrl).trim() || DEFAULTS.bing.baseUrl,
    rss: readBoolean(bingRaw, "rss", DEFAULTS.bing.rss),
    proxy: readString(bingRaw, "proxy", DEFAULTS.bing.proxy).trim(),
  };

  const duckduckgoRaw = readSection(source, "duckduckgo");
  const duckduckgo = {
    baseUrl: readString(duckduckgoRaw, "baseUrl", DEFAULTS.duckduckgo.baseUrl).trim() || DEFAULTS.duckduckgo.baseUrl,
    region: readString(duckduckgoRaw, "region", DEFAULTS.duckduckgo.region).trim(),
    proxy: readString(duckduckgoRaw, "proxy", DEFAULTS.duckduckgo.proxy).trim(),
  };

  const mojeekRaw = readSection(source, "mojeek");
  const mojeek = {
    baseUrl: readString(mojeekRaw, "baseUrl", DEFAULTS.mojeek.baseUrl).trim() || DEFAULTS.mojeek.baseUrl,
    proxy: readString(mojeekRaw, "proxy", DEFAULTS.mojeek.proxy).trim(),
  };

  const googleRaw = readSection(source, "google");
  const google = {
    baseUrl: readString(googleRaw, "baseUrl", DEFAULTS.google.baseUrl).trim() || DEFAULTS.google.baseUrl,
    webBaseUrl: readString(googleRaw, "webBaseUrl", DEFAULTS.google.webBaseUrl).trim() || DEFAULTS.google.webBaseUrl,
    proxy: readString(googleRaw, "proxy", DEFAULTS.google.proxy).trim(),
    apiKey: readString(googleRaw, "apiKey", DEFAULTS.google.apiKey).trim(),
    apiKeyEnv: readString(googleRaw, "apiKeyEnv", DEFAULTS.google.apiKeyEnv).trim(),
    cx: readString(googleRaw, "cx", DEFAULTS.google.cx).trim(),
    cxEnv: readString(googleRaw, "cxEnv", DEFAULTS.google.cxEnv).trim(),
    allowHtmlFallback: readBoolean(googleRaw, "allowHtmlFallback", DEFAULTS.google.allowHtmlFallback),
  };

  const braveRaw = readSection(source, "brave");
  const brave = {
    baseUrl: readString(braveRaw, "baseUrl", DEFAULTS.brave.baseUrl).trim() || DEFAULTS.brave.baseUrl,
    proxy: readString(braveRaw, "proxy", DEFAULTS.brave.proxy).trim(),
    apiKey: readString(braveRaw, "apiKey", DEFAULTS.brave.apiKey).trim(),
    apiKeyEnv: readString(braveRaw, "apiKeyEnv", DEFAULTS.brave.apiKeyEnv).trim(),
  };

  const browserRaw = readSection(source, "browser");
  const browser = {
    enabled: readBoolean(browserRaw, "enabled", DEFAULTS.browser.enabled),
    exe: readString(browserRaw, "exe", DEFAULTS.browser.exe).trim(),
    headless: readBoolean(browserRaw, "headless", DEFAULTS.browser.headless),
    headlessForGoogle: readBoolean(browserRaw, "headlessForGoogle", DEFAULTS.browser.headlessForGoogle),
    proxy: readString(browserRaw, "proxy", DEFAULTS.browser.proxy).trim(),
    profileDir: readString(browserRaw, "profileDir", DEFAULTS.browser.profileDir).trim(),
    idleMs: readInteger(browserRaw, "idleMs", DEFAULTS.browser.idleMs, { min: 0, max: 3600000 }),
    waitMs: readInteger(browserRaw, "waitMs", DEFAULTS.browser.waitMs, { min: 2000, max: 60000 }),
    verbose: readBoolean(browserRaw, "verbose", DEFAULTS.browser.verbose),
  };

  return {
    mode,
    preferOfficial,
    officialProviderId,
    engines,
    maxResults,
    timeoutMs,
    language,
    region,
    safeSearch,
    proxy,
    setLang: bingSetLang(language),
    // Bing 结果页每页约 10 条，多要一点以保证 maxResults 能填满。
    requestCount: Math.min(Math.max(maxResults * 2, 10), 30),
    bing,
    duckduckgo,
    mojeek,
    google,
    brave,
    browser,
  };
}

/**
 * 解析一个凭据：字面值优先，其次凭据服务，最后进程环境变量。
 * 每次搜索都重新解析，所以改了配置/凭据无需重启。
 */
async function resolveSecret(ctx, literal, envName) {
  if (literal.length > 0) return literal;
  if (envName.length === 0) return "";
  try {
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(envName);
      const value = resolved?.value;
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // 凭据服务不可用时退回环境变量，不打断搜索。
  }
  const ambient = process.env[envName];
  return typeof ambient === "string" ? ambient.trim() : "";
}

/** 给错误打上机器可读的 code，让工具层能按类型归类。 */
function withCode(error, code) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  if (wrapped.code === undefined) {
    try {
      wrapped.code = code;
    } catch {
      // 只读错误对象：忽略，消息本身仍可用。
    }
  }
  return wrapped;
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "WEB_ABORTED" || error?.code === "ABORT_ERR";
}

/**
 * 取官方搜索 provider（`ctx.web` 注册表里的另一个 provider）。
 *
 * `WebSearchProvider` 的契约只有 `id` / `available()` / `search()`，注册表本身是
 * web 服务上的一个 Map 字段。这里按 id 取出来转发，好处是"优先官方"这个开关
 * 完全由本插件的配置控制：不用去改 `web` 行的 `searchProvider`（那个字段不是
 * volatile，设置页改不了），官方 provider 没装或不可用时也能自动回退。
 */
function officialProvider(ctx, id) {
  try {
    const registry = ctx?.web?.searchProviders;
    if (registry instanceof Map === false) return undefined;
    const provider = registry.get(id);
    return provider !== undefined && typeof provider.search === "function" ? provider : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 注册搜索 provider。
 *
 * 配置在**每次搜索时**重新读取：设置页改完保存后立刻生效，不需要重载插件。
 *
 * @param ctx - 插件上下文；`inject: [web]` 保证 ctx.web 可用。
 * @param config - 本行配置（有 Config schema 时是访问器对象）。
 */
function apply(ctx, config) {
  const snapshot = () => normalizeConfig(readRawConfig(config));
  // 激活时先跑一遍：配置写错要立刻暴露，而不是等第一次搜索。
  const initial = snapshot();
  // 代理变了要换 requester，所以按 proxy 值缓存一个。
  let cachedProxy = initial.proxy;
  let cachedRequest = createRequester({ proxy: initial.proxy });
  const requestFor = (proxy) => {
    if (proxy !== cachedProxy) {
      cachedRequest = createRequester({ proxy });
      cachedProxy = proxy;
    }
    return cachedRequest;
  };

  const provider = {
    id: PROVIDER_ID,
    // 可用性无法同步判断（取决于网络与凭据），因此始终视为可用；
    // 真正的失败在 search() 里带原因抛出。
    available: () => true,
    async search(searchRequest, signal) {
      const query = typeof searchRequest?.query === "string" ? searchRequest.query.trim() : "";
      if (query.length === 0) throw withCode(new Error("web-search-multi：查询为空"), "WEB_PROVIDER_ERROR");

      const options = snapshot();
      // 服务侧还会按 request.maxResults 再截一次；这里保证每个引擎取多少条。
      const perEngine = options.maxResults;
      const resolved = {
        ...options,
        maxResults: perEngine,
        google: {
          ...options.google,
          apiKey: await resolveSecret(ctx, options.google.apiKey, options.google.apiKeyEnv),
          cx: await resolveSecret(ctx, options.google.cx, options.google.cxEnv),
        },
        brave: {
          ...options.brave,
          apiKey: await resolveSecret(ctx, options.brave.apiKey, options.brave.apiKeyEnv),
        },
      };
      const request = requestFor(options.proxy);
      // 每个引擎可以有自己的代理（例如 Bing 直连拿中文结果、DuckDuckGo 走本地代理）。
      const requestForEngine = (engineId) => {
        const own = resolved[engineId]?.proxy;
        if (typeof own === "string" && own.length > 0) return requestFor(own);
        // Bing 例外：走代理会落到 www.bing.com（国际版），同一个中文查询返回的结果集
        // 和 cn.bing.com 完全不同，而且慢一个数量级（实测 4.2s 且结果错，直连 0.4s 且正确）。
        // 所以没显式配 bing.proxy 时，Bing 一律直连，不跟随全局 proxy。
        if (engineId === "bing") return requestFor("");
        return request;
      };

      const failures = [];
      // 「优先官方」：先让官方 provider 试一次，失败/不可用再走下面的引擎。
      if (options.preferOfficial) {
        const official = officialProvider(ctx, options.officialProviderId);
        if (official === undefined) {
          failures.push(`official(${options.officialProviderId})：未注册，已回退到 ${resolved.engines.join(" / ")}`);
        } else if (official.available() === false) {
          failures.push(`official(${options.officialProviderId})：不可用，已回退到 ${resolved.engines.join(" / ")}`);
        } else {
          try {
            const result = await official.search(searchRequest, signal);
            if (result.sources.length > 0) return result;
            failures.push(`official(${options.officialProviderId})：没有返回结果，已回退`);
          } catch (error) {
            if (isAbort(error) || signal?.aborted === true) throw withCode(error, "WEB_ABORTED");
            failures.push(
              `official(${options.officialProviderId})：${error instanceof Error ? error.message : String(error)}，已回退`,
            );
          }
        }
      }

      // 挑出真正要问的引擎：需要凭据却没配的直接跳过，免得白等一次超时。
      const planned = [];
      for (const engineId of resolved.engines) {
        const readiness = engineReadiness(engineId, resolved);
        if (readiness.ready) planned.push(engineId);
        else failures.push(`${engineId}：已跳过（${readiness.reason}）`);
      }

      if (options.mode === "merge" && planned.length > 1) {
        // 混合模式：并行问所有引擎，到点（timeoutMs）就用已经拿到的结果。
        const merged = await mergeEngines(planned, query, resolved, requestForEngine, signal, failures);
        if (merged.length > 0) return { sources: merged, truncated: false };
      } else {
        for (const engineId of planned) {
          if (signal?.aborted === true) throw withCode(new Error("搜索已取消"), "WEB_ABORTED");
          try {
            const result = await runEngine(engineId, query, resolved, requestForEngine(engineId), signal);
            if (result.sources.length > 0) return result;
            failures.push(`${engineId}：没有返回结果`);
          } catch (error) {
            if (isAbort(error) || signal?.aborted === true) throw withCode(error, "WEB_ABORTED");
            failures.push(`${engineId}：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      throw withCode(
        new Error(`所有搜索引擎都没能返回结果（查询：${query}）\n- ${failures.join("\n- ")}`),
        "WEB_PROVIDER_ERROR",
      );
    },
  };

  ctx.web.registerSearchProvider(provider);

  // 插件卸载时收掉常驻浏览器，别留孤儿进程。
  ctx.on?.("dispose", () => {
    try { closeAllBrowsers(); } catch { /* ignore */ }
  });

  const proxyNote = initial.proxy.length > 0 ? `，代理：${initial.proxy}` : "";
  const browserNote = initial.browser.enabled
    ? `，浏览器取数：${findBrowser(initial.browser.exe) ?? "未找到 Chrome/Edge"}`
    : "";
  ctx.logger?.info?.(
    `web-search-multi 已注册为搜索后端（${initial.mode === "merge" ? "混合" : "依次"}：${initial.engines.join(" + ")}${proxyNote}${browserNote}）`,
  );
}

/**
 * 并行问所有引擎，按名次轮转混合结果。
 *
 * 总预算就是 timeoutMs：到点用 AbortController 掐掉还没回来的引擎，
 * 拿已经到手的部分继续，所以某个引擎不可用不会拖垮整次搜索。
 *
 * @param {string[]} engineIds - 要问的引擎
 * @returns {Promise<Array>} 混合去重后的结果（可能为空）
 */
async function mergeEngines(engineIds, query, options, requestForEngine, signal, failures) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("搜索总预算用尽")), options.timeoutMs);
  const budgeted = AbortSignal.any([signal, deadline.signal].filter((entry) => entry !== undefined));
  try {
    const settled = await Promise.allSettled(
      engineIds.map(async (engineId) => ({
        engineId,
        result: await runEngine(engineId, query, options, requestForEngine(engineId), budgeted),
      })),
    );
    const lists = [];
    settled.forEach((outcome, index) => {
      const engineId = engineIds[index];
      if (outcome.status === "fulfilled") {
        if (outcome.value.result.sources.length > 0) lists.push(outcome.value.result.sources);
        else failures.push(`${engineId}：没有返回结果`);
        return;
      }
      // 调用方取消要原样抛出；总预算到点只算这个引擎没赶上。
      if (signal?.aborted === true) throw withCode(outcome.reason, "WEB_ABORTED");
      failures.push(`${engineId}：${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
    });
    return interleaveSources(lists, options.maxResults * engineIds.length);
  } finally {
    clearTimeout(timer);
  }
}

export { apply, Config, DEFAULTS, inject, KNOWN_ENGINES, name, PROVIDER_ID, readRawConfig };
export { browserDiagnostics, browserPoolStatus, closeAllBrowsers, findBrowser };
