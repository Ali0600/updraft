# Updraft

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

Early development. See `docs/` for design notes.

| Milestone | Scope | State |
| --- | --- | --- |
| M0 | Scaffold, Docker, CI | done |
| M1 | Protocol MVP (manifest + assets + publish API) | done |
| M2 | Code signing, channels, rollback | done |
| M3 | CLI + CI/CD publishing | planned |
| M4 | S3 storage + observability | planned |
| M5 | End-to-end dogfooding on a real app | planned |

## Quickstart

Requires Node >= 20, pnpm, and Docker.

```bash
pnpm install
pnpm test
```

Run the server in Docker:

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

Give the server the private key (`CODE_SIGNING_PRIVATE_KEY_PATH=/keys/private-key.pem`,
mounted read-only) and embed `certs/certificate.pem` in the app via
`updates.codeSigningCertificate`, with
`codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" }`. The
`keys generate` output prints the exact config snippet.

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
packages/cli      key generation; publishing (wraps `expo export` output)
```

- **Metadata** lives in SQLite (Drizzle ORM) — single-instance by design. The
  schema targets Postgres too if this ever needs to scale horizontally.
- **Blobs** go through a pluggable `BlobStorage` interface; the local
  filesystem driver ships first, S3-compatible storage in M4.
- **Auth** on every admin route is a bearer token from the environment. The
  server refuses to start without one.

## Configuration

Every variable is documented in [.env.example](.env.example). Configuration is
validated at boot and the process exits on anything invalid, rather than
starting in a half-configured state.

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

`test:bite` breaks one guard at a time and asserts the suite notices — a test
that has never failed proves nothing. `e2e-docker.sh` publishes an update
through the real container and verifies every asset over HTTP, covering what
in-process tests structurally cannot: the built bundle, migrations running from
`dist/`, and the native SQLite module actually loading.

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
- Implemented RSA code signing end to end — key generation, certificate
  issuance, request-scoped signing, and fail-closed key validation at boot —
  verifying signatures against an independent cryptographic implementation to
  prove interoperability rather than self-consistency.
- Designed reversible release operations (rollback to embedded, republish,
  disable) as append-only state transitions, preserving an audit trail and
  making every operation individually undoable.

## Prior art

This project learns from, and gratefully credits, several MIT-licensed
implementations:

- [expo/custom-expo-updates-server](https://github.com/expo/custom-expo-updates-server) — Expo's minimal reference server
- [xprem](https://github.com/mercuretechnologies/expo-open-ota) (formerly expo-open-ota) — a production Go implementation
- [hot-updater](https://github.com/gronxb/hot-updater) — a self-hostable CodePush-style alternative

Not affiliated with or endorsed by Expo. "Expo" is a trademark of 650 Industries, Inc.

## License

MIT — see [LICENSE](LICENSE).
