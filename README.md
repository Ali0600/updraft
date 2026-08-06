# Updraft

[![CI](https://github.com/Ali0600/updraft/actions/workflows/ci.yml/badge.svg)](https://github.com/Ali0600/updraft/actions/workflows/ci.yml)

A self-hosted, open-source update server for React Native / Expo apps — an
alternative to the hosted EAS Update service, implementing the published
[Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/).

The on-device client (`expo-updates`) is already open source and can point at
any conforming server. This project is the **server and publishing tooling**:
your bucket, your CDN, your data.

> **Scope note.** Over-the-air updates cover interpreted code only — the
> JavaScript bundle and its assets. Compiled native code can never be updated
> this way, and doing so would violate the Apple Developer Program agreement.
> A change to native modules or app config still needs a store release.

## Status

Working end to end. Updates publish from the CLI, apply on a real device, and
roll back — verified against `expo-updates` 57.0.12 on the iOS simulator, with
code signing enforced. See [docs/protocol-notes.md](docs/protocol-notes.md)
for what the real client confirmed and [docs/e2e-testing.md](docs/e2e-testing.md)
for how to reproduce it.

Blobs can live on disk or in any S3-compatible store, with optional CDN
delivery. All planned milestones are complete.

Not yet exercised: Android, and physical devices (which need HTTPS).

| Milestone | Scope | State |
| --- | --- | --- |
| M0 | Scaffold, Docker, CI | done |
| M1 | Protocol MVP (manifest + assets + publish API) | done |
| M2 | Code signing, channels, rollback | done |
| M3 | Publishing CLI + GitHub Action | done |
| M5 | Verified against a real `expo-updates` client | done |
| M4 | S3 storage, CDN delivery, metrics, readiness, rate limits | done |

## Quickstart

Requires Node >= 22.13 (pnpm 11's own floor), pnpm, and Docker.

```bash
git clone https://github.com/Ali0600/updraft.git && cd updraft
```

```bash
pnpm install
pnpm test
```

Or skip the build and run the published image (linux/amd64 and linux/arm64):

```bash
docker run -p 3000:3000 -e PUBLIC_URL=http://localhost:3000 -e PUBLISH_TOKEN=$(openssl rand -hex 32) ghcr.io/ali0600/updraft:0.1.0
```

Run the server from source in Docker:

```bash
cp .env.example .env && openssl rand -hex 32
```

Put that value in `.env` as `PUBLISH_TOKEN`, then:

```bash
docker compose -f docker/docker-compose.yml up --build
```

```bash
curl -fsS http://localhost:3000/healthz
```

## Publishing an update

Build the CLI once (`pnpm --filter @ota/cli build`), then export and publish:

```bash
export UPDRAFT_PUBLISH_TOKEN=your-publish-token
```

```bash
npx expo export
```

```bash
node packages/cli/dist/index.js publish --dir dist --server http://localhost:3000 --app my-app --channel production --runtime-version 1.0.0
```

The token comes from the environment only, never a flag — flags land in shell
history and CI logs.

Publishing is content-addressed: the CLI asks the server which blobs it already
has and uploads only the rest, so republishing an unchanged export transfers
nothing and iOS and Android share every common asset.

| Command | Purpose |
| --- | --- |
| `publish` | publish an `npx expo export` directory |
| `keys generate` | create a code-signing certificate and key |
| `apps create` / `apps list` | manage apps |
| `updates list` | recent publishes with their group ids |
| `rollback` | send clients back to the embedded bundle |
| `updates republish` / `updates disable` | restore or retire a publish |

### From CI

[`action/action.yml`](action/action.yml) is a composite GitHub Action wrapping
the same steps:

```yaml
- uses: ./action
  env:
    UPDRAFT_PUBLISH_TOKEN: ${{ secrets.UPDRAFT_PUBLISH_TOKEN }}
  with:
    server-url: https://updates.example.com
    app: my-app
    channel: production
    runtime-version: '1.0.0'
```

The token is an `env:` value rather than an input because action inputs are
echoed into workflow logs. Its steps are verified by
`scripts/verify-action-steps.sh`, which runs each `run:` block locally against a
real server — the action cannot execute here, and unverified YAML is not a
feature.

## API

**Protocol endpoint** (what `expo-updates` on the device calls):

```bash
curl -i http://localhost:3000/api/manifest/demo -H 'expo-protocol-version: 1' -H 'expo-platform: ios' -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed'
```

Returns a `multipart/mixed` manifest, a rollback directive, or `204` when there
is nothing to apply. Assets are served from `/assets/:sha256` with immutable
caching. Details and the full resolution order are in
[docs/protocol-notes.md](docs/protocol-notes.md).

**Admin API** (bearer token required on every route):

| Route | Purpose |
| --- | --- |
| `POST /api/admin/apps` | create an app plus its default channels |
| `POST /api/admin/assets/check` | ask which blobs still need uploading |
| `PUT /api/admin/assets/:sha256` | upload a blob (re-hashed server-side) |
| `POST /api/admin/updates` | publish an update to a channel |
| `POST /api/admin/apps/:app/channels/:channel/rollback-to-embedded` | send clients back to the bundle in the binary |
| `POST /api/admin/updates/:groupId/republish` | put an earlier publish back in front |
| `POST /api/admin/updates/:groupId/disable` | take a publish out of service |

Uploads are content-addressed and deduplicated, so republishing only transfers
what actually changed. Every lifecycle operation appends a new row rather than
mutating history, so each one is itself reversible and leaves an audit trail.

## Code signing

Devices can require that an update was signed by your key before applying it.

```bash
node packages/cli/dist/index.js keys generate --output ./certs
```

Give the server the private key and embed `certs/certificate.pem` in the app via
`updates.codeSigningCertificate`, with
`codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" }`. The
`keys generate` output prints the exact config snippet.

The key reaches the server one of two ways:

- `CODE_SIGNING_PRIVATE_KEY_BASE64` — the key inline. Works everywhere and is
  the simplest option on hosts that only offer environment variables.
- `CODE_SIGNING_PRIVATE_KEY_PATH` — a read-only bind mount. **The container
  runs as uid 1000 (`node`), and `keys generate` writes the key mode 0600 owned
  by whoever ran it.** On Linux the container then cannot read it and the
  server refuses to start (by design — see below). Either `chown 1000:1000` the
  key or use the base64 form. Docker Desktop on macOS maps ownership so this
  surfaces only on Linux, which is exactly where you deploy.

Setting both is a configuration error rather than a silent precedence rule.

Signing is opt-in per request: clients ask with `expo-expect-signature`. When
one does, anything that would prevent a correct signature — no key configured,
an unknown `keyid`, an unsupported algorithm — is a `400`, never an unsigned
`200`, since serving unsigned to a client that asked for a signature is exactly
the downgrade this prevents. A key that is configured but unreadable stops the
server at boot for the same reason.

The certificate ships inside the app binary, so **rotating the key requires an
app-store release** — certificates are generated with a 10-year validity, and
`keys generate` refuses to overwrite existing keys.

## Architecture

```
packages/core     protocol types, hashing, multipart, code signing
packages/server   Fastify server: manifest endpoint, asset delivery, admin API
packages/cli      publishing, key generation, and release management
example-app       a real Expo app used to produce genuine Metro exports
action            composite GitHub Action wrapping the publish flow
```

- **Metadata** lives in SQLite (Drizzle ORM) — single-instance by design. The
  schema targets Postgres too if this ever needs to scale horizontally.
- **Blobs** go through a pluggable `BlobStorage` interface: a local filesystem
  driver and an S3-compatible one (AWS, MinIO, Cloudflare R2, Backblaze B2).
- **Auth** on every admin route is a bearer token from the environment. The
  server refuses to start without one.

## Configuration

Every variable is documented in [.env.example](.env.example). Configuration is
validated at boot and the process exits on anything invalid, rather than
starting in a half-configured state.

### Object storage

Set `STORAGE_DRIVER=s3` and `S3_BUCKET` to store blobs in any S3-compatible
service. For anything other than AWS, set `S3_ENDPOINT` as well — path-style
addressing switches on automatically when an endpoint is present, which is what
MinIO and most self-hosted gateways require.

```bash
STORAGE_DRIVER=s3 S3_BUCKET=updraft-updates S3_ENDPOINT=http://minio:9000
```

Credentials come from the ambient AWS chain (IAM role or instance profile) when
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` are unset, which is the recommended
production setup. Setting exactly one of the pair is a boot error: the chain
would otherwise fall back to ambient credentials and write into whatever bucket
those reach.

The bucket policy needs `s3:GetObject` and `s3:PutObject` on the objects, plus
**`s3:ListBucket` on the bucket**. Without `ListBucket`, S3 answers a missing
object with `403` instead of `404`, which this server correctly treats as a
failure rather than an absence — so the symptom is publishing that errors
instead of deduplicating.

### Serving assets from a CDN

By default the server proxies every asset download. Set `ASSETS_BASE_URL` to
have new manifests address assets at a CDN or the bucket directly:

```bash
ASSETS_BASE_URL=https://cdn.example.com
```

The URL path is the object's storage key, so `assets/<sha256>` must resolve at
that origin — point the CDN at the same bucket the server writes to. Assets are
content-addressed and immutable, which is what makes them safe to cache
forever.

The server keeps serving assets itself even when this is set. Devices already
hold manifests addressed to `PUBLIC_URL`, and disabling the proxy would break
every update currently downloading.

## Operations

`/healthz` reports that the process is alive and never touches a dependency —
it backs the container `HEALTHCHECK`, and restarting cannot fix an unreachable
database or bucket. `/readyz` probes both and answers 503 when either is
down, which is what a load balancer should watch.

`/metrics` serves Prometheus text **behind the publish token**, because
operational data should not be world-readable on an internet-facing server:

```bash
curl -H "Authorization: Bearer $UPDRAFT_PUBLISH_TOKEN" http://localhost:3000/metrics
```

Label sets are deliberately bounded. App slugs, channels, runtime versions and
client addresses are never used as labels — several come straight from request
input, and a label taken from request input lets anyone create unbounded time
series until the process runs out of memory.

Admin and metrics routes are rate limited (600/minute by default). The device
paths are not: a release wave has every client checking in at once, and
answering that with 429s would be a self-inflicted outage.

Full deployment guide, including TLS, bucket policies and backups:
[docs/deployment.md](docs/deployment.md).

## Development

```bash
pnpm test        # vitest across all packages
pnpm typecheck   # tsc --noEmit per package
pnpm lint        # biome
pnpm build       # tsup + tsc declarations
pnpm test:bite   # mutation check: breaks each guard, fails if tests stay green
```

```bash
./scripts/e2e-docker.sh
```

```bash
./scripts/e2e-real-export.sh
```

`test:bite` breaks one guard at a time and asserts the suite notices — a test
that has never failed proves nothing.

`e2e-docker.sh` publishes a small checked-in fixture through the real CLI and
container, so it stays fast and offline while covering what in-process tests
structurally cannot: the built bundle, migrations running from `dist/`, and the
native SQLite module actually loading.

`e2e-real-export.sh` runs `npx expo export` on `example-app/` and publishes
that — genuine 1.4 MB Hermes bundles for both platforms and a real
content-addressed asset. It asserts the manifest matches the export byte for
byte, that asset keys equal Metro's own MD5 filenames, and that a repeat
publish uploads nothing. Requires `npm install` in `example-app/` first.

## Experience Gained

- Implemented a published wire protocol (Expo Updates v1) from its
  specification, including content-addressed asset delivery, `multipart/mixed`
  response envelopes, and RSA code signing over exact payload bytes.
- Designed a pluggable storage abstraction and a content-addressed,
  deduplicating blob store backed by SQLite metadata.
- Built a multi-stage Docker image running as an unprivileged user, with a
  dependency-free container healthcheck verified to fail as well as pass.
- Automated lint, typecheck, test, and build across a Node version matrix in
  GitHub Actions, with SHA-pinned third-party actions and least-privilege
  workflow permissions.
- Applied fail-closed configuration validation and bearer-token authentication
  from the first endpoint, with path-traversal-safe asset addressing.
- Built a mutation-testing harness that verifies each security and protocol
  guard is genuinely covered, checksumming sources across every break/restore
  cycle and validating the test count to detect runs that silently skip files.
- Diagnosed a container-only runtime failure caused by a native module's
  prebuilt binary requiring a newer glibc than the base image provided,
  reducing image size 28% by eliminating an unnecessary source build.
- Conducted a first-principles security audit of the codebase and the CI/CD
  pipeline, then hardened the findings: verify-before-publish in the release
  workflow so a build that cannot boot never reaches the registry, response
  headers that stop served assets executing as HTML on the origin, and a
  bounded signature cache that removes an unauthenticated CPU-amplification
  path.
- Implemented RSA code signing end to end — key generation, certificate
  issuance, request-scoped signing, and fail-closed key validation at boot —
  verifying signatures against an independent cryptographic implementation to
  prove interoperability rather than self-consistency.
- Designed reversible release operations (rollback to embedded, republish,
  disable) as append-only state transitions, preserving an audit trail and
  making every operation individually undoable.
- Built a publishing CLI that ingests Metro build output and uploads only the
  blobs a server lacks, cutting repeat publishes of multi-megabyte bundles to
  zero bytes transferred through content-addressed deduplication.
- Authored a composite GitHub Action for release automation, keeping
  credentials out of workflow logs by routing them through environment
  variables rather than action inputs, and validating every step locally
  against a live server.
- Validated a protocol implementation against the real third-party client on
  iOS, capturing live traffic through a logging proxy to confirm header
  formats and signature placement that no specification or test suite could
  settle.
- Demonstrated that code signing genuinely rejects tampered releases by
  serving an update signed with a mismatched key and confirming the device
  refused it — testing the negative case, not only the happy path.
- Built a pluggable object-storage layer for S3, MinIO, R2 and B2, tested
  against a real MinIO in CI rather than a mock — which caught a fault where a
  mistyped bucket name would have surfaced as an empty store on an
  apparently healthy server.
- Instrumented the service with Prometheus metrics under a deliberate
  cardinality budget, treating labels derived from request input as a
  memory-exhaustion vector rather than a style question.
- Designed liveness and readiness probes around their failure modes: liveness
  stays dependency-free so outages cannot trigger restart loops, and the
  unauthenticated readiness probe is cached and single-flighted so it cannot
  be used to amplify load against paid backing services.

## Prior art

This project learns from, and gratefully credits, several MIT-licensed
implementations:

- [expo/custom-expo-updates-server](https://github.com/expo/custom-expo-updates-server) — Expo's minimal reference server
- [xprem](https://github.com/mercuretechnologies/expo-open-ota) (formerly expo-open-ota) — a production Go implementation
- [hot-updater](https://github.com/gronxb/hot-updater) — a self-hostable CodePush-style alternative

Not affiliated with or endorsed by Expo. "Expo" is a trademark of 650 Industries, Inc.

## License

MIT — see [LICENSE](LICENSE).
