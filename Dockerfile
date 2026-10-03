# syntax=docker/dockerfile:1

# ── Stage 1: build ───────────────────────────────────────────────────────────
# Install all deps (dev + prod), compile TS, bundle to dist/.
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Install deps first for layer caching.
# NOTE: package-lock.json is NOT copied here — npm has a bug where
# platform-specific optional deps (e.g. @rollup/rollup-linux-x64-gnu)
# are not resolved from a lock file generated on a different OS.
# See https://github.com/npm/cli/issues/4828
COPY package.json ./
RUN npm install

# Copy sources and build.
COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# Minimal Node image. Only prod deps + the bundled dist/ are copied in.
FROM node:20-alpine

# ca-certificates: HTTPS fetches need a root CA bundle.
# dumb-init: proper signal forwarding so `docker stop` sends SIGTERM cleanly.
RUN apk add --no-cache ca-certificates dumb-init \
    && update-ca-certificates \
    && ln -sf /usr/bin/dumb-init /sbin/dumb-init

WORKDIR /app

# Prod deps only (commander, iconv-lite, jsdom, cheerio, turndown, …).
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Bundled CLI + its entrypoint metadata.
COPY --from=build /app/dist ./dist
COPY package.json ./

# The bin declares "webcopy" → ./dist/index.js (see package.json "bin").
#
# NOTE: use the *exec* form (JSON array), never `sh -c "<script>"`. With the
# shell form, Docker appends CMD as arguments to `sh -c`, and sh assigns the
# first of them to $0 — so for `CMD ["--web", ...]` the `--web` flag became the
# script's own name and never reached node, leaving only `--host 0.0.0.0
# --port 3000`. The CLI then fell through to the pipeline branch and exited
# with "error: no URLs provided".
#
# dumb-init is installed and hard-linked to /sbin/dumb-init above, so the build
# fails loudly if it is ever missing instead of the container dying at runtime.
ENTRYPOINT ["/sbin/dumb-init", "--", "node", "/app/dist/index.js"]

# Default to the Web UI so `docker run -p 3000:3000 <image>` just works.
# The CLI profile in docker-compose.yml overrides this with explicit args.
CMD ["--web", "--host", "0.0.0.0", "--port", "3000"]
