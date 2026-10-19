# dsh-web-search-engine

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

用 **Bing / DuckDuckGo / Mojeek / Google / Brave** 替换 DeepSeek Harness（DSH）默认的网络搜索，
默认把**多个引擎的结果混合**后交给模型，并带一个可视化设置页。其中三个引擎
（`brave-web` / `ddg-web` / `google-web`）走**无头浏览器**取数。

零 npm 运行依赖（只声明 `@deepseek-ai/schemastery` 写配置 schema），
浏览器取数直接用 Node 内置 `WebSocket` 驱动本机 Chrome/Edge，**不需要 puppeteer / playwright**。

> 这是一个 DSH（DeepSeek Harness）插件，靠 DSH 的 Cordis 插件机制加载。
> 与 DeepSeek、Bing、Google、DuckDuckGo、Mojeek、Brave 官方均无关联。

## 它做什么

向 `ctx.web` 注册一个搜索 provider（id：`web-search-multi`），并把 profile 里
`web` 行的 `searchProvider` 指向它。模型侧的 `web_search` 工具本身不变——变的只是
"这个搜索由谁去执行"。

- **混合模式（默认 `mode: merge`）**：并行问所有启用的引擎，按名次轮转混合、按 URL 去重。
  某个引擎挂了/被墙/要验证码都不会拖垮整次搜索，到总预算（`timeoutMs`）就用已经拿到的结果。
- **按顺序模式（`mode: fallback`）**：第一个出结果的引擎胜出。
- **优先官方（`preferOfficial`）**：可开关，开着先问官方 DeepSeek provider，失败自动回退到引擎。
- **浏览器取数**：需要真实浏览器的引擎（`brave-web` / `ddg-web` / `google-web`）由本机
  Chrome/Edge 渲染后提取，不需要 puppeteer/playwright。
- 每个引擎可单独配代理，也可以全局共用一个代理。
- **设置页**：设置 → 搜索，勾选引擎、调顺序、填代理与凭据，保存即生效。

## 引擎

| id | 取数方式 | 状态 |
|---|---|---|
| `bing` | 抓 `bing.com/search` 结果页；解析不到退回 Bing RSS | ✅ 直连可用，中文结果 |
| `duckduckgo` | 抓 `html.duckduckgo.com/html/`，解码 `uddg=` 跳转 | ✅ 走代理可用；直连通常被墙 |
| `mojeek` | 抓 `mojeek.com/search`（独立索引） | ⚠️ 部分出口 IP 被要求人机验证（403/Captcha），只报错不影响其它引擎 |
| `google` | 官方 Programmable Search JSON API（需 key + cx） | ❌ 抓页被 Google 的 JS 门挡住；官方 API **已对新客户关闭**（见下） |
| `brave` | 官方 Brave Search API（需 key） | ⚠️ 未实测（需要 key） |
| `brave-web` | **无头浏览器**渲染 `search.brave.com` | ❌ 2026-10-19 复测：返回空页面 / 0 条（该出口 IP 被持续拦截，20 天未恢复）；代码保留，换 IP 可再试 |
| `ddg-web` | **无头浏览器**渲染 `duckduckgo.com` | ✅ 比 HTML 版稳，2.4~9s；0.2.1 + Chrome 155 复测仍出 10 条 |
| `google-web` | **无头浏览器**渲染 `google.com` | ⚠️ 只有**有头**模式能过，且连续搜索会被限流 |

每个引擎都能单独指定代理（`<engine>.proxy`），没指定就回落到全局 `proxy`。
这样可以让 Bing 直连（拿中文结果）、DuckDuckGo/Google 走本地代理。

### Bing 为什么忽略全局代理

直连时 Bing 会把 `www.bing.com` **302 到 `cn.bing.com`**（中文版）；走代理时会**停在
`www.bing.com`**（国际版）。两者对同一个中文查询的结果可以差很多，实测同一台机器：

