# Decision log

Design forks with real alternatives, recorded as they were decided. Rejected
options are kept because the reasoning behind them is worth revisiting.

## D19 — Stream asset responses instead of buffering them (2026-08-06)

**Fork:** the asset route read the whole blob into a Buffer before sending. On
an unauthenticated, unrate-limited route, memory scales with (concurrent
requests × asset size) — a resource-exhaustion vector (audit finding 3).

**Chosen:** add `getStream` to `BlobStorage` and pipe the stream. `get` stays
for callers that genuinely need the bytes in hand (the readiness probe, the
contract tests). Local FS uses `createReadStream`; S3 hands the SDK body
stream straight to Fastify, which consumes it or destroys it on client abort,
so no socket leaks.

Because a streamed and a buffered response are byte-identical, the durable
guard is a **calls-spy test** — the route must read via `getStream`, never
`get` — mirroring the earlier HEAD-uses-`stat` test. Verified additionally
over a real socket (not just `inject`) that content-length framing is correct.

**Revisit hook:** `BlobStorage.getStream` and the asset GET handler.

## D16 — Verify the image before publishing it (2026-08-06)

**Fork:** the release workflow built and pushed in one step, then ran a
"does it serve" check *afterwards* — so a failed check could not unpublish an
image that was already public at `:latest`.

**Chosen:** build the runner's architecture with `--load` (no push), run the
health check against that local image, and only then run a second build that
pushes the real multi-arch tags. The amd64 layers are cached from the first
build, so the second is cheap. A build that cannot boot never reaches the
registry.

Surfaced by the 2026-08-06 security audit (finding 1). The single-arch verify
leg is a deliberate limit: `docker --load` cannot load a multi-arch manifest,
so the boot check runs on amd64 only; arm64 is built only in the push leg.

**Revisit hook:** `.github/workflows/docker.yml`.

## D17 — Closing the asset-XSS vector (2026-08-06)

**Fork:** a publisher-supplied `contentType` is served from this origin. The
audit flagged that `text/html` is accepted, so an asset could render as HTML.

| Option | Tradeoff |
| --- | --- |
| Validate contentType as a media type | Bounds length and rejects junk — but `text/html` **is** a valid media type, so it does not close the XSS |
| `nosniff` + `content-disposition: attachment` on every asset response | Neuters any content type in a browser; invisible to the native client, which fetches programmatically |
| Allowlist content types | Brittle; breaks on any new asset kind |

**Chosen:** the response headers are the actual fix (they neuter `text/html`
regardless of the stored value), *and* the payload contentType is validated
for consistency and to bound its length. The report's original one-line
suggestion — validate contentType — was necessary but **not sufficient**;
recorded here so the distinction is not lost.

Also fixed alongside: the admin error handler mapped a schema-validation
failure (`ZodError`) to a 500, so any malformed admin body read as "internal
server error". It is now a 400 with the offending field — a client error
reported as one.

**Revisit hook:** `SAFE_DELIVERY_HEADERS` in `routes/assets.ts`;
`assetInputSchema` and the `ZodError` branch in `routes/admin.ts`.

## D18 — Caching the manifest signature (2026-08-06)

**Fork:** every unauthenticated request asking for `expo-expect-signature`
forced an RSA operation on a deliberately unrate-limited path.

**Chosen:** memoize the signature by body. The signed bytes are deterministic
per update and RSASSA-PKCS1-v1_5 is itself deterministic, so the cached value
is byte-identical — this is purely a CPU saving, not a behavior change. The
cache is bounded (FIFO, 256) so update churn cannot leak. Because output is
identical with or without it, the guarding test is on the pure memoizer's
call count, not on any served signature.

**Revisit hook:** `services/signatureCache.ts`, wired in `services/signer.ts`.

## D14 — Who may read /metrics (2026-08-06)

**Fork:** metrics expose app slugs, publish counts and error rates, and this
server is internet-facing.

