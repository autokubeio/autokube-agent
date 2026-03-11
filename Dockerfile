# ── Build stage ────────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS build

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN bun build src/index.ts --outdir dist --target bun --minify

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine

WORKDIR /app

# oven/bun:1-alpine ships with a non-root 'bun' user (UID 1000) — use it directly
COPY --from=build /app/dist/index.js ./dist/index.js

USER bun

ENTRYPOINT ["bun", "run", "dist/index.js"]
