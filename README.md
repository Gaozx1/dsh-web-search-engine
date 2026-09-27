# dsh-web-search-engine

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

用 **Bing / DuckDuckGo / Mojeek / Google / Brave** 替换 DeepSeek Harness（DSH）默认的网络搜索，
默认把**多个引擎的结果混合**后交给模型，并带一个可视化设置页。

零 npm 运行依赖（只声明 `@deepseek-ai/schemastery` 写配置 schema）。

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

每个引擎都能单独指定代理（`<engine>.proxy`），没指定就回落到全局 `proxy`。
这样可以让 Bing 直连（拿中文结果）、DuckDuckGo/Google 走本地代理。

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
- **新客户**：想要 Google 结果只能走 SERP 转售服务（Serper / SerpApi / SearchApi 之类）——
  本插件未内置，照 `lib/engines.js` 里 Google/Brave 的写法加一个引擎即可。
- **Brave Search API** 是现成的非 Google 替代：填 `brave.apiKey` 就多一路独立索引。
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
| 默认代理 | `proxy` | 所有引擎共用；各引擎可在高级里单独指定。 |
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

在作者本机 profile（DSH 0.1.7-rc.1）上实测通过：

- 混合模式：Bing + DuckDuckGo 的结果**交替出现**，1.4s 左右返回，比单引擎信息面更宽。
- DuckDuckGo 经代理可用（只开它时返回 6 条）；Mojeek 被要求验证码时只报错、不拖垮整次搜索。
- 单引擎不可用（例如 DuckDuckGo 不配代理）时，混合模式仍在总预算内返回 Bing 的结果。
- 按顺序模式行为与之前一致；`preferOfficial` 开着时官方 provider 直接给出结果，
  `officialProviderId` 指向不存在的 id 时自动回退到引擎。
- 配置热更新：改 profile patch 里的行配置后，下一次搜索立刻按新配置执行。
- Google 官方 API 路径用本地假服务验证了 URL 构造、JSON 解析与去重。

未验证 / 有保留：

- `mojeek` 的解析器在作者本机**无法实测**（出口 IP 直接吃 403/Captcha），只做了多写法兜底。
- `brave` 引擎未实测（需要 API key）；JSON 解析逻辑与 Google API 同构。
- 真实 Google API key 下的线上调用。

> 客户端半边改动后**必须刷新页面**才会生效（Web 的模块图在页面加载时确定）；
> Host 半边改文件则由 HMR 热重载，不必重启。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `configured web provider "web-search-multi" is not registered` | 插件行没激活（配置非法或文件缺失）。看 Host 日志里 `web-search-multi 配置有误：...`。 |
| 报错里出现 `要求人机验证` / `判定为自动化流量` | 该引擎的出口 IP 被挡，换代理或换个引擎。 |
| 报错里出现 `需要 JavaScript 的占位页` | Google 无凭据路径不可用，见上。 |
| 报错里出现 `ETIMEDOUT` / `请求超时` | 目标站点不可达，给该引擎配代理。 |
| 每次搜索都要等满 `timeoutMs` | 有引擎不可达且在吃预算：把它取消勾选，或给它单独配代理。 |
| 结果变少或为空 | 结果页结构可能调整；Bing 保持 `bing.rss: true` 可退回 RSS 通道。 |

## 文件结构

```
package.json          清单：dsh.bundle.patch / dsh.client 指向下面的文件
cordis.patch.yml      插入插件行 + 覆盖 web 行 + 默认配置
lib/host.js           Host 半边：配置 schema、provider 注册、引擎调度、混合/回退、优先官方
lib/engines.js        五个引擎的请求与结果解析 + 名次轮转混合
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
