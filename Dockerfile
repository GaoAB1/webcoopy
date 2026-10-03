# syntax=docker/dockerfile:1

# ── Stage 1: build ───────────────────────────────────────────────────────────
# Install all deps (dev + prod), compile TS, bundle to dist/.
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
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
    && update-ca-certificates

WORKDIR /app

# Prod deps only (commander, iconv-lite, jsdom, cheerio, turndown, …).
COPY package.json package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force

# Bundled CLI + its entrypoint metadata.
COPY --from=build /app/dist ./dist
COPY package.json ./

# The bin declares "webcopy" → ./dist/index.js (see package.json "bin").
# Use the absolute path so the container works regardless of $PATH.
ENTRYPOINT ["/sbin/dumb-init", "--", "node", "/app/dist/index.js"]

# Convenience default: list help. Real usage overrides this with arguments.
CMD ["--help"]