| Option | Tradeoff |
| --- | --- |
| Public | What most self-hosted apps do and simplest to scrape; operational data is world-readable |
| Behind the publish token | Secure by default; Prometheus needs one line of config |
| A separate port | Clean separation, but a second listener to run and document |
| A separate `METRICS_TOKEN` | Prometheus would not hold a credential that can also publish updates |

**Chosen:** the publish token. One credential to manage, and the scrape config
cost is a single `authorization` block.

**Status of rejected options:** separate `METRICS_TOKEN` — `deferred — worth
trying`; the blast-radius argument is real (a compromised monitoring host
currently gains publish rights), it simply was not worth a second variable yet.
Public — `rejected — leaks operational data`. Separate port — `deferred`.

**Revisit hook:** `packages/server/src/routes/metrics.ts` plus the config
schema.

## D15 — Where the rate limiter sits relative to authentication (2026-08-06)

**Fork:** `@fastify/rate-limit` can attach globally, per route, or as an
explicit hook.

| Option | Tradeoff |
| --- | --- |
| `global: true` | One line, and **wrong here** |
| Per-route config | Same problem, expressed per route |
| Explicit hook, registered before auth | Verbose, and the only ordering that protects the token |

**Chosen:** the explicit hook. This was measured, not reasoned about: with
`global: true` the plugin attaches per *route*, and Fastify runs route hooks
**after** scope hooks. The admin scope's bearer check is a scope hook, so a
flood of unauthenticated requests collected 401s and never reached the limiter
— leaving the token exactly as exposed as with no limiter at all. The test
asserting "the third unauthenticated request is 429, not 401" is what caught
it, and it is now a sabotage.

The same investigation found the admin error handler flattening the limiter's
429 into a 500. Errors carrying a client-error status now keep it.

**Status of rejected options:** `global: true` — `rejected — runs after
authentication`.

**Revisit hook:** `packages/server/src/plugins/rateLimit.ts`, and the hook
order at the top of `routes/admin.ts`.

## D13 — How devices fetch asset bytes (2026-08-06)

**Fork:** with object storage available, assets could be served by this server
or fetched straight from the bucket/CDN.

| Option | Tradeoff |
| --- | --- |
| Always proxy | Bucket stays private and nothing about the protocol changes, but every byte is server bandwidth |
| Always direct | Scales, and is what EAS does, but requires a publicly readable bucket |
| Presigned URLs | Keeps the bucket private while serving directly |
| Both, proxy by default | Two paths to keep correct, and the URL must mean the same thing in each |

**Chosen:** both — proxy unless `ASSETS_BASE_URL` is set. The risk in having
two paths is that they drift, so the manifest URL is now *derived from the
storage key* (`${base}/${assetStorageKey(hex)}`) rather than written out
separately. They agreed by coincidence before; they agree by construction now,
with a test and a sabotage pinning it.

**The proxy stays enabled in direct mode.** Devices in the field hold manifests
addressed to `PUBLIC_URL`; turning the proxy off would break every update
mid-download. `ASSETS_BASE_URL` changes what *new* manifests say and nothing
else.

**Status of rejected options:** presigned URLs — `rejected — incompatible with
this design`: an expiring per-request URL cannot be cached immutably, and it
would sit inside a *signed* manifest that outlives the signature's validity.
Always-direct — `rejected — forces a public bucket on every deployment`.

**Revisit hook:** `toManifestAsset` in
`packages/server/src/services/manifestBuilder.ts`.

## D11 — S3 driver: SDK or hand-rolled SigV4 (2026-08-05)

**Fork:** M4 needs an S3-compatible storage driver. The API surface actually
used is tiny — GET, PUT, HEAD on one bucket.

