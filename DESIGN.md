# WebCopy 设计方案

**项目名**：WebCopy
**一句话**：把 URL 链接指向的文章"原味"转换成 Markdown 文件的 CLI 工具。
**当前阶段**：Phase 5 完成（Web UI + GitHub Actions CI + GHCR 构建）；Phase 3-a/b/c/d、Phase 4 均已交付；VS Code 扩展 / 水印去除 / 图片压缩 待规划

---

## 1. 目标与非目标

### 1.1 目标（MVP 范围内）

- 输入一个 URL（或批量 URL），输出同名 `.md` 文件。
- 尽量"原味"保留原文结构：标题层级 / 段落 / 列表 / 引用 / 代码块（带语言）/ 表格 / 图片 / 链接。
- 文件头附加元信息（标题、作者、来源、抓取时间）。
- CLI 优先，交互清晰。

### 1.2 非目标（MVP 阶段明确排除）

- 不破解付费墙 / 反爬 JS 挑战。
- 不做图片本地化下载（保留远程 URL）——Phase 3-c 后升级为**可选**（`--localize-images` 开启）；默认关闭以保持 MVP 快速路径。
- 不做微信 / 知乎等专有平台深度适配（先靠 Readability 兜底）——Phase 3-a/3-b 已落地 GitHub README / 知乎 / 微信公众号 / 掘金 四个适配器，后续按需追加。
- 不做持久化数据库、账号系统、Web UI。

---

## 2. 技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript + Node.js ≥ 20 | 类型安全；社区生态；后续可扩展为 Web 端 |
| HTML 解析 | `cheerio` | 稳定，Mozilla Readability 官方支持 |
| 正文抽取 | `@mozilla/readability` | 业界标杆，正文识别准 |
| HTML → MD | `turndown` + `turndown-plugin-gfm` | 支持表格 / 脚注 / 代码块语言 |
| HTTP | Node 内置 `fetch` + `iconv-lite` | 内置 fetch 免依赖；iconv-lite 处理 GBK / GB2312 / Shift-JIS 等非 UTF-8 编码 |
| CLI | `commander` | 简单够用 |
| 测试 | `vitest` | 快，TS 无缝 |
| 构建 | `tsup` | CLI 单文件产物，clean |

---

## 3. 核心处理管线

```
URL
 └─ fetcher(url)                    # UA 伪装 + 超时 + 编码探测
     └─ extractor(html)             # Readability 抽正文
         └─ preprocessor(html)      # 保留 code[data-lang] / 处理相对 img / 清洗 span
             └─ converter(html)     # turndown + 自定义规则
                 └─ meta.md(...)    # 注入 YAML front-matter
                     └─ 落盘 .md
```

### 3.1 关键实现要点（"原味"的关键坑）

1. **代码块语言**：GitHub / 掘金 / V2EX 等用 `<pre><code class="language-js">` 或 `data-lang`，turndown 默认会丢，必须写自定义 rule。
2. **表格**：必须启用 `turndown-plugin-gfm` 的 `GFM.table`，否则输出乱。
3. **图片相对路径**：转成绝对 URL（`new URL(src, pageUrl).href`）。
4. **锚点链接**：`#xxx` 保持原样，不要拼成完整 URL。
5. **多余包裹**：清理无信息的 `<div>` / `<span>`，避免 MD 中出现奇怪的换行。
6. **数学公式 / KaTeX**：MVP 不处理，遇到 `<math>` 或 `.math` 类直接跳过或输出纯文本。

---

## 4. 目录结构

```
webcopy/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── DESIGN.md
├── AGENTS.md
├── README.md
├── src/
│   ├── index.ts              # CLI 入口（可执行）
│   ├── cli.ts                # commander 定义
│   ├── pipeline.ts           # URL → MD 主流程（编排）
│   ├── fetcher.ts            # 抓取（UA / 超时 / 重试）
│   ├── extractor.ts          # Readability 封装
│   ├── converter.ts          # turndown + 规则注册
│   ├── images.ts             # 图片本地化（SHA1 去重 + 扩展名推断）
│   ├── meta.ts               # YAML front-matter 生成
│   ├── fs.ts                 # 文件名清洗 + 落盘
│   ├── adapters.ts           # 适配器注册表
│   ├── adapters/             # 各平台专用抽取器
│   │   ├── github-readme.ts
│   │   ├── zhihu.ts
│   │   ├── wechat.ts
│   │   └── juejin.ts
│   └── rules/                # turndown 自定义规则
│       ├── code-block.ts
│       ├── image.ts
│       └── link.ts
├── tests/
│   ├── fixtures/             # 抓取的原始 HTML 样本
│   │   ├── blog-post.html
│   │   ├── docs-with-code.html
│   │   └── table-heavy.html
│   ├── converter.test.ts
│   ├── rules.test.ts
│   ├── pipeline.test.ts      # 集成测试，mock fetch
│   ├── images.test.ts        # 图片本地化（extractImageUrls / localizeImages）
│   └── adapters.test.ts      # 各平台适配器单元测试
└── output/                   # 默认输出目录（进 .gitignore）
```

