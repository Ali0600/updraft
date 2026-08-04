# syntax=docker/dockerfile:1
#
# Build from the repo root:  docker build -f docker/Dockerfile .
#
# Debian rather than Alpine on purpose: better-sqlite3 publishes glibc
# prebuilds only, so musl would force a from-source native compile.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# --- dependencies -----------------------------------------------------------
# Manifests only, so the install layer caches until a package.json changes.
FROM base AS deps
# better-sqlite3 falls back to a node-gyp source build when no prebuild matches
# the platform, so the toolchain has to exist here. It stays out of the runtime
# stage, which only receives the compiled .node file.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
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