| 查询 | 直连（cn.bing） | 走代理（www.bing） |
|---|---|---|
| 我的世界红石比较器 | **0.44s**，6 条，结果正确 | 2.1s，6 条，前 3 条是「我」字的词典结果 |
| 我的世界红石比较器怎么用 | **0.40s**，6 条，前 2 条噪音 | 3.6s，6 条，前 3 条噪音 |
| 红石比较器 my world | **0.40s**，正常 | 2.4s，正常 |

结论：**直连永远更快（0.4s vs 2~3.5s）**，而且对部分中文查询才不会被国际版降级。
所以**没显式配 `bing.proxy` 时 Bing 一律直连**，不跟随全局 `proxy`；要强制走代理就设 `bing.proxy`。

> 顺带说明：Bing 对中文查询会自己分词，有时整份结果都跑偏。例如
> 「怎么给 dsh 写插件」返回的全是「怎么」「如何」的释义页，和 dsh/插件毫无关系。
> 这是 Bing 的 `b_algo` 真实结果（`curl` 抓同一页能逐条对上），**不是解析错误**。
>
> 插件对此加了一道**相关性守卫**：查询里带 ASCII 词（`dsh` / `deepseek` / `rust` 这类）时，
> 至少有一个要出现在结果的标题/URL/摘要里，否则把这个引擎算作失败——
> 混合模式下正好由其它引擎顶上。实测「怎么给 dsh 写插件」Bing 被判无关后，
> DuckDuckGo 直接给出了 8 条正确结果。
>
> 守卫**只拦"ASCII 词全未命中"**这一种极端情况，纯中文查询不拦——中文查询和结果标题
> 常常只是部分重合（「我的世界红石比较器」vs 标题「红石比较器 - 中文 Minecraft Wiki」），
> 按中文片段判会误杀好结果。所以纯中文的跑偏属于**已知局限**，不会自动拦截。
> 想让模型问得更准，可以在 agent instructions 里提示它"中文查询尽量别用空格分词"。

## 浏览器取数

有些引擎只认真实浏览器——Google 对普通 HTTP 客户端返回"需要 JavaScript"占位页，
Brave / Ecosia 直接 403/429。本插件用一个**常驻的无头浏览器**去取这些引擎的结果。

- 直接驱动 Chrome / Edge 的 DevTools Protocol，用 Node ≥ 22 内置的 `WebSocket`；
- 常驻一个实例 + 一个 tab，靠 `Page.navigate` 复用渲染进程：
  **冷启动约 1s，之后单次搜索 0.7~3.5s**（实测）；
- 空闲 `browser.idleMs` 后自动关掉浏览器，不常驻占内存；
- 结果在页面内用 CSS 选择器提取，只回传标题/链接/摘要，不搬整页 HTML。

在设置 → 搜索 → **浏览器取数**里开启，然后勾选 `brave-web` / `ddg-web` / `google-web`。

| 项 | 字段 | 说明 |
|---|---|---|
| 开启浏览器取数 | `browser.enabled` | 三个 `*-web` 引擎的总开关。 |
| 浏览器可执行文件 | `browser.exe` | 留空自动探测 Chrome → Edge。 |
| 无头模式 | `browser.headless` | 关掉会弹出可见窗口。 |
| google-web 有头模式 | `browser.headlessForGoogle` | 见下。 |
| 浏览器专用代理 | `browser.proxy` | 留空用全局 `proxy`。 |
| profile 目录 | `browser.profileDir` | 填了可跨搜索复用 Cookie。 |
| 空闲回收 | `browser.idleMs` | 毫秒，0 = 不自动关。 |
| 单引擎等待 | `browser.waitMs` | 超时就放弃该引擎，那一轮后台继续跑。 |
| 日志 | `browser.verbose` | 打到 Host 控制台。 |

### Google 只有"有头"能过

实测同一台机器、同一条代理：

| 模式 | 结果 |
|---|---|
| 无头 | **必跳** `/sorry/index`（人机验证）——直连和走代理都一样；预热（先开首页、点同意、在搜索框输入回车）也没用 |
| 有头（`headlessForGoogle: true`） | **能出结果**：title 是「… - Google 搜索」，9 个结果锚点 |