---

## 5. CLI 使用形态

```bash
# 单 URL，输出到当前目录
npx webcopy https://example.com/article

# 单 URL，指定输出目录
npx webcopy https://example.com/article --out ./output

# 批量模式：从文件读取 URL 列表（每行一个）
npx webcopy --file urls.txt --out ./output

# 交互式：一次传多个 URL
npx webcopy https://a.com https://b.com --out ./output
```

**选项**：
- `--out <dir>`：输出目录，默认 `./output`
- `--file <path>`：从文件读取 URL 列表
- `--overwrite`：覆盖已存在的同名文件（默认跳过）
- `--verbose`：输出调试信息
- `--help` / `--version`

---

## 6. 输出格式

```md
---
title: "文章标题"
author: "作者名（如可获取）"
source: "https://original-url"
fetched_at: "2026-10-01T08:34:00.000Z"
---

# 文章标题

这里是正文……
```

---

## 7. 测试策略

按 `AGENTS.md` 要求：**每次改动都必须有对应测试**。

- **单元测试**：`converter` / `meta` / `rules/*` 都独立测（输入 HTML → 断言 MD 输出片段）。
- **Fixture 测试**：至少 3 份真实抓取样本，断言关键结构（标题层级 / 代码块语言 / 表格）未被破坏。
- **集成测试**：完整跑 `pipeline(url)`，用 mock fetch 隔离网络，不污染 CI。
- **网络层**：CI 里 mock，本地手动 smoke test 验证真站可抓取。
- **验收指标**：
  - `npm test` 100% 通过
  - `npm run build` 产物可执行
  - Fixture 覆盖 3 类页面且断言通过

---

## 8. 分阶段交付

### Phase 1（MVP，✅ 已交付）

- [x] 脚手架：tsup + vitest + commander + 依赖安装
- [x] 管线跑通：fetch → Readability → turndown → 落盘
- [x] 3 个 turndown 自定义规则：code-block / image / link
- [x] CLI：单 URL + 批量 URL + `--out` + `--overwrite` + `--file`
- [x] 37 个测试用例，覆盖主要场景
- [x] `README.md`：安装 / 使用 / 示例输出

### Phase 2（✅ 已交付）

- [x] YAML front-matter 完整字段（title / author / site / source / fetched_at）
- [x] 批量模式 + 失败重试（指数退避，429/5xx/timeout/network 才重试）
- [x] 编码探测（HTTP header → meta charset → meta http-equiv → UTF-8 兜底；iconv-lite 解码 GBK/GB2312/Shift-JIS/ISO-8859-1）
- [x] 友好错误分类（`errorCode`：timeout / network / http / no-article / filesystem / redirect-loop / unsupported-type），CLI 输出带 `[hint]`
- [x] 错误路径测试补齐（timeout / 429 重试 / 404 不重试 / empty body）
- [x] 50 个测试用例（Phase 1 的 37 + Phase 2 新增 13：10 fetcher + 3 pipeline 补充）

### Phase 3-a（✅ 已交付）

- [x] 适配器接口 `ArticleAdapter`（`match` / `resolveFetchUrl?` / `extract`）+ `AdapterRegistry`
- [x] GitHub README 适配器：`github.com/{owner}/{repo}/blob/...` → `raw.githubusercontent.com/...`，直接返回原始 markdown 跳过 converter
- [x] 知乎适配器：`/question/{id}/answer/{id}` + `/p/{id}` + `/answer/{id}`；从 `QuestionRichText` / `Card-content` 等容器抽取；重写 lazy-load 图片 `data-src → src`；剔除投票按钮、分享条等噪声
- [x] Pipeline 集成：适配器命中时绕过 Readability；`--no-adapters` CLI 开关
- [x] 适配器单元测试（14 用例）+ pipeline 集成测试（+2 用例）；总计 72 用例

### Phase 3-b（✅ 已交付）

- [x] 微信公众号适配器（`mp.weixin.qq.com/s/*`）：从 `#js_content` 抽取，`data-src → src`（含 SVG 占位符），标题取 `#activity-name`、作者取 `#js_author_name`，剔除二维码 / 分享条 / 噪声
- [x] 掘金适配器（`juejin.cn/post/*`）：从 `.article-content` 抽取，剔除评论 / 点赞 / 分享 / 目录 / 标签；标题从 `<h1>` 兜底并去掉 ` - 掘金` 后缀
- [x] 单元测试（+9 用例：4 wechat + 5 juejin）+ pipeline 集成（+1 wechat）；总计 82 用例

