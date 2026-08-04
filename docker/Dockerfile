# syntax=docker/dockerfile:1
#
# Build from the repo root:  docker build -f docker/Dockerfile .
#
# Alpine works because better-sqlite3 ships musl prebuilds alongside the glibc
# ones, so nothing is compiled here at all (see allowBuilds in
# pnpm-workspace.yaml). Worth knowing if this ever moves back to Debian: the
# linux-arm64 prebuild needs glibc 2.38, which Bookworm (2.36) does not have —
# that image builds cleanly and then dies on its first require().
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# --- dependencies -----------------------------------------------------------
# Manifests only, so the install layer caches until a package.json changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm --filter @ota/core --filter @ota/server build
# Produces a self-contained directory with production deps only.
RUN pnpm --filter @ota/server --prod --legacy deploy /deploy

# --- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/db.sqlite \
    STORAGE_LOCAL_ROOT=/data/blobs

COPY --from=build --chown=node:node /deploy /app

# Volume mount points, owned by the unprivileged user that will write to them.
RUN mkdir -p /data/blobs /keys && chown -R node:node /data /keys

USER node
EXPOSE 3000
VOLUME ["/data"]

# No curl in slim; Node's global fetch is already present.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
