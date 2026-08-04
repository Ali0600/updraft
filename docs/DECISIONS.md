# Decision log

Design forks with real alternatives, recorded as they were decided. Rejected
options are kept because the reasoning behind them is worth revisiting.

## Backlog — alternatives worth trying later

- **Native-Swift asset/config OTA** — a genuinely different product; would let
  non-React-Native apps update remote config and assets. (See D1.)
- **Postgres metadata store** — needed the day this has to run more than one
  instance. Drizzle already targets it. (See D5.)
- **Bundling runtime dependencies into a single artifact** — smaller, simpler
  runtime image, blocked by pino/fastify worker-thread resolution. (See D7.)

---

## D1 — Which apps can we update over the air? (2026-08-04)

**Fork:** Apple's Developer Program agreement (3.3.2) permits OTA updates to
interpreted code only, so the target platform decides what is even possible.

| Option | Tradeoff |
| --- | --- |
| React Native / Expo apps | Full JS bundle + asset updates. Rides the open `expo-updates` client and published protocol. |
| Native Swift apps | Only assets, config, and server-driven UI. Compiled code can never be shipped this way. |
| Framework-agnostic bundle delivery | Widest reach, much larger scope; the JS case would still have to land first. |

**Chosen:** React Native / Expo. It is the case where OTA delivers real value,
and an open client plus an open protocol spec means the missing piece is
genuinely just the server.

- *Native Swift:* **deferred — worth trying.** A remote-config/asset channel is
  a real product, just a different one.
- *Framework-agnostic:* **rejected — premature.** Generalising before one
  concrete implementation works produces the wrong abstraction.

**Revisit hook:** the `BlobStorage` interface and the admin publish API are
already format-agnostic; a second protocol would slot in beside
`routes/manifest.ts` as another resolver.

## D2 — How much of the system do we build? (2026-08-04)

**Fork:** `expo-updates` (the on-device client) is already MIT-licensed and the
protocol is public, so the paid part of EAS Update is only the server and CDN.

| Option | Tradeoff |
| --- | --- |
| Server implementing the protocol | Highest leverage; existing client points at it unchanged. |
| Own client + server | Months of work re-implementing a mature, battle-tested native client. |
| Contribute to xprem / hot-updater | Real OSS contribution, but not an owned project. |

**Chosen:** Server only.

- *Own client:* **rejected — negative value.** Re-implementing native
  download/verify/swap logic would be strictly worse than the existing client
  and would carry the risk of bricking apps.
- *Contributing upstream:* **deferred — worth trying.** A good follow-on once
  this codebase has taught the protocol properly.

**Revisit hook:** `docs/protocol-notes.md` accumulates the client-behaviour
findings that would make an upstream contribution straightforward.

## D3 — Server stack (2026-08-04)

**Fork:** Node/TypeScript vs Go vs Python.

| Option | Tradeoff |
| --- | --- |
| Node + TypeScript | Same ecosystem as Expo's own tooling and reference server; types shared with the CLI. |
| Go | Single static binary, what xprem chose; but the reference code has to be translated by hand. |
| Python (FastAPI) | Most familiar, furthest from the Expo tooling ecosystem. |

**Chosen:** Node + TypeScript — the publishing CLI has to parse `expo export`
output anyway, so one language covers server, CLI, and shared protocol types.

- *Go:* **rejected — no shared types with the CLI.** Single-binary distribution
  is a real advantage, but not worth two languages on a solo project.
- *Python:* **rejected — ecosystem distance.** Would mean reimplementing the
  Expo export parsing with no reference to crib from.

## D4 — Learning project or production tool? (2026-08-04)

**Chosen:** both — design for real use from day one (code signing, rollback
safety, auth on the first endpoint), but phase the work so an MVP serves one
app before hardening. The alternative, treating it as a portfolio artifact
only, was rejected because a system nobody runs never surfaces the bugs that
make it worth having built.

## D5 — Metadata store (2026-08-04)

**Fork:** SQLite vs Postgres for update/asset metadata.

**Chosen:** SQLite via better-sqlite3 + Drizzle, behind a repository interface.
Zero-ops for a self-hosted single instance; a synchronous driver removes a
class of async bugs.

- *Postgres:* **deferred — worth trying.** Required the day horizontal scaling
  matters. Drizzle's schema definitions already target it.

**Revisit hook:** `packages/server/src/db/` — swapping the client and
regenerating migrations is the whole change, provided queries stay behind the
repository layer.

## D6 — Container base image (2026-08-05)

**Fork:** Alpine (musl) vs Debian slim (glibc).

**Chosen:** `node:22-alpine` — 316 MB against 438 MB for Debian, with nothing
compiled at build time.

This entry originally chose `node:22-bookworm-slim` on the premise that
better-sqlite3 publishes glibc prebuilds only. **That premise was wrong**, and
running the container is what disproved it. The package ships prebuilds for
eight targets including `linuxmusl-arm64` and `linuxmusl-x64`. Two things fell
out of checking:

- Bookworm is in fact the *broken* option: the `linux-arm64` prebuild requires
  glibc 2.38 and Bookworm ships 2.36, so that image builds cleanly and then
  dies on its first `require()`. Debian would have to be Trixie (glibc 2.41).
- The C++ toolchain the Debian stage installed was never needed. better-sqlite3
  has no install script; package managers auto-run `node-gyp rebuild` for any
  package with a `binding.gyp`, and the loader then ignores the result in
  favour of the shipped prebuild. `allowBuilds: better-sqlite3: false` removes
  the build entirely.

- *Debian slim:* **rejected — larger, and it compiles for no reason.** Would
  become necessary only if a dependency appears with no musl prebuild; Trixie,
  not Bookworm, is the version to reach for.

**Revisit hook:** `docker/Dockerfile` `FROM` lines, plus `allowBuilds` in
`pnpm-workspace.yaml`.

## D7 — Shipping runtime dependencies (2026-08-05)

**Fork:** bundle every dependency into one file (tsup `noExternal`) vs ship a
pruned `node_modules` via `pnpm deploy`.

**Chosen:** `pnpm deploy --prod --legacy` into the runtime stage. Fastify and
pino resolve worker threads and transports by real file paths at runtime, so
bundling them risks breakage that only appears in production.

- *Full bundling:* **deferred — worth trying.** A single-file artifact would
  shrink the image and simplify the runtime stage. Would need proof that pino
  transports and Fastify's plugin loading survive it.

**Revisit hook:** `packages/server/tsup.config.ts` — the `external` list is the
seam.
