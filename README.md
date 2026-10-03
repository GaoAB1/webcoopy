# webcopy

Fetch a URL and convert the article body to **faithful Markdown** — preserving headings, code blocks (with language), tables, lists, quotes, and image/link structure.

CLI-first tool. Design doc: [`DESIGN.md`](./DESIGN.md).

## Features

- **Faithful conversion** — code block languages, GFM tables, task lists, blockquotes, image alt text, anchor links preserved.
- **Mozilla Readability** for robust article extraction across sites.
- **Platform adapters** — dedicated extractors for sites where Readability misses content:
  - **GitHub README** — fetches raw markdown from `raw.githubusercontent.com` (no HTML conversion, zero fidelity loss).
  - **Zhihu** — extracts answers from `QuestionRichText` / `Card-content` containers, rewrites lazy-loaded images, strips vote buttons and share bars.
- **YAML front-matter** with title, author, source URL, and fetch time.
- **Charset detection** (HTTP header → `<meta charset>` → `<meta http-equiv>` → UTF-8) with `iconv-lite` decoding for GBK / GB2312 / Shift-JIS.
- **Retry with exponential backoff** on transient failures; permanent 4xx fail fast.
- **Batch mode** — pass multiple URLs or a file of URLs.
- **Zero-config CLI** — `npm install && npx webcopy <url>` and go.
- **Web UI** — drag-and-drop URLs in your browser; paste, convert, and download Markdown with one click.
- **Docker** — multi-stage image, runs anywhere with `docker run` or `docker compose`.

## Install

```bash
# From source
npm install

# Or link globally for a dev workflow
npm link
webcopy https://example.com
```

Requires Node.js ≥ 20.

### Docker

```bash
# Build
docker build -t webcopy .

# Single URL → mounted ./output
docker run --rm -v "$PWD/output:/app/output" webcopy https://example.com/article

# Multiple URLs with image localization
docker run --rm -v "$PWD/output:/app/output" webcopy \
  --localize-images --image-concurrency 8 \
  https://a.com https://b.com
```

The image is multi-stage (Node 20 build → `node:20-alpine` runtime) and ships
with `ca-certificates` + `dumb-init` for clean SIGTERM handling. Default entry
is `node /app/dist/index.js --web --host 0.0.0.0 --port 3000`, so a bare
`docker run -p 3000:3000 <image>` starts the Web UI; append CLI flags to
override (e.g. `docker run --rm <image> https://example.com/article`).

### docker-compose

> **Updating an existing deployment.** The services declare both `build: .` and
> a pinned `image:`, so Docker may reuse a locally built image instead of the
> published one. When you want the released image rather than the local source
> tree, always pull and recreate:
>
> ```bash
> docker compose pull
> docker compose --profile web up -d --force-recreate
> ```
>
> Then confirm which build is actually running:
>
> ```bash
> docker compose --profile cli run --rm webcopy --doctor
> ```
>
> `--doctor` lists each adapter's capabilities. If `juejin` does not report
> `ssr-payload+dom`, the running build is stale.

```bash
# Web UI → http://localhost:3000
# NOTE: the `web` service lives under the `web` profile, so the profile flag
# is required — a bare `docker compose up` selects no service.
docker compose --profile web up -d

# CLI one-shot (URLs passed at run time)
docker compose --profile cli run --rm webcopy https://example.com/article

# Multiple URLs + image localization
docker compose --profile cli run --rm webcopy \
  --localize-images --image-concurrency 8 \
  https://a.com https://b.com

# Local dev (source-code volume mount, live edits)
docker compose --profile dev up
```

Custom port via environment variable (applies to the host-side mapping only):

```bash
WEB_PORT=8080 docker compose --profile web up -d   # Web UI on port 8080
DEV_PORT=3001 docker compose --profile dev up
```

> **Port already allocated?** `Bind for :::3000 failed` means something else on
> the host already listens on 3000. Either free it (`docker rm -f $(docker ps -aq --filter publish=3000)`)
> or pick another port with `WEB_PORT=3001`. Changing `WEB_PORT` only moves the
> host-side port; the container always listens on 3000 internally.

All profiles share a named volume `webcopy-output` so Markdown files persist
across container restarts. Inspect with:

```bash
docker compose exec web sh -c 'ls /app/output'
docker compose down -v               # stop + delete volumes
```

### Web UI

```bash
# Start the web server (default http://localhost:3000)
webcopy --web

# Custom host and port
webcopy --web --host 0.0.0.0 --port 8080

# Inside Docker
docker run --rm -p 3000:3000 -v "$PWD/output:/app/output" webcopy --web
```

Open your browser and drag URLs onto the page, paste a URL, or paste a list of URLs (one per line). The UI fetches the article, converts it to Markdown, and provides a download link.

## Usage

```bash
# Single URL → ./output/
webcopy https://example.com/article

# Multiple URLs
webcopy https://a.com/x https://b.com/y

# Output to a custom directory
webcopy https://example.com/article --out ./articles

# Read URLs from a file (one per line, # for comments)
webcopy --file urls.txt --out ./articles

# Overwrite existing files
webcopy https://example.com/article --overwrite

# Verbose mode
webcopy https://example.com/article --verbose

# Custom timeout & retries
webcopy https://slow.example.com/article --timeout 30000 --retries 5
```

