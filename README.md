# Updraft

[![CI](https://github.com/Ali0600/updraft/actions/workflows/ci.yml/badge.svg)](https://github.com/Ali0600/updraft/actions/workflows/ci.yml)

A self-hosted, open-source update server for React Native and Expo apps. It is
an alternative to the hosted EAS Update service, and it implements the
published [Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/).

The on-device client (`expo-updates`) is already open source, and you can point
it at any server that follows the protocol. This project is the **server and
the publishing tools**: your bucket, your CDN, your data.

> **Scope note.** Over-the-air (OTA) updates cover interpreted code only — the
> JavaScript bundle and its assets. You can never update compiled native code
> this way, and doing so would break the Apple Developer Program agreement.
> A change to native modules or app config still needs a store release.

## Status

Working end to end. Updates publish from the CLI, apply on a real device, and
roll back. That was verified against `expo-updates` 57.0.12 on the iOS
simulator, with code signing switched on. See
[docs/protocol-notes.md](docs/protocol-notes.md) for what the real client
confirmed, and [docs/e2e-testing.md](docs/e2e-testing.md) for how to repeat it.

Blobs can live on disk or in any S3-compatible store, with optional CDN
delivery. All planned milestones are done.

Not yet exercised: Android, and physical devices (which need HTTPS).

Milestone history: [docs/MILESTONES.md](docs/MILESTONES.md).

## Quickstart

You need Node >= 22.13 (pnpm 11's own floor), pnpm, and Docker.

```bash
git clone https://github.com/Ali0600/updraft.git && cd updraft
```

```bash
pnpm install
pnpm test
```

Or skip the build and run the published image, which covers linux/amd64 and
linux/arm64:

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

The token comes from the environment only, never from a flag. Flags end up in
shell history and CI logs.

Publishing is content-addressed. The CLI asks the server which blobs it already
has and uploads only the rest. So republishing an unchanged export transfers
nothing, and iOS and Android share every asset they have in common.

| Command | Purpose |
| --- | --- |
| `publish` | publish an `npx expo export` directory |
| `keys generate` | create a code-signing certificate and key |
| `apps create` / `apps list` | manage apps |
| `updates list` | recent publishes with their group ids |
| `rollback` | send clients back to the embedded bundle |
| `updates republish` / `updates disable` | restore or retire a publish |

### From CI

[`action/action.yml`](action/action.yml) is a composite GitHub Action that
wraps the same steps:

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

The token is an `env:` value rather than an input, because action inputs are
echoed into workflow logs. `scripts/verify-action-steps.sh` checks its steps by
running each `run:` block locally against a real server — the action itself
cannot run here, and YAML nobody has tested is not a feature.

## API

**Protocol endpoint** (what `expo-updates` on the device calls):

```bash
curl -i http://localhost:3000/api/manifest/demo -H 'expo-protocol-version: 1' -H 'expo-platform: ios' -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed'
```

It returns a `multipart/mixed` manifest, a rollback directive, or `204` when
there is nothing to apply. Assets are served from `/assets/:sha256` and can be
cached forever. The details and the full resolution order are in
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
what really changed. Every lifecycle operation adds a new row instead of
rewriting history. That makes each one reversible and leaves an audit trail.

## Code signing

A device can require that an update was signed by your key before it applies it.

```bash
node packages/cli/dist/index.js keys generate --output ./certs
```

Give the server the private key. Embed `certs/certificate.pem` in the app
through `updates.codeSigningCertificate`, with
`codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" }`. The
`keys generate` output prints the exact config snippet.

The key reaches the server one of two ways:

- `CODE_SIGNING_PRIVATE_KEY_BASE64` — the key inline. It works everywhere and
  is the simplest option on hosts that only offer environment variables.
- `CODE_SIGNING_PRIVATE_KEY_PATH` — a read-only bind mount. **The container
  runs as uid 1000 (`node`), and `keys generate` writes the key mode 0600 owned
  by whoever ran it.** On Linux the container then cannot read it, so the
  server refuses to start. That is by design — see below. Either
  `chown 1000:1000` the key or use the base64 form. Docker Desktop on macOS
  remaps ownership, so this only shows up on Linux, which is exactly where you
  deploy.

Setting both is a configuration error. There is no quiet rule about which one
wins.

Signing is opt-in per request: a client asks for it with
`expo-expect-signature`. When one does, anything that would stop a correct
signature — no key configured, an unknown `keyid`, an unsupported algorithm —
returns `400`, never an unsigned `200`. Serving an unsigned update to a client
that asked for a signature is exactly the downgrade this prevents. A key that
is configured but unreadable stops the server at boot, for the same reason.

The certificate ships inside the app binary, so **rotating the key needs an
app-store release**. Certificates are generated with a 10-year validity, and
`keys generate` refuses to overwrite keys that already exist.

## Architecture

```
packages/core     protocol types, hashing, multipart, code signing
packages/server   Fastify server: manifest endpoint, asset delivery, admin API
packages/cli      publishing, key generation, and release management
example-app       a real Expo app used to produce genuine Metro exports
action            composite GitHub Action wrapping the publish flow
```

- **Metadata** lives in SQLite (Drizzle ORM), on a single instance by design.
  The schema works on Postgres too, if this ever needs to scale out.
- **Blobs** go through a pluggable `BlobStorage` interface: a local filesystem
  driver and an S3-compatible one (AWS, MinIO, Cloudflare R2, Backblaze B2).
- **Auth** on every admin route is a bearer token from the environment. The
  server refuses to start without one.

## Configuration

Every variable is documented in [.env.example](.env.example). The config is
checked at boot and the process exits on anything invalid, rather than starting
half-configured.

### Object storage

Set `STORAGE_DRIVER=s3` and `S3_BUCKET` to keep blobs in any S3-compatible
service. For anything other than AWS, set `S3_ENDPOINT` as well. Path-style
addressing turns on automatically when an endpoint is present, which is what
MinIO and most self-hosted gateways need.

```bash
STORAGE_DRIVER=s3 S3_BUCKET=updraft-updates S3_ENDPOINT=http://minio:9000
```

Leave `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` unset and credentials come from
the ambient AWS chain (an IAM role or instance profile), which is the
recommended production setup. Setting exactly one of the pair is a boot error:
otherwise the chain falls back to ambient credentials and writes into whatever
bucket those reach.

The bucket policy needs `s3:GetObject` and `s3:PutObject` on the objects, plus
**`s3:ListBucket` on the bucket**. Without `ListBucket`, S3 answers a missing
object with `403` instead of `404`. This server correctly reads that as a
failure rather than an absence, so the symptom is publishing that errors
instead of deduplicating.

### Serving assets from a CDN

By default the server proxies every asset download. Set `ASSETS_BASE_URL` and
new manifests point assets at a CDN, or straight at the bucket:

```bash
ASSETS_BASE_URL=https://cdn.example.com
```

The URL path is the object's storage key, so `assets/<sha256>` has to resolve
at that origin — point the CDN at the same bucket the server writes to. Assets
are content-addressed and never change, which is what makes them safe to cache
forever.

The server keeps serving assets itself even when this is set. Devices already
hold manifests addressed to `PUBLIC_URL`, and turning the proxy off would break
every update that is currently downloading.

## Operations

`/healthz` reports that the process is alive and never touches a dependency. It
backs the container `HEALTHCHECK`, and a restart cannot fix an unreachable
database or bucket. `/readyz` probes both and answers 503 when either is down,
which is the one a load balancer should watch.

`/metrics` serves Prometheus text **behind the publish token**. Operational
data should not be readable by the whole internet on a public server:

```bash
curl -H "Authorization: Bearer $UPDRAFT_PUBLISH_TOKEN" http://localhost:3000/metrics
```

Label sets are kept deliberately small. App slugs, channels, runtime versions
and client addresses are never used as labels. Several of them come straight
from request input, and a label built from request input lets anyone create
endless time series until the process runs out of memory.

Admin and metrics routes are rate limited, 600/minute by default. The device
paths are not: a release wave has every client checking in at once, and
answering that with 429s would be an outage you caused yourself.

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

`test:bite` breaks one guard at a time and checks that the suite notices. A
test that has never failed proves nothing.

`e2e-docker.sh` publishes a small checked-in fixture through the real CLI and
container. It stays fast and offline, and it covers what in-process tests
structurally cannot reach: the built bundle, migrations running from `dist/`,
and the native SQLite module actually loading.

`e2e-real-export.sh` runs `npx expo export` on `example-app/` and publishes the
result: genuine 1.4 MB Hermes bundles for both platforms and a real
content-addressed asset. It checks that the manifest matches the export byte
for byte, that asset keys equal Metro's own MD5 filenames, and that a repeat
publish uploads nothing. Run `npm install` in `example-app/` first.

## Experience Gained

- Implemented the Expo Updates v1 protocol from its spec — content-addressed assets,
  `multipart/mixed` envelopes, RSA signing — proved against the real `expo-updates` 57.0.12
  client, capturing its live traffic through a logging proxy to settle header formats and
  signature placement that no specification documents.
- Built RSA code signing end to end, with 10-year certificates and fail-closed key checks at
  boot, checked against an independent cryptographic implementation to prove interoperability
  rather than self-consistency, then proved the negative case: a device refuses an update
  signed with the wrong key.
- Designed a deduplicating blob store over local disk or 4 S3-compatible services (S3, MinIO, R2,
  B2), tested against a real MinIO in CI, cutting repeat publishes to 0 bytes transferred.
- Automated 4 CI gates (lint, typecheck, test, build) over a Node version matrix, with SHA-pinned
  actions, least-privilege permissions, and verify-before-publish on every release.
- Built a multi-stage Docker image that runs as an unprivileged user, cutting size 28% and fixing
  a container-only crash from a prebuilt binary needing newer glibc than the base image.
- Hardened the service from the first endpoint: fail-closed config, bearer auth, traversal-safe
  asset paths, a checksummed mutation harness, and 2 fixes from a first-principles audit.
- Instrumented operations with a bounded Prometheus label budget, dependency-free liveness and
  cached readiness probes, and 3 reversible release actions on append-only state.

## Prior art

This project learns from, and gratefully credits, several MIT-licensed
implementations:

- [expo/custom-expo-updates-server](https://github.com/expo/custom-expo-updates-server) — Expo's minimal reference server
- [xprem](https://github.com/mercuretechnologies/expo-open-ota) (formerly expo-open-ota) — a production Go implementation
- [hot-updater](https://github.com/gronxb/hot-updater) — a self-hostable CodePush-style alternative

Not affiliated with or endorsed by Expo. "Expo" is a trademark of 650 Industries, Inc.

## License

MIT — see [LICENSE](LICENSE).
