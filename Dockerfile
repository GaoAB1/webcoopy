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
# (optional — ENTRYPOINT below falls back to plain node if absent)
RUN apk add --no-cache ca-certificates dumb-init \
    && update-ca-certificates

WORKDIR /app

# Prod deps only (commander, iconv-lite, jsdom, cheerio, turndown, …).
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Bundled CLI + its entrypoint metadata.
COPY --from=build /app/dist ./dist
COPY package.json ./

# The bin declares "webcopy" → ./dist/index.js (see package.json "bin").
# Use absolute paths so the container works regardless of $PATH.
# Uses dumb-init for clean SIGTERM if available; falls back to plain node.
ENTRYPOINT ["/bin/sh", "-c", "if [ -x /sbin/dumb-init ]; then exec /sbin/dumb-init -- node /app/dist/index.js \"$@\"; else exec node /app/dist/index.js \"$@\"; fi"]

# Default to the Web UI so `docker run -p 3000:3000 <image>` just works.
# The CLI profile in docker-compose.yml overrides this with explicit args.
CMD ["--web", "--host", "0.0.0.0", "--port", "3000"]