### CLI options

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `-o, --out <dir>` | `./output` | Output directory |
| `--file <path>` | — | Read URLs from a file (one per line, `#` comments) |
| `--overwrite` | `false` | Overwrite existing files |
| `-v, --verbose` | `false` | Print debug info (includes adapter name and charset) |
| `--timeout <ms>` | `15000` | Request timeout in milliseconds |
| `--retries <n>` | `3` | Total attempts on transient errors |
| `--no-adapters` | `false` | Disable platform adapters (fall back to Readability only) |
| `--localize-images` | `false` | Download remote images to `./images/` and rewrite URLs |
| `--image-max-bytes <n>` | `10485760` | Skip images larger than `n` bytes |
| `--image-concurrency <n>` | `4` | Max images to download in parallel (set 1 for serial) |
| `--web` | `false` | Start web UI server instead of CLI |
| `--host <host>` | `127.0.0.1` | Web server bind address |
| `--port <port>` | `3000` | Web server port |
| `--doctor` | `false` | Print build info and adapter capabilities, then exit |

## Output format

```md
---
title: "Article title"
author: "Author name (if detected)"
site: "example.com"
source: "https://example.com/article"
fetched_at: "2026-10-02T08:09:06.706Z"
---

# Article title

Body content...

```js
function hello() {
  console.log('hi');
}
```

| Header A | Header B |
| -------- | -------- |
| cell     | cell     |
```

## Development

```bash
# Install dependencies
npm install

# Run tests (118 test cases)
npm test

# Watch mode
npm run test:watch

# Type-check
npm run typecheck

# Build (outputs dist/)
npm run build
```

## Project layout

```
src/
├── index.ts          # CLI entry
├── cli.ts            # commander setup + --web flag
├── pipeline.ts       # URL → MD orchestration + error classification
├── fetcher.ts        # HTTP fetch with UA, timeout, retry, charset detection
├── extractor.ts      # Readability wrapper + data-lang preservation
├── converter.ts      # turndown + GFM + custom rules
├── images.ts         # Image localization (SHA1 dedup + worker pool)
├── meta.ts           # YAML front-matter
├── fs.ts             # slugify + write
├── web.ts            # Web UI server (HTTP + embedded single-file UI)
├── adapters.ts       # Adapter interface + registry
├── adapters/
│   ├── github-readme.ts  # GitHub README → raw markdown
│   ├── zhihu.ts          # Zhihu answers/articles
│   ├── wechat.ts         # WeChat Official Account articles
│   └── juejin.ts         # Juejin posts
└── rules/            # turndown custom rules
    ├── code-block.ts
    ├── image.ts
    └── link.ts
tests/
├── fixtures/         # Real HTML samples
├── adapters.test.ts  # adapter registry + all 4 adapters
├── fetcher.test.ts   # charset detection + decoding + FetchError
├── rules.test.ts
├── converter.test.ts
├── meta.test.ts
├── fs.test.ts
├── images.test.ts    # image localization + concurrency
├── web.test.ts       # web UI server (15 cases)
└── pipeline.test.ts  # integration, mock fetch + retry + adapters
```

## Design decisions

- **Adapters before Readability**: platform-specific extractors run first. If an adapter returns content, it wins; otherwise fall back to Readability + turndown. Adapters can also return a **different URL to fetch** (used by the GitHub README adapter to grab raw markdown directly).
- **Readability strips `class` attributes**, which would kill code block languages. We preprocess HTML to snapshot `language-*` classes onto `data-lang` before handing to Readability — this attribute survives cleaning.
- **Charset detection** cascades through HTTP `Content-Type` → `<meta charset>` → `<meta http-equiv>` → default UTF-8. Non-UTF-8 bytes (GBK / GB2312 / Shift-JIS / etc.) are decoded via `iconv-lite`. This matters for legacy Chinese / Japanese sites.
- **Retry with exponential backoff**: only retried for timeout, network errors, HTTP 429, and 5xx. 4xx (401, 403, 404) fail immediately with a hint.
- **Images stay as remote URLs** in MVP. `pageUrl` is used to absolutize relative `img[src]` values. Zhihu's lazy-load images are rewritten to their actual `data-src`.
- **Anchor-only links** (`#section`) are kept as-is, not absolutized.
- **Error classification**: every failure carries a `errorCode` (`timeout` / `network` / `http` / `no-article` / `filesystem` / …) so CLI can print a short hint in brackets.
- **Test-first**: every rule, adapter, and pipeline stage has unit tests; pipeline tests use mocked fetch (no real network in CI).

## Roadmap

See [`DESIGN.md`](./DESIGN.md) for the full phased plan.

- **Phase 2** ✅ — charset detection, retry, error classification, expanded tests.
- **Phase 3-a** ✅ — platform adapter framework + GitHub README + Zhihu adapters.
- **Phase 3-b** ✅ — WeChat Official Account + Juejin adapters.
- **Phase 3-c** ✅ — image localization (SHA1 dedup, extension inference).
- **Phase 3-d** ✅ — concurrent image downloads (worker pool).
- **Phase 4** ✅ — Docker multi-stage image with GHCR support.
- **Phase 5-a** ✅ — Web UI (drag-and-drop URLs, paste, download).
- **Phase 5-b** ✅ — GitHub Actions CI + Docker → GHCR pipeline.

## License

MIT