### Phase 3-c（✅ 已交付）

- [x] `src/images.ts`：`extractImageUrls` + `localizeImages`，SHA1 去重、扩展名推断（Content-Type → URL 后缀 → `.bin`）、大小上限（默认 10 MB）、`data:` / 相对路径自动跳过
- [x] Pipeline 集成：新增 `localizeImages?: boolean`（默认关闭）+ `imageOptions` 覆盖项；仅在**确定要写文件**时才下载，避免孤儿图片
- [x] CLI 集成：`--localize-images` / `--image-max-bytes <bytes>` 开关
- [x] 图片下载失败**保留原 URL**（不阻断文章生成），CLI 输出 `imgs: N↓ F✗ S~` 统计
- [x] 单元测试 13 用例（`extractImageUrls` 3 + `extForUrl` 3 + `localizeImages` 7）+ pipeline 集成 2 用例；总计 97 用例

### Phase 3-d（✅ 已交付）

- [x] `localizeImages` 新增 `concurrency` 选项（默认 4，设 1 走串行），CLI 暴露 `--image-concurrency <n>`
- [x] 实现改为 **worker pool**（N 个 worker 从共享队列取 URL），替代最初的动态队列方案；避免 `Promise.all` 捕获不到后续 push 的 job
- [x] 新增 `seenHashes` 缓存：不同 URL 若字节相同（SHA1 碰撞），只写盘一次，避免并发写同一路径的 EBUSY
- [x] 单图失败仍只计入该图，不阻断其它 worker
- [x] 单元测试 +5（serial / 饱和 / 失败隔离 / 队列短于并发 / 默认并发），pipeline 集成 +1（多图并发）；总计 103 用例

### Phase 4（✅ 已交付）

- [x] 多阶段 Dockerfile：`node:20-bookworm-slim` 构建 → `node:20-alpine` 运行；仅拷贝 `dist/` + prod 依赖
- [x] `dumb-init` 信号转发 + `ca-certificates` 保证 HTTPS 抓取可用
- [x] `.dockerignore` 剔除 `.git` / `node_modules` / `tests` / `.workbuddy` 等，控制上下文体积
- [x] `ENTRYPOINT` 固定为 `node /app/dist/index.js`，所有 CLI 参数原样透传；`CMD --help` 便于 `docker run webcopy` 直接看帮助
- [x] README 补 Docker 使用示例（本地挂载 `./output`、多图本地化）
- 注：本机未装 Docker，未能实机 `docker build` 验证；Dockerfile 语法与依赖已按官方 Node 镜像 + 官方 best practice 编写

### Phase 5-a（✅ 已交付）

- [x] `src/web.ts`：Node HTTP 服务器，零外部依赖（仅用 `node:http`）
  - 端点：`GET /`（单文件 HTML/CSS/JS UI）、`GET /api/health`、`POST /api/convert`、`GET /api/list`、`GET /api/download/<slug>`
  - 安全：`sanitizeSlug()` 拒绝路径遍历（`/`、`\\`、`..`）；64 KB 请求体上限（`req.pause()` 而非 `destroy()`，保证 413 响应先送达）；CORS 仅允许 localhost
  - 复用 `pipeline.processUrl()`，Web UI 与 CLI 共享同一套抽取管线
- [x] `src/cli.ts` 新增 `--web`、`--host`、`--port` 标志；`[urls...]` 改为可选（`--web` 模式无需 URL）
- [x] `runWebServer()` 保持进程存活，转发 `SIGINT` / `SIGTERM` 优雅关闭
- [x] UI 单文件内嵌（HTML + CSS + JS），支持拖拽 URL、粘贴 URL、剪贴板读取、实时进度、下载 Markdown
- [x] 15 个测试用例（`tests/web.test.ts`）：HTML 页面、health、404、POST 转换（合法/非法/缺 URL）、list（空/有数据）、download（存在/404/路径遍历/413）、fetch 失败 → 502、CORS、随机端口绑定
- [x] 总计 118 个测试用例，全部通过

### Phase 5-b（✅ 已交付）

- [x] `.github/workflows/ci.yml`：Node 20 + 22 × ubuntu-latest + windows-latest 矩阵
  - 步骤：checkout → setup-node → npm ci → typecheck → test → build → smoke test（`--help`、`--web`）
- [x] `.github/workflows/docker.yml`：Docker 多阶段构建 + GHCR 推送
  - `docker/setup-buildx-action v3`（BuildKit 缓存）
  - `docker/login-action v3`（`ghcr.io` + `GITHUB_TOKEN` 自动认证）
  - `docker/metadata-action v5`（分支名 / semver tag / SHA / latest 四种 tag）
  - `docker/build-push-action v6`（GHA 缓存 + provenance 溯源）
  - `pull-requests` 触发（fork PR 跳过 GHCR 推送）