| Option | Tradeoff |
| --- | --- |
| `@aws-sdk/client-s3` | ~26 packages and a larger image, but absorbs SigV4, retries, checksum negotiation, and per-provider quirks |
| Hand-rolled SigV4 over `fetch` | Zero dependencies and about 150 lines, genuinely tempting for three verbs |
| A lightweight third-party client | Fewer deps than the SDK, but a smaller maintenance base for a security-critical signer |

**Chosen:** the official SDK. A request signer is a security-critical wheel,
and the parts that look trivial are exactly the parts that differ between AWS,
MinIO, R2 and B2 — checksum headers, path-style addressing, error naming. The
measured cost was 26 packages, well below the ~80 feared when planning.

**Status of rejected options:** hand-rolled SigV4 — `rejected — security-critical
and provider-specific`. Lightweight client — `deferred — worth trying` if image
size ever matters.

**Revisit hook:** `packages/server/src/storage/s3.ts` implements a four-method
interface; swapping the client underneath touches nothing else.

## D12 — What "absent" means to a storage driver (2026-08-05)

**Fork:** `BlobStorage.get`/`stat` resolve `undefined` for a missing key. S3
signals many conditions as errors, and the driver must decide which of them
mean "not there".

| Option | Tradeoff |
| --- | --- |
| Any error → undefined | Simplest, and catastrophic: bad credentials or a typo'd bucket become an empty store that looks healthy |
| HTTP 404 → undefined | Reads correct, and is wrong — a **missing bucket also returns 404** |
| Specific error names → undefined | Narrowest, and the only one that distinguishes the cases |

**Chosen:** match `NoSuchKey` and `NotFound` by name; everything else
propagates. Measured against real MinIO, `GetObject` on a missing *bucket*
returns `NoSuchBucket` with status 404 — so the status-based version would have
reported a misconfigured bucket as an empty one. `403 AccessDenied` is
deliberately excluded too: S3 returns it instead of 404 for a missing object
when the caller lacks `s3:ListBucket`, and swallowing it would hide a
permissions mistake.

**Known limitation, pinned by a test:** `HeadObject` answers with an empty body,
so a missing bucket and a missing key are byte-identical (`NotFound`, 404).
`stat` therefore cannot detect a wrong bucket name. `get` can, which is why the
M4 readiness probe will read rather than stat.

**Revisit hook:** `isNotFound` in `packages/server/src/storage/s3.ts`, with the
measured error table in the comment above it.

## D10 — Publishing plumbing that needs a remote (2026-08-05)

**Fork:** M3 planned npm publishing (changesets + a release workflow), a GHCR
image push, and the composite GitHub Action. The repo has no remote, so none of
the first two can run.

| Option | Tradeoff |
| --- | --- |
| Author all three now | Two of them are YAML nothing can execute — unverified config that reads as done |
| Author only what can be verified | The Action ships tested; publishing waits until there is somewhere to publish from |
| Defer everything | Loses the Action, whose steps *can* be verified locally |

**Chosen:** author the Action, defer npm and GHCR publishing.

