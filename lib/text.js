/**
 * 文本与 URL 清洗：搜索结果页是 HTML，标题/摘要里混着实体与标签，
 * 链接里混着跳转包装。这里集中处理，供各引擎复用。
 */

/** 常见命名实体。覆盖搜索引擎标题/摘要里实际会出现的那些。 */
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  minus: "−",
  middot: "·",
  bull: "•",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  frac12: "½",
  permil: "‰",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  prime: "′",
  larr: "←",
  rarr: "→",
  harr: "↔",
  le: "≤",
  ge: "≥",
  ne: "≠",
  infin: "∞",
};

/** 解码 HTML 实体（命名 + 十进制 + 十六进制）。 */
export function decodeEntities(input) {
  if (typeof input !== "string" || input.includes("&") === false) return input ?? "";
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** 块级标签换成空格；行内标签（如 <strong>）直接删掉，否则 "Node<b>.js</b>" 会变成 "Node .js"。 */
const BLOCK_TAGS =
  /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|legend|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/i;

/** 去标签 + 解码实体 + 压平空白。 */
export function cleanText(html) {
  if (typeof html !== "string") return "";
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_match, tag) => (BLOCK_TAGS.test(tag) ? " " : ""));
  return decodeEntities(stripped)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 摘要裁剪：太长的片段对模型没有额外价值，反而吃 token。 */
export function clampSnippet(text, limit = 320) {
  const cleaned = cleanText(text)
    // 结果页会在摘要末尾拼接"阅读更多"之类的 UI 文案，去掉。
    .replace(/\s*(?:阅读更多|展开|查看更多|Read more|See more|View more)\.{0,3}\s*$/i, "")
    .trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

/** 只接受 http/https 绝对地址。 */
export function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** 解码 Bing 的跳转包装：https://www.bing.com/ck/a?...&u=a1<base64url> */
function unwrapBingRedirect(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!/(^|\.)bing\.com$/i.test(parsed.hostname)) return raw;
  if (!parsed.pathname.startsWith("/ck/a")) return raw;
  const encoded = parsed.searchParams.get("u");
  if (encoded === null || encoded.length <= 2) return raw;
  const payload = encoded.slice(2); // 去掉 "a1" 前缀
  try {
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return isHttpUrl(decoded) ? decoded : raw;
  } catch {
    return raw;
  }
}

/**
 * 把结果页里抓到的 href 归一成可引用的绝对 URL。
 * @returns {string | undefined} 不是可引用结果链接时返回 undefined。
 */
export function normalizeResultUrl(raw, baseUrl) {
  if (typeof raw !== "string") return undefined;
  let href = decodeEntities(raw).trim();
  if (href.length === 0 || href.startsWith("#")) return undefined;
  if (/^(javascript|data|mailto|tel):/i.test(href)) return undefined;
  // 结果页的跳转包装：/url?q=<encoded>
  if (href.startsWith("/url?")) {
    const target = new URLSearchParams(href.slice(5)).get("q");
    if (target === null) return undefined;
    href = target;
  }
  let absolute;
  if (/^https?:\/\//i.test(href)) absolute = href;
  else if (href.startsWith("//")) absolute = `https:${href}`;
  else if (href.startsWith("/")) {
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return undefined;
    }
  } else return undefined;
  const unwrapped = unwrapBingRedirect(absolute);
  if (!isHttpUrl(unwrapped)) return undefined;
  try {
    const parsed = new URL(unwrapped);
    // 结果页自身的导航链接不是结果。
    if (/(^|\.)bing\.com$/i.test(parsed.hostname) && /^\/(search|images|videos|maps|ck|account|profile)/i.test(parsed.pathname)) {
      return undefined;
    }
    if (/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && /^\/(search|preferences|advanced_search|setprefs|url|httpservice)/i.test(parsed.pathname)) {
      return undefined;
    }
    if (/^support\.google\.com$/i.test(parsed.hostname)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** 按 URL 去重，保留首次出现顺序，并丢弃空字段。 */
export function dedupeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    if (source === undefined || source === null) continue;
    const url = source.url;
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      ...(typeof source.title === "string" && source.title.length > 0 ? { title: source.title } : {}),
      ...(typeof source.snippet === "string" && source.snippet.length > 0 ? { snippet: source.snippet } : {}),
      ...(typeof source.publishedAt === "string" && source.publishedAt.length > 0
        ? { publishedAt: source.publishedAt }
        : {}),
    });
  }
  return out;
}