但有头模式也会**很快被限流**：同一 profile 连搜两次，第二次就跳 `/sorry/index`。

所以 `google-web` 默认不启用；想试就打开「google-web 有头模式」，并且**别连着搜**。
日常更建议用 `brave-web`。

### 关于限流

搜索类站点都会对自动化流量限流，这是**上游行为，不是插件的 bug**。实测：

- `brave-web`：连续 5 次查询正常（0.7~2.7s，每次 20 条）；累计约 20+ 次后开始返回空白壳页，
  被限流后至少要几十分钟才恢复（实测 3 分钟仍未恢复）。
- `ddg-web`：测得较宽松。
- Ecosia / Yandex / `mojeek`：纯 HTTP 和浏览器**都被真验证码挡住**，无解，不建议用。
- 被限流时插件会明确报"被目标站点拦截"，而不是含糊的"没解析出结果"。

要降风险：`browser.profileDir` 填一个持久目录（复用 Cookie）、勾多个 `*-web` 引擎互为备份、
别把 `maxResults` 调太大导致频繁翻页。


## Google 的现实约束

Google 对非浏览器客户端**统一返回"需要 JavaScript"的占位页**：

- 直连：`www.google.com` / `www.googleapis.com` 都不通（连接超时）。
- 走代理：能连上，但 `plain`、`udm=14`、`ncr+hl`、`gbv=1`、移动端 UA、带 consent cookie
  等变体**全部**返回同一个 JS 占位页（HTML 里没有任何结果锚点）。