- 注：Git Data API 推送不触发 `on: push` 事件；首次部署需手动触发或在有代理的环境执行 `git push`

### Phase 6（待规划）

- [ ] VS Code 扩展 / 浏览器扩展
- [ ] 图片水印去除 / 压缩（需要引入 `sharp` 依赖）
- [ ] GitHub Pages / 其他更多平台适配器

---

## 9. 关键设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 语言 | TS + Node | 用户已在用，生态完善 |
| 抽取引擎 | Mozilla Readability | 事实标准，跨站点泛化好 |
| MD 转换 | turndown + gfm 插件 | 保留代码块语言需要插件 |
| 图片策略 | 默认保留远程 URL；`--localize-images` 显式开启才下载 | 默认快、简单；本地化用于长期归档场景；失败保留原 URL 优雅降级 |
| 图片去重 | SHA1(body bytes) 前 16 位 + 扩展名 | 同一 URL 多次引用只下载一次；跨文章相同字节内容也去重 |
| 图片扩展名推断 | Content-Type → URL 后缀 → `.bin` | 微信 / 掘金等站点常返回 `image/jpeg` 但 URL 无后缀；`.bin` 兜底保证可读 |
| 图片大小上限 | 默认 10 MB，可 `--image-max-bytes` 覆盖 | 防止异常大图拖垮磁盘；超上限跳过而非失败 |
| 图片并发 | worker pool，默认 4，可 `--image-concurrency` 覆盖 | 多图场景串行下载体验差；worker pool 比动态队列实现更简单、`Promise.all` 语义清晰 |
| 哈希去重落盘 | `seenHashes` Set 防止并发写同一路径 | 不同 URL 若字节相同（SHA1 相同），只写一次盘；避免 Windows EBUSY |
| 数学公式 | 不处理 | 复杂度太高，MVP 阶段明确排除 |
| 交互形态 | CLI 优先 | 快、可脚本化，Web UI 后续加 |
| 编码处理 | 探测 + iconv-lite 解码 | 中文站大量 GBK/GB2312，非 UTF-8 是"原味"最大障碍 |
| 重试策略 | 指数退避，仅重试 429/5xx/timeout/network | 4xx 是永久性错误，重试无意义 |
| 错误分类 | `FetchError.code` + `PipelineErrorCode` | CLI 输出 `[hint]` 让用户一眼看出是超时还是反爬 |
| 平台适配器 | 优先于 Readability；支持 `resolveFetchUrl` 覆盖抓取端点 | GitHub README 直接抓 raw markdown 零失真；知乎 / 微信 / 掘金 DOM 结构特殊，Readability 抽不出 |
| 本地化时机 | 仅在确定要写文件时执行 | 避免 `skipped` 场景产生孤儿图片；先 `access(filePath)` 再本地化 |
| Docker 镜像 | 多阶段（`node:20-bookworm-slim` → `node:20-alpine`）+ `dumb-init` | Alpine 体积小；`dumb-init` 保证 `docker stop` 优雅退出；`ca-certificates` 让 HTTPS 抓取开箱可用 |
| Web UI 实现 | 单文件 HTML/CSS/JS 内嵌于 `src/web.ts`，零外部依赖 | 最小化攻击面；无构建步骤；UI 与服务端同包发布；Docker 镜像直接可用 |
| Web UI 安全 | `sanitizeSlug` 拒绝路径遍历 + 64 KB body cap + CORS 仅 localhost | 64 KB 防 DoS；`req.pause()` 保留 413 响应通路；CORS 限制浏览器来源 |
| CI 矩阵 | Node 20 + 22 × ubuntu + windows | 覆盖最低支持版本和当前 LTS；Windows 验证 EBUSY 修复有效性 |
| GHCR 推送 | `docker/build-push-action v6` + GHA 缓存 + provenance | 缓存加速后续构建；provenance 提供供应链透明度 |

---

## 10. 开放问题

- [x] 是否需要在 Phase 2 加入"平台适配器"概念（微信 / 掘金等站点写专用抽取器）？→ Phase 3-a/b 已落地 4 个适配器
- [ ] CLI 打包成单文件 bin（`bin/webcopy`）后，是否要提供 `npm link` 或全局安装方式？
- [x] Phase 3-c 之后是否把 `--localize-images` 的下载并发提上去（当前是串行）？→ Phase 3-d 已落地 worker pool
- [ ] 是否需要支持图片水印去除 / 压缩？（当前只下载原始字节）
- [x] Web UI / Docker 镜像的优先级？→ Phase 4 Docker + Phase 5-a Web UI 均已落地