**Update (2026-08-05):** the repo now exists at
[github.com/Ali0600/updraft](https://github.com/Ali0600/updraft), so **GHCR
publishing is implemented** (`.github/workflows/docker.yml`, multi-arch on a
`v*` tag, authenticating with the workflow's own `GITHUB_TOKEN` — no secret to
manage). npm remains deferred: it needs an npm account and a final package
name, neither of which the remote unblocked.

Publishing also validated the CI that had never run. It failed four of five
jobs on the first clean checkout and exposed three real defects — an unbuilt
workspace dependency, a Node floor that was never true, and a code-signing key
unreadable by the container user on Linux. Authoring workflows is cheap;
*running* them is what makes them worth anything.

The Action earns its place because every `run:` block can be executed here
against a real server — `scripts/verify-action-steps.sh` does exactly that, and
also asserts two properties that are easy to regress: the publish token is
never an action *input* (inputs are echoed into workflow logs), and no `${{ }}`
interpolation appears inside a `run:` body (a shell-injection vector).

- *npm publish / changesets:* **deferred — blocked on a remote.** Also blocked
  on the public package name: bare `updraft` and the `@updraft` scope are
  taken; `updraft-ota` and `updraft-cli` are free. The Action's `cli-command`
  input defaults to `npx --yes updraft-cli` and can point at a local build in
  the meantime.
- *GHCR image push:* **deferred — blocked on a remote.** The image already
  builds and is exercised by both E2E scripts on every run.

**Revisit hook:** `.github/workflows/release.yml` plus `packages/cli/package.json`
`name`/`bin`, once an npm account and package name are settled. `docker.yml`
is done.

One implementation note worth keeping: `docker/metadata-action`'s
`type=semver,pattern={{version}}` strips the leading `v`, so the tag `v0.1.0`
publishes the image as `0.1.0`. Pulling `v0.1.0` returns "not found", which
looks exactly like a private-package permissions error and is not one.

## Backlog — alternatives worth trying later

- **Native-Swift asset/config OTA** — a genuinely different product; would let
  non-React-Native apps update remote config and assets. (See D1.)
- **Postgres metadata store** — needed the day this has to run more than one
  instance. Drizzle already targets it. (See D5.)
- **Bundling runtime dependencies into a single artifact** — smaller, simpler
  runtime image, blocked by pino/fastify worker-thread resolution. (See D7.)
- **npm package publishing** — blocked on an npm account and a final package
  name (`updraft` is taken there; `updraft-ota`/`updraft-cli` are free). GHCR
  is done. (See D10.)

---

## D8 — Project name (2026-08-05)

**Fork:** the name cannot contain "Expo" or "EAS" — Expo holds the trademark,
and `expo-open-ota` was made to rename to `xprem` over exactly this.

| Option | Tradeoff |
| --- | --- |
| Updraft | "updates" + over-the-air; reads as a product |
| Skypatch | descriptive of patching apps in the field |
| Volo | short and almost certainly free, but says nothing |

**Chosen:** **Updraft**.

- *Skypatch / Volo:* **rejected — Updraft says what it does.**

npm reality, checked at decision time: bare `updraft` is taken (an unrelated
2022 SQLite ORM) and the `@updraft` scope is registered; `updraft-ota` and
`updraft-cli` are free. Public package naming is deferred to M3, when something
is actually published. Internal workspace packages stay `@ota/*` and private —
renaming them buys nothing and touches every import.

**Revisit hook:** `packages/cli/package.json` `name`/`bin`, and the release
workflow, at M3.

## D9 — How to express "no update available" (2026-08-05)

**Fork:** M1 answered every "nothing to apply" with `204`. Code signing forced
the question, because a `204` has no body and therefore nothing to sign.

The spec is silent here: it says a zero-length multipart body is a valid no-op,
defines `rollBackToEmbedded`, and never states what to send when there is
simply nothing to apply. Expo's reference server settles it.

| Option | Tradeoff |
| --- | --- |
| Always `204` | Simplest; unauthenticatable by a client that demanded a signature |
| `noUpdateAvailable` directive on protocol 1 | Signable, explicit; needs version-aware rendering |
| Directive on every version | Protocol 0 has no directives and would not parse it |

**Chosen:** a signed `noUpdateAvailable` directive for protocol 1 multipart
clients; `204` for protocol 0 and for the JSON envelope, neither of which can
carry a directive.

- *Always 204:* **rejected — leaves signing clients unable to verify the most
  common response.**
- *Directive everywhere:* **rejected — protocol 0 predates directives.**

This also introduced `upToDate` as an outcome distinct from `noUpdate`, because
protocol 0 re-serves the manifest to an already-current client and therefore
needs the manifest data in a branch where version 1 sends nothing.

**Revisit hook:** `packages/server/src/routes/manifest.ts` (`nothingToApply`)
and the `ResolveOutcome` union in `services/updateResolver.ts`.

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