- 因此 Google 只有官方 API 一条路——但**这条路对新客户已经关闭**：
  [Custom Search JSON API 概览](https://developers.google.cn/custom-search/v1/overview?hl=zh-cn)
  明确写着"不再向新客户开放"，现有客户须在 **2027-01-01** 前迁移；
  [Programmable Search Element 付费 API](https://developers.google.cn/custom-search/docs/paid_element?hl=zh-cn)
  同样不再向新客户提供。旧教程"建 PSE 拿 cx → 开 Custom Search API 拿 key"对新账号已失效。

所以：

- **已有老 key 的人**：填 `google.apiKey` + `google.cx` 即可用（到 2027-01-01 前）。
- **新客户**：拿不到这个 API。想要 Google 结果有三条路：
  1. `google-web` + 有头模式（见上）——能出结果但会被限流，适合偶尔用；
  2. SERP 转售服务（Serper / SerpApi / SearchApi 之类），它们替你抓取并返回 JSON——
     本插件未内置，照 `lib/engines.js` 里 Google/Brave 的写法加一个引擎即可；
  3. 换 `brave-web`（见下）——不需要 key，实测最稳，虽然不是 Google 的索引。
- **Brave Search API** 是现成的非 Google 替代：填 `brave.apiKey` 就多一路独立索引；
  不填 key 也可以用 `brave-web`（浏览器取数）。
- 没配凭据时 Google / Brave 会被**跳过**（不浪费预算）；想硬试抓页可以打开
  `google.allowHtmlFallback`。

## 安装

```
plugin_manager action=install_bundle target=<本目录绝对路径>
```

或者直接从 GitHub 拿：

```
git clone https://github.com/Gaozx1/dsh-web-search-engine.git
```

（`node_modules` 未入库：`@deepseek-ai/schemastery` 由 profile 自带；
要在离线环境里装，先在本目录跑一次 `npm install`。）

安装即启用，patch 会同时插入插件行、把 `web` 行指向新 provider。
装完**刷新一次页面**（F5），客户端半边才会进 Web 的模块图、设置页才会出现。

改回默认搜索：把 patch 里 `web` 行的 `searchProvider` 改成 `deepseek-official`，
或在 profile 的 `cordis.patch.yml` 里再覆盖一次（用户层优先级更高）。

## 设置页

装好后打开 **设置 → 搜索**：

| 界面项 | 配置字段 | 说明 |
|---|---|---|
| 结果组合方式 | `mode` | 混合所有引擎 / 按顺序尝试。 |
| 引擎与顺序 | `engines` | 勾选要问的引擎，↑↓ 调顺序（决定混合时同名次的先后）。 |
| 优先使用官方搜索 | `preferOfficial` | 先问官方，失败回退引擎。 |
| 每个引擎取多少条 | `maxResults` | 1~20；混合后总条数更多。 |
| 总预算 | `timeoutMs` | 混合模式到点就用已拿到的结果。 |
| 语言 / Bing 市场 / 安全搜索 | `language` / `region` / `safeSearch` | |
| 默认代理 | `proxy` | 所有引擎共用（Bing 除外，见上）；各引擎可在高级里单独指定。 |
| 浏览器取数 | `browser.*` | 见上表。 |
| 凭据 | `google.apiKey` / `google.cx` / `brave.apiKey` | secret 字段读不回，只显示"是否已配置"。 |
| 高级 | 各引擎 baseUrl、各引擎 proxy、`bing.rss`、`officialProviderId`、`google.allowHtmlFallback` | 折叠区。 |

保存后**立刻生效**：插件每次搜索都重新读配置，写进 profile 的 `cordis.patch.yml`
（用户层，优先级高于插件自带的 bundle 补丁）。

## 结果怎么混

1. 每个引擎取 `maxResults` 条；
2. 按"名次轮转"合并：所有引擎的第 1 名、再所有引擎的第 2 名……；
3. 按 URL 去重；
4. 交给 `web_search` 工具，由它按自己的 `searchMaxResults`（默认 8）再截一次。

所以模型看到的通常是"几个引擎各自的前几名"。想让模型看到更多，把 agent preset 里
`tool-web` 行的 `searchMaxResults` 调大（例如 12/16）。

## 验证状态

### DSH 0.2.1-alpha.4（Windows + Chrome 155）

- Host 半边**无需改动即可运行**：`ctx.web.registerSearchProvider` 的
  `WebSearchProvider` 契约（`id` / `available()` / `search(request, signal)`）与 0.1.7 一致；
  `schemastery` 3.18.5 仍提供 `volatile()` / `role()`；`settings/describe` 与
  `settings/update` 这两个 remote 端点签名未变。
- 实测：`bing` + `duckduckgo` + `ddg-web` 混合返回正常；`ddg-web` 在 Chrome 155 上仍出 10 条。
- 配置在 profile patch 里改完**下一次搜索立刻生效**（已用「只开 ddg-web + 关浏览器取数」
  的临时配置验证过：报错精确变成"浏览器取数未开启"，说明热加载确实发生）。
- 设置页需要**刷新页面**才会出现（客户端模块在页面启动时进模块图）。

### DSH 0.1.7-rc.1（Windows + Chrome 153）

- 混合模式：Bing + DuckDuckGo 的结果**交替出现**，1.4s 左右返回，比单引擎信息面更宽。
- **浏览器取数**：`brave-web` 单次 1.5~3.5s 出 20 条；连续 5 次查询不限流（0.7~2.7s）。
  浏览器实例冷启动约 1s，之后复用同一 tab。DDG 主站渲染出 10 条。
- **有头模式过 Google**：`google-web` + `headlessForGoogle` 返回真实结果页（9 个锚点），
  无头模式必被拦。
- Bing 直连 vs 走代理的差异（见上）已复现并修掉：同一个中文查询直连/走代理都返回正确结果。
- **相关性守卫**：查询带 ASCII 词但结果全不沾边时该引擎判失败（实测「怎么给 dsh 写插件」
  被拦后由 DuckDuckGo 顶上，返回 8 条正确结果）；纯中文查询不拦，避免误杀。
  单元测试 8/8 通过。
- URL 去重跨引擎生效（`www.deepseek.com/harness/en/` 与 `deepseek.com/harness/en` 归一）。
- DuckDuckGo 经代理可用；Mojeek 被要求验证码时只报错、不拖垮整次搜索。
- 单引擎不可用（例如 DuckDuckGo 不配代理）时，混合模式仍在总预算内返回其它引擎的结果。
- 按顺序模式行为与之前一致；`preferOfficial` 开着时官方 provider 直接给出结果，
  `officialProviderId` 指向不存在的 id 时自动回退到引擎。
- Google 官方 API 路径用本地假服务验证了 URL 构造、JSON 解析与去重。

未验证 / 有保留：

- `mojeek` 的解析器在作者本机**无法实测**（出口 IP 直接吃 403/Captcha），只做了多写法兜底；
  浏览器路径也被真验证码挡住。
- `brave` / `google` 的**官方 API** 未实测（需要 key）；JSON 解析逻辑两者同构。
- 真实 Google API key 下的线上调用。
- **`brave-web` 已不可用**：截至 2026-10-19 实测（Chrome 155 + 同一出口），
  `search.brave.com` 返回空 body、0 条结果，20 天后仍未恢复。看起来不是临时限流，
  而是该出口 IP 被持续拦截（也可能是新版 Chrome 的无头特征被识别）。用 `ddg-web` 代替。
- 纯中文查询的跑偏（Bing 把「怎么」当词）不会自动拦截，属于已知局限。

> 客户端半边改动后**必须刷新页面**才会生效（Web 的模块图在页面加载时确定）；
> Host 半边改文件则由 HMR 热重载，不必重启（已验证 profile patch 的改动会立即生效）。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `configured web provider "web-search-multi" is not registered` | 插件行没激活（配置非法或文件缺失）。看 Host 日志里 `web-search-multi 配置有误：...`。 |
| 报错里出现 `要求人机验证` / `判定为自动化流量` | 该引擎的出口 IP 被挡，换代理或换个引擎。 |
| 报错里出现 `被目标站点拦截` | 浏览器引擎被限流/验证码。停一会儿、换 `browser.proxy`、或换别的引擎。 |
| 报错里出现 `浏览器取数未开启` | 勾了 `*-web` 但没开 `browser.enabled`。 |
| 报错里出现 `没有找到 Chrome/Edge` | 设 `browser.exe` 为浏览器的绝对路径。 |
| `google-web` 总是跳 `sorry` 页 | 无头模式过不了 Google；打开 `browser.headlessForGoogle`。 |
| 报错里出现 `需要 JavaScript 的占位页` | Google 无凭据路径不可用，见上。 |
| 报错里出现 `ETIMEDOUT` / `请求超时` | 目标站点不可达，给该引擎配代理。 |
| 每次搜索都要等满 `timeoutMs` | 有引擎不可达且在吃预算：把它取消勾选，或给它单独配代理。 |
| 结果变少或为空 | 结果页结构可能调整；Bing 保持 `bing.rss: true` 可退回 RSS 通道。 |

## 文件结构

```
package.json          清单：dsh.bundle.patch / dsh.client 指向下面的文件
cordis.patch.yml      插入插件行 + 覆盖 web 行 + 默认配置
lib/host.js           Host 半边：配置 schema、provider 注册、引擎调度、混合/回退、优先官方
lib/engines.js        各引擎的请求与结果解析 + 名次轮转混合
lib/browser.js        无头浏览器取数：零依赖 CDP 客户端 + 常驻实例池 + 结果提取
lib/http.js           取数层：node:https 直连 / 零依赖 CONNECT 代理隧道 + 手动跟随重定向
lib/text.js           HTML 实体、标签清洗、URL 归一与去重
lib/client.js         浏览器半边：设置 → 搜索 那一页
locale/{zh,en}.json   插件卡片文案
icon.svg              插件图标
```

## 为什么不用 `globalThis.fetch`

本插件的取数走 `node:http` / `node:https`。原因是实测：DSH 宿主进程里
`globalThis.fetch` 返回的响应**头部为空、正文是乱码**（同一个 URL 在子进程里完全正常），
于是 `redirect: "follow"` 也跟不动跳转。根因是 `@deepseek-ai/dsh-http-proxy` 把一份
userland undici 的 `Agent` 写进了 Node 的全局 dispatcher 槽位，与 Node 内置 fetch 自带的
undici 版本不一致。走 `node:https` 完全绕开它。

## 许可

MIT。取数用的是各引擎的公开结果页与公开 API；请自行遵守目标站点的服务条款与 robots 约定。
