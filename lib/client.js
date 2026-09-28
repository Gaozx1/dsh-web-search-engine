/**
 * dsh-web-search-engine — 浏览器半边：在「设置」里加一页搜索设置。
 *
 * 这一页读写插件自己的配置命名空间（`web-search-multi`）：结果组合方式、
 * 启用的引擎及顺序、条数/超时/语言/代理、各引擎的凭据与地址，
 * 以及"优先官方搜索"开关。
 *
 * 读写走 `ctx.remote.settings`（Host 的 settings 服务），不依赖任何 Harness
 * Client 包：控件、样式都自己写，只引用主题 token（--dsw-alias-*）。
 *
 * 注意：本文件是"客户端模块"，由浏览器的 __ModuleLoader__ 加载，不是 ESM。
 */

window.__ModuleLoader__.load({
  id: "dsh-web-search-engine",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    /** 本页的文案命名空间。 */
    const LOCALE_NS = "settings.webSearchMulti";
    /** Host 侧 settings 里的命名空间 = 插件行的 patch id。 */
    const SETTINGS_NS = "web-search-multi";
    /** 支持的引擎，顺序即默认展示顺序。 */
    const ENGINES = ["bing", "duckduckgo", "mojeek", "google", "brave", "brave-web", "ddg-web", "google-web"];
    /** 需要凭据的引擎（没配时给出提示）。 */
    const NEEDS_CREDENTIALS = { google: "google", brave: "brave" };
    /** 走浏览器取数的引擎（共用「浏览器取数」那一节的开关）。 */
    const BROWSER_ENGINES = ["brave-web", "ddg-web", "google-web"];

    const en = {
      title: "Search",
      description: "Choose how web_search is answered: mix several search engines, and pick which ones.",
      mode: "Result mode",
      modeMerge: "Mix all engines",
      modeFallback: "Try engines in order",
      modeHint: "Mix runs every enabled engine in parallel and interleaves their results; in-order stops at the first engine that answers.",
      backend: "Official search",
      preferOfficial: "Prefer the official search",
      preferOfficialHint: "Ask the official DeepSeek provider first; fall back to the engines below when it fails or is unavailable.",
      preferOfficialOn: "Official first, engines as fallback",
      preferOfficialOff: "Engines only",
      engines: "Engines and order",
      enginesHint: "Checked engines are queried. Order decides whose results come first when mixing.",
      moveUp: "Move up",
      moveDown: "Move down",
      engineNeedsKey: "needs an API key",
      engineNeedsBrowser: "needs browser fetching",
      engineNote: {
        bing: "Scrapes Bing; falls back to its RSS feed. Always connects directly (via a proxy Bing serves a different, worse result set).",
        duckduckgo: "Scrapes the HTML endpoint; usually needs a proxy from mainland China.",
        mojeek: "Independent index; some exit IPs get a captcha.",
        google: "Needs a Programmable Search key + cx; page scraping is blocked by Google's JS gate.",
        brave: "Needs a Brave Search API key.",
        "brave-web": "Renders Brave in a local Chrome/Edge; no API key needed. Recommended; may rate-limit if hammered.",
        "ddg-web": "Renders duckduckgo.com in a local browser; steadier than the HTML endpoint.",
        "google-web": "Renders Google in a local browser. Only works windowed (see below) and rate-limits quickly.",
      },
      browser: "Browser fetching",
      browserHint: "Some engines only answer a real browser. These use a local Chrome/Edge over CDP; no extra packages needed.",
      browserEnabled: "Enable browser fetching",
      browserEnabledHint: "Required for brave-web / ddg-web / google-web. A browser starts on first use and closes when idle.",
      browserExe: "Browser executable",
      browserExeHint: "Leave blank to auto-detect Chrome, then Edge.",
      browserHeadless: "Headless",
      browserHeadlessHint: "On: no window. Off: a visible window (sometimes passes checks that headless fails).",
      browserHeadlessForGoogle: "Windowed mode for google-web",
      browserHeadlessForGoogleHint:
        "google-web only got past Google's automation check in windowed mode in testing; headless always hit the 'sorry' page. A visible window will appear.",
      browserProxy: "Browser proxy",
      browserProxyHint: "Leave blank to use the default proxy above.",
      browserProfileDir: "Browser profile directory",
      browserProfileDirHint: "Blank: a throwaway profile per run. Set a path to keep cookies between searches.",
      browserIdle: "Close browser after idle (ms)",
      browserIdleHint: "0 keeps it running.",
      browserWait: "Wait per browser engine (ms)",
      browserWaitHint: "Give up on this engine after this long; the browser still finishes in the background for the next search.",
      browserVerbose: "Verbose browser logs",
      tuning: "Limits",
      maxResults: "Results per engine",
      maxResultsHint: "How many results each engine contributes before mixing.",
      timeoutMs: "Total budget (ms)",
      timeoutMsHint: "Mixing uses whatever arrived when this budget runs out.",
      language: "Language",
      region: "Bing market",
      regionHint: "Leave blank to let Bing decide from the exit IP.",
      safeSearch: "Safe search",
      proxy: "Default proxy",
      proxyHint: "Applies to every engine unless that engine sets its own, e.g. http://127.0.0.1:7890. Leave blank for a direct connection.",
      credentials: "Credentials",
      credentialsHint: "Engines without credentials are skipped instead of burning the time budget.",
      apiKey: "Google API key",
      apiKeySet: "A key is configured.",
      apiKeyUnset: "No key configured; Google is skipped.",
      apiKeyHint: "Stored in the settings file. Leave blank to keep the current key.",
      cx: "Google engine id (cx)",
      braveKey: "Brave API key",
      braveKeySet: "A key is configured.",
      braveKeyUnset: "No key configured; Brave is skipped.",
      advanced: "Advanced",
      bingBaseUrl: "Bing base URL",
      duckduckgoBaseUrl: "DuckDuckGo base URL",
      duckduckgoRegion: "DuckDuckGo region (kl)",
      mojeekBaseUrl: "Mojeek base URL",
      googleBaseUrl: "Google API base URL",
      googleWebBaseUrl: "Google site",
      braveBaseUrl: "Brave API base URL",
      engineProxy: "Proxy for",
      bingRss: "Fall back to Bing RSS",
      officialProviderId: "Official provider id",
      googleHtmlFallback: "Try scraping Google without a key",
      save: "Save",
      saving: "Saving…",
      saved: "Saved.",
      discard: "Discard",
      reload: "Reload",
      loadFailed: "Could not read the settings from the deployment.",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "The plugin's settings namespace is not being served right now.",
      loading: "Loading…",
    };
    const zh = {
      title: "搜索",
      description: "选择 web_search 由谁执行：可以并行问多个搜索引擎，把结果混合后交给模型。",
      mode: "结果组合方式",
      modeMerge: "混合所有引擎",
      modeFallback: "按顺序尝试",
      modeHint: "混合：并行问所有启用的引擎，把各自的结果按名次轮转混合；按顺序：第一个出结果的引擎即胜出。",
      backend: "官方搜索",
      preferOfficial: "优先使用官方搜索",
      preferOfficialHint: "先问官方 DeepSeek provider；失败或不可用时回退到下面的引擎。",
      preferOfficialOn: "优先官方，失败回退引擎",
      preferOfficialOff: "只用下面的引擎",
      engines: "引擎与顺序",
      enginesHint: "勾选的引擎会被查询；顺序决定混合时同名次结果的先后。",
      moveUp: "上移",
      moveDown: "下移",
      engineNeedsKey: "需要 API key",
      engineNeedsBrowser: "需要开启浏览器取数",
      engineNote: {
        bing: "抓 Bing 结果页；解析不到时退回它的 RSS。始终直连（走代理会落到国际版，结果差很多）。",
        duckduckgo: "抓 HTML 版结果页；国内直连通常不通，需要代理。",
        mojeek: "独立索引；部分出口 IP 会遇到人机验证。",
        google: "需要 Programmable Search 的 key + cx；抓页已被 Google 的 JS 门挡住。",
        brave: "需要 Brave Search API key。",
        "brave-web": "用本机 Chrome/Edge 渲染 Brave；不需要 key，推荐。搜得太频繁可能被限流。",
        "ddg-web": "用本机浏览器渲染 duckduckgo.com；比 HTML 版稳。",
        "google-web": "用本机浏览器渲染 Google。只有「有头」模式能过，且很快被限流。",
      },
      browser: "浏览器取数",
      browserHint: "有些引擎只认真实浏览器。这里用本机 Chrome/Edge 通过 CDP 取数，不需要额外装包。",
      browserEnabled: "开启浏览器取数",
      browserEnabledHint: "brave-web / ddg-web / google-web 必须先开这里。首次用到时才启动浏览器，空闲后自动关闭。",
      browserExe: "浏览器可执行文件",
      browserExeHint: "留空自动探测 Chrome，再探 Edge。",
      browserHeadless: "无头模式",
      browserHeadlessHint: "开启：不弹窗口。关闭：弹出一个可见窗口（有些站的检测更容易过）。",
      browserHeadlessForGoogle: "google-web 使用有头模式",
      browserHeadlessForGoogleHint:
        "实测只有有头能过 Google 的自动化检测，无头必定跳「sorry」页。开启后会弹出一个浏览器窗口。",
      browserProxy: "浏览器专用代理",
      browserProxyHint: "留空则用上面的默认代理。",
      browserProfileDir: "浏览器 profile 目录",
      browserProfileDirHint: "留空：每次用临时 profile。填一个路径可跨搜索复用 Cookie。",
      browserIdle: "空闲多久后关闭浏览器（毫秒）",
      browserIdleHint: "0 表示一直开着。",
      browserWait: "单个浏览器引擎的最长等待（毫秒）",
      browserVerbose: "输出浏览器调度日志",
      tuning: "限制",
      maxResults: "每个引擎取多少条",
      maxResultsHint: "混合前每个引擎各自贡献多少条结果。",
      timeoutMs: "总预算（毫秒）",
      timeoutMsHint: "混合模式到点就用已经拿到的结果。",
      language: "语言",
      region: "Bing 市场",
      regionHint: "留空则由 Bing 按出口 IP 判断。",
      safeSearch: "安全搜索",
      proxy: "默认代理",
      proxyHint: "所有引擎共用，除非某个引擎单独指定；例如 http://127.0.0.1:7890。留空直连。",
      credentials: "凭据",
      credentialsHint: "没配凭据的引擎会被跳过，而不是白等一次超时。",
      apiKey: "Google API Key",
      apiKeySet: "已配置密钥。",
      apiKeyUnset: "未配置密钥；Google 会被跳过。",
      apiKeyHint: "写入设置文件。留空表示保持当前密钥。",
      cx: "Google 搜索引擎 id（cx）",
      braveKey: "Brave API Key",
      braveKeySet: "已配置密钥。",
      braveKeyUnset: "未配置密钥；Brave 会被跳过。",
      advanced: "高级",
      bingBaseUrl: "Bing 站点",
      duckduckgoBaseUrl: "DuckDuckGo 站点",
      duckduckgoRegion: "DuckDuckGo 地区（kl）",
      mojeekBaseUrl: "Mojeek 站点",
      googleBaseUrl: "Google API 地址",
      googleWebBaseUrl: "Google 站点",
      braveBaseUrl: "Brave API 地址",
      engineProxy: "单独代理：",
      bingRss: "退回 Bing RSS",
      officialProviderId: "官方 provider id",
      googleHtmlFallback: "没有 key 时也尝试抓 Google 页面",
      save: "保存",
      saving: "保存中…",
      saved: "已保存。",
      discard: "放弃修改",
      reload: "重新读取",
      loadFailed: "没能从本部署读到设置。",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      readOnly: "本部署的设置为只读。",
      unavailable: "本插件的设置命名空间当前没有被服务。",
      loading: "加载中…",
    };

    // ── 主题 token 上的内联样式 ──────────────────────────────────────────────
    const S = {
      page: { display: "flex", flexDirection: "column", gap: "16px", color: "var(--dsw-alias-label-primary)" },
      title: { fontSize: "15px", fontWeight: 600, margin: 0 },
      description: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)", margin: 0 },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "14px",
        border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: "12px",
        background: "var(--dsw-alias-bg-layer-1)",
      },
      cardTitle: { fontSize: "13px", fontWeight: 600, margin: 0 },
      row: { display: "flex", flexDirection: "column", gap: "6px" },
      inlineRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
      label: { fontSize: "13px", fontWeight: 500 },
      hint: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", lineHeight: 1.5 },
      input: {
        height: "32px",
        padding: "0 10px",
        borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-bg-base)",
        color: "var(--dsw-alias-label-primary)",
        fontSize: "13px",
        width: "100%",
        boxSizing: "border-box",
      },
      error: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary)" },
      success: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary)" },
      actions: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      primaryButton: {
        height: "32px",
        padding: "0 14px",
        borderRadius: "8px",
        border: "none",
        background: "var(--dsw-alias-brand-primary)",
        color: "#fff",
        fontSize: "13px",
        cursor: "pointer",
      },
      ghostButton: {
        height: "32px",
        padding: "0 12px",
        borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        fontSize: "13px",
        cursor: "pointer",
      },
      iconButton: {
        height: "24px",
        minWidth: "26px",
        padding: "0 6px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        fontSize: "12px",
        cursor: "pointer",
      },
      disabledButton: { opacity: 0.5, cursor: "default" },
      engineRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 8px",
        border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: "8px",
      },
      engineName: { fontSize: "13px", flex: "0 0 auto" },
      engineNote: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary)", flex: "1 1 auto" },
      details: { fontSize: "13px" },
      summary: { cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: "13px" },
      grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" },
    };

    /** 一个极简 store：给 slots 的 hook 用（subscribe / getSnapshot）。 */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot: () => state,
        set(next) {
          state = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /** 按路径读嵌套值。 */
    function readPath(source, path) {
      let node = source;
      for (const key of path) {
        if (node === null || typeof node !== "object") return undefined;
        node = node[key];
      }
      return node;
    }

    /** 开关：沿用宿主控件的 role="switch" + aria-checked 约定。 */
    function Switch(props) {
      const on = props.value === true;
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": on,
          "aria-label": props.label,
          disabled: props.disabled === true,
          onClick: () => props.onChange(!on),
          style: {
            flex: "none",
            position: "relative",
            width: "36px",
            height: "20px",
            padding: 0,
            borderRadius: "999px",
            border: "1px solid var(--dsw-alias-border-l1)",
            background: on ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-bg-layer-2)",
            cursor: props.disabled === true ? "default" : "pointer",
            opacity: props.disabled === true ? 0.5 : 1,
          },
        },
        h("span", {
          style: {
            position: "absolute",
            top: "1px",
            left: on ? "17px" : "1px",
            width: "14px",
            height: "14px",
            borderRadius: "50%",
            background: "#fff",
            transition: "left .15s ease",
          },
        }),
      );
    }

    /** 一行文本/数字输入。 */
    function TextField(props) {
      return h(
        "label",
        { style: S.row },
        h("span", { style: S.label }, props.label),
        h("input", {
          type: props.numeric === true ? "number" : "text",
          value: props.value ?? "",
          placeholder: props.placeholder ?? "",
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
          style: { ...S.input, opacity: props.disabled === true ? 0.6 : 1 },
        }),
        props.hint === undefined ? null : h("span", { style: S.hint }, props.hint),
      );
    }

    /** 设置页本体。 */
    function SearchSettingsPage(props) {
      const t = props.t;
      const state = props.useWebSearchMulti((snapshot) => snapshot);
      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [failure, setFailure] = React.useState("");
      const [savedAt, setSavedAt] = React.useState(0);

      const disabled = state.writable !== true || state.ready !== true;
      const values = state.values ?? {};

      const edit = (path, value) => {
        setFailure("");
        setDraft((current) => ({ ...current, [path]: value }));
      };
      const current = (path) => {
        if (Object.prototype.hasOwnProperty.call(draft, path)) return draft[path];
        return readPath(values, path.split("."));
      };
      const dirty = Object.keys(draft).length > 0;

      const engineList = Array.isArray(current("engines")) ? current("engines") : [];
      const secretSet = (path) => {
        if (Object.prototype.hasOwnProperty.call(draft, path)) return draft[path] !== "";
        return (state.secrets ?? []).some(
          (secret) => Array.isArray(secret.path) && secret.path.join(".") === path && secret.set === true,
        );
      };

      const toggleEngine = (engineId) => {
        const next = engineList.includes(engineId)
          ? engineList.filter((entry) => entry !== engineId)
          : [...engineList, engineId];
        edit("engines", next);
      };
      const moveEngine = (engineId, delta) => {
        const index = engineList.indexOf(engineId);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= engineList.length) return;
        const next = [...engineList];
        next[index] = next[target];
        next[target] = engineId;
        edit("engines", next);
      };

      const submit = async () => {
        if (dirty === false) return;
        setSaving(true);
        setFailure("");
        try {
          const ops = Object.entries(draft).map(([path, value]) => ({ op: "set", path: path.split("."), value }));
          const ok = await props.save(ops);
          if (ok === true) {
            setDraft({});
            setSavedAt(Date.now());
          } else {
            setFailure(t("saveFailed"));
          }
        } catch (error) {
          setFailure(`${t("saveFailed")} ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setSaving(false);
        }
      };

      const header = [
        h("h2", { key: "title", style: S.title }, t("title")),
        h("p", { key: "desc", style: S.description }, t("description")),
      ];

      if (state.ready !== true) {
        return h(
          "div",
          { style: S.page },
          ...header,
          h("p", { style: S.hint }, state.error ? `${t("loadFailed")} ${state.error}` : t("loading")),
        );
      }
      if (state.served !== true) {
        return h(
          "div",
          { style: S.page },
          ...header,
          h("p", { style: S.hint }, t("unavailable")),
          state.error ? h("p", { style: S.error }, state.error) : null,
        );
      }

      // ── 结果组合方式 + 引擎清单 ────────────────────────────────────────────
      const engineCard = h(
        "section",
        { key: "engines", style: S.card },
        h("h3", { style: S.cardTitle }, t("engines")),
        h(
          "label",
          { style: S.row },
          h("span", { style: S.label }, t("mode")),
          h(
            "select",
            {
              value: current("mode") === "fallback" ? "fallback" : "merge",
              disabled,
              onChange: (event) => edit("mode", event.target.value),
              style: S.input,
            },
            h("option", { value: "merge" }, t("modeMerge")),
            h("option", { value: "fallback" }, t("modeFallback")),
          ),
          h("span", { style: S.hint }, t("modeHint")),
        ),
        h(
          "div",
          { style: S.row },
          ...ENGINES.map((engineId) => {
            const enabled = engineList.includes(engineId);
            const index = engineList.indexOf(engineId);
            const needsKey =
              engineId === "brave" ? secretSet("brave.apiKey") === false : engineId === "google" ? secretSet("google.apiKey") === false : false;
            // 浏览器引擎还依赖「浏览器取数」总开关，没开时给出提示。
            const needsBrowser = BROWSER_ENGINES.includes(engineId) && current("browser.enabled") !== true;
            const flags = [needsKey ? t("engineNeedsKey") : "", needsBrowser ? t("engineNeedsBrowser") : ""].filter(Boolean);
            return h(
              "div",
              { key: engineId, style: S.engineRow },
              h("input", {
                type: "checkbox",
                checked: enabled,
                disabled,
                "aria-label": engineId,
                onChange: () => toggleEngine(engineId),
              }),
              h("span", { style: S.engineName }, engineId),
              h(
                "span",
                { style: S.engineNote },
                `${t("engineNote")[engineId] ?? ""}${flags.length > 0 && enabled ? ` · ${flags.join(" / ")}` : ""}`,
              ),
              enabled && index > 0
                ? h(
                    "button",
                    {
                      type: "button",
                      title: t("moveUp"),
                      "aria-label": `${t("moveUp")} ${engineId}`,
                      disabled,
                      onClick: () => moveEngine(engineId, -1),
                      style: S.iconButton,
                    },
                    "↑",
                  )
                : null,
              enabled && index >= 0 && index < engineList.length - 1
                ? h(
                    "button",
                    {
                      type: "button",
                      title: t("moveDown"),
                      "aria-label": `${t("moveDown")} ${engineId}`,
                      disabled,
                      onClick: () => moveEngine(engineId, 1),
                      style: S.iconButton,
                    },
                    "↓",
                  )
                : null,
            );
          }),
          h("span", { style: S.hint }, t("enginesHint")),
        ),
      );

      // ── 官方优先 ──────────────────────────────────────────────────────────
      const officialCard = h(
        "section",
        { key: "official", style: S.card },
        h("h3", { style: S.cardTitle }, t("backend")),
        h(
          "div",
          { style: S.inlineRow },
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "4px" } },
            h("span", { style: S.label }, t("preferOfficial")),
            h("span", { style: S.hint }, t("preferOfficialHint")),
            h(
              "span",
              { style: S.hint },
              current("preferOfficial") === true ? t("preferOfficialOn") : t("preferOfficialOff"),
            ),
          ),
          h(Switch, {
            label: t("preferOfficial"),
            value: current("preferOfficial") === true,
            disabled,
            onChange: (next) => edit("preferOfficial", next),
          }),
        ),
      );

      // ── 限制 ──────────────────────────────────────────────────────────────
      const tuningCard = h(
        "section",
        { key: "tuning", style: S.card },
        h("h3", { style: S.cardTitle }, t("tuning")),
        h(
          "div",
          { style: S.grid },
          h(TextField, {
            label: t("maxResults"),
            numeric: true,
            disabled,
            hint: t("maxResultsHint"),
            value: current("maxResults"),
            onChange: (text) => edit("maxResults", text === "" ? undefined : Number(text)),
          }),
          h(TextField, {
            label: t("timeoutMs"),
            numeric: true,
            disabled,
            hint: t("timeoutMsHint"),
            value: current("timeoutMs"),
            onChange: (text) => edit("timeoutMs", text === "" ? undefined : Number(text)),
          }),
          h(TextField, {
            label: t("language"),
            disabled,
            value: current("language"),
            onChange: (text) => edit("language", text),
          }),
          h(TextField, {
            label: t("region"),
            disabled,
            hint: t("regionHint"),
            value: current("region"),
            onChange: (text) => edit("region", text),
          }),
          h(TextField, {
            label: t("browserWait"),
            numeric: true,
            disabled,
            hint: t("browserWaitHint"),
            value: current("browser.waitMs"),
            onChange: (text) => edit("browser.waitMs", text === "" ? undefined : Number(text)),
          }),
          h(TextField, {
            label: t("browserIdle"),
            numeric: true,
            disabled,
            hint: t("browserIdleHint"),
            value: current("browser.idleMs"),
            onChange: (text) => edit("browser.idleMs", text === "" ? undefined : Number(text)),
          }),
        ),
        h(TextField, {
          label: t("proxy"),
          disabled,
          hint: t("proxyHint"),
          value: current("proxy"),
          onChange: (text) => edit("proxy", text),
        }),
        h(
          "div",
          { style: S.inlineRow },
          h("span", { style: S.label }, t("safeSearch")),
          h(Switch, {
            label: t("safeSearch"),
            value: current("safeSearch") !== false,
            disabled,
            onChange: (next) => edit("safeSearch", next),
          }),
        ),
      );

      // ── 凭据 ──────────────────────────────────────────────────────────────
      const credentialsCard = h(
        "section",
        { key: "credentials", style: S.card },
        h("h3", { style: S.cardTitle }, t("credentials")),
        h("p", { style: S.hint }, t("credentialsHint")),
        h(TextField, {
          label: t("apiKey"),
          disabled,
          value: Object.prototype.hasOwnProperty.call(draft, "google.apiKey") ? draft["google.apiKey"] : "",
          placeholder: secretSet("google.apiKey") ? t("apiKeySet") : t("apiKeyUnset"),
          hint: t("apiKeyHint"),
          onChange: (text) => edit("google.apiKey", text),
        }),
        h(TextField, {
          label: t("cx"),
          disabled,
          value: current("google.cx"),
          onChange: (text) => edit("google.cx", text),
        }),
        h(TextField, {
          label: t("braveKey"),
          disabled,
          value: Object.prototype.hasOwnProperty.call(draft, "brave.apiKey") ? draft["brave.apiKey"] : "",
          placeholder: secretSet("brave.apiKey") ? t("braveKeySet") : t("braveKeyUnset"),
          hint: t("apiKeyHint"),
          onChange: (text) => edit("brave.apiKey", text),
        }),
      );

      // ── 浏览器取数 ────────────────────────────────────────────────────────
      const browserCard = h(
        "section",
        { key: "browser", style: S.card },
        h("h3", { style: S.cardTitle }, t("browser")),
        h("p", { style: S.hint }, t("browserHint")),
        h(
          "div",
          { style: S.inlineRow },
          h("span", { style: S.label }, t("browserEnabled")),
          h(Switch, {
            label: t("browserEnabled"),
            value: current("browser.enabled") === true,
            disabled,
            onChange: (next) => edit("browser.enabled", next),
          }),
        ),
        h("p", { style: S.hint }, t("browserEnabledHint")),
        h(TextField, {
          label: t("browserExe"),
          disabled,
          hint: t("browserExeHint"),
          value: current("browser.exe"),
          onChange: (text) => edit("browser.exe", text),
        }),
        h(TextField, {
          label: t("browserProxy"),
          disabled,
          hint: t("browserProxyHint"),
          value: current("browser.proxy"),
          onChange: (text) => edit("browser.proxy", text),
        }),
        h(TextField, {
          label: t("browserProfileDir"),
          disabled,
          hint: t("browserProfileDirHint"),
          value: current("browser.profileDir"),
          onChange: (text) => edit("browser.profileDir", text),
        }),
        h(
          "div",
          { style: S.inlineRow },
          h("span", { style: S.label }, t("browserHeadless")),
          h(Switch, {
            label: t("browserHeadless"),
            value: current("browser.headless") !== false,
            disabled,
            onChange: (next) => edit("browser.headless", next),
          }),
        ),
        h("p", { style: S.hint }, t("browserHeadlessHint")),
        h(
          "div",
          { style: S.inlineRow },
          h("span", { style: S.label }, t("browserHeadlessForGoogle")),
          h(Switch, {
            label: t("browserHeadlessForGoogle"),
            value: current("browser.headlessForGoogle") === true,
            disabled,
            onChange: (next) => edit("browser.headlessForGoogle", next),
          }),
        ),
        h("p", { style: S.hint }, t("browserHeadlessForGoogleHint")),
        h(
          "div",
          { style: S.inlineRow },
          h("span", { style: S.label }, t("browserVerbose")),
          h(Switch, {
            label: t("browserVerbose"),
            value: current("browser.verbose") === true,
            disabled,
            onChange: (next) => edit("browser.verbose", next),
          }),
        ),
      );

      // ── 高级 ──────────────────────────────────────────────────────────────
      const advancedCard = h(
        "details",
        { key: "advanced", style: S.card },
        h("summary", { style: S.summary }, t("advanced")),
        h(TextField, {
          label: t("bingBaseUrl"),
          disabled,
          value: current("bing.baseUrl"),
          onChange: (text) => edit("bing.baseUrl", text),
        }),
        h(TextField, {
          label: t("duckduckgoBaseUrl"),
          disabled,
          value: current("duckduckgo.baseUrl"),
          onChange: (text) => edit("duckduckgo.baseUrl", text),
        }),
        h(TextField, {
          label: t("duckduckgoRegion"),
          disabled,
          value: current("duckduckgo.region"),
          onChange: (text) => edit("duckduckgo.region", text),
        }),
        h(TextField, {
          label: t("mojeekBaseUrl"),
          disabled,
          value: current("mojeek.baseUrl"),
          onChange: (text) => edit("mojeek.baseUrl", text),
        }),
        h(TextField, {
          label: t("googleBaseUrl"),
          disabled,
          value: current("google.baseUrl"),
          onChange: (text) => edit("google.baseUrl", text),
        }),
        h(TextField, {
          label: t("googleWebBaseUrl"),
          disabled,
          value: current("google.webBaseUrl"),
          onChange: (text) => edit("google.webBaseUrl", text),
        }),
        h(TextField, {
          label: t("braveBaseUrl"),
          disabled,
          value: current("brave.baseUrl"),
          onChange: (text) => edit("brave.baseUrl", text),
        }),
        ...ENGINES.map((engineId) =>
          h(TextField, {
            key: `${engineId}-proxy`,
            label: `${t("engineProxy")} ${engineId}`,
            disabled,
            value: current(`${engineId}.proxy`),
            onChange: (text) => edit(`${engineId}.proxy`, text),
          }),
        ),
        h(TextField, {
          label: t("officialProviderId"),
          disabled,
          value: current("officialProviderId"),
          onChange: (text) => edit("officialProviderId", text),
        }),
        h(
          "div",
          { style: S.inlineRow },
          h("span", { style: S.label }, t("bingRss")),
          h(Switch, {
            label: t("bingRss"),
            value: current("bing.rss") !== false,
            disabled,
            onChange: (next) => edit("bing.rss", next),
          }),
        ),
        h(
          "div",
          { style: S.inlineRow },
          h("span", { style: S.label }, t("googleHtmlFallback")),
          h(Switch, {
            label: t("googleHtmlFallback"),
            value: current("google.allowHtmlFallback") === true,
            disabled,
            onChange: (next) => edit("google.allowHtmlFallback", next),
          }),
        ),
      );

      const footer = h(
        "div",
        { key: "actions", style: S.actions },
        h(
          "button",
          {
            type: "button",
            disabled: disabled || saving || dirty === false,
            onClick: submit,
            style: { ...S.primaryButton, ...(disabled || saving || dirty === false ? S.disabledButton : {}) },
          },
          saving ? t("saving") : t("save"),
        ),
        h(
          "button",
          {
            type: "button",
            disabled: disabled || dirty === false,
            onClick: () => {
              setDraft({});
              setFailure("");
            },
            style: { ...S.ghostButton, ...(disabled || dirty === false ? S.disabledButton : {}) },
          },
          t("discard"),
        ),
        h(
          "button",
          {
            type: "button",
            disabled: disabled || saving,
            onClick: () => {
              setDraft({});
              props.reload();
            },
            style: { ...S.ghostButton, ...(disabled || saving ? S.disabledButton : {}) },
          },
          t("reload"),
        ),
        failure ? h("span", { style: S.error }, failure) : null,
        failure === "" && savedAt > 0 && dirty === false ? h("span", { style: S.success }, t("saved")) : null,
      );

      return h(
        "div",
        { style: S.page },
        ...header,
        state.writable === true ? null : h("p", { style: S.hint }, t("readOnly")),
        engineCard,
        officialCard,
        tuningCard,
        browserCard,
        credentialsCard,
        advancedCard,
        footer,
      );
    }

    /** 浏览器侧插件入口。 */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS);
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "web-search-multi: dictionaries");

      const store = createStore({
        ready: false,
        served: false,
        writable: false,
        error: "",
        ns: undefined,
        values: {},
        secrets: [],
        revision: undefined,
      });

      const describe = async () => {
        let response;
        try {
          const settings = ctx.remote?.settings;
          if (settings === undefined) {
            store.set({ ...store.getSnapshot(), ready: true, error: "remote.settings unavailable" });
            return;
          }
          response = await settings.describe();
        } catch (error) {
          store.set({ ...store.getSnapshot(), ready: true, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        if (response === undefined || response.ok !== true) {
          store.set({ ...store.getSnapshot(), ready: true, error: response?.error?.message ?? "settings/describe failed" });
          return;
        }
        const namespaces = response.value?.namespaces ?? [];
        // 行 id 在 settings 里可能带 `include:` 前缀（取决于该行来自哪一层 patch），
        // 所以按"精确 → 后缀 → 含子串 → schema 里有 preferOfficial"逐级认领。
        const view =
          namespaces.find((row) => row.ns === SETTINGS_NS) ??
          namespaces.find((row) => typeof row.ns === "string" && row.ns.endsWith(`:${SETTINGS_NS}`)) ??
          namespaces.find((row) => typeof row.ns === "string" && row.ns.includes(SETTINGS_NS)) ??
          namespaces.find((row) => JSON.stringify(row.schema ?? {}).includes("preferOfficial"));
        store.set({
          ready: true,
          served: view !== undefined,
          writable: response.value?.writable === true,
          error: view === undefined ? `served namespaces: ${namespaces.map((row) => row.ns).join(", ") || "(none)"}` : "",
          ns: view?.ns,
          values: view?.value ?? {},
          secrets: view?.secrets ?? [],
          revision: view?.revision,
        });
      };

      const save = async (ops) => {
        const snapshot = store.getSnapshot();
        const response = await ctx.remote.settings.mutate(snapshot.ns ?? SETTINGS_NS, ops, snapshot.revision);
        if (response === undefined || response.ok !== true) return false;
        await describe();
        return true;
      };

      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "web-search",
                order: 17,
                label: () => t("title"),
                locale: LOCALE_NS,
                inject: () => ({
                  hooks: { webSearchMulti: store },
                  save,
                  reload: () => {
                    describe();
                  },
                }),
              },
              SearchSettingsPage,
            ),
          ),
        "web-search-multi: settings page",
      );

      describe();
    }

    return { apply, inject: ["slots", "locale", "remote", "remote.settings"] };
  },
});
