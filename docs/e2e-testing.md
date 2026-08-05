# End-to-end testing against a real device

Three layers of verification exist, each covering what the one below cannot:

| Layer | Command | Covers |
| --- | --- | --- |
| In-process suite | `pnpm test` | protocol logic, signing, storage, auth |
| Container E2E | `scripts/e2e-docker.sh`, `scripts/e2e-real-export.sh` | the built bundle, migrations from `dist/`, real HTTP, genuine Metro output |
| Simulator | this document | the actual `expo-updates` client |

The simulator layer is the only one that can tell you whether the client
accepts what the server emits. Everything else validates the server against a
specification and a reference implementation — neither of which runs on a
phone.

## Why a Release build

`expo-updates` is **disabled in debug builds** and does not exist in Expo Go at
all. A debug build will happily run and never contact the server, which reads
exactly like a working app that has no updates available. Always
`--configuration Release`.

## One-time setup

```bash
cd example-app && npm install
```

```bash
npx expo prebuild --platform ios --clean
```

The app config in [example-app/app.json](../example-app/app.json) sets:

- `runtimeVersion: "1.0.0"` — an explicit string, not a policy. Fingerprint
  policies resolve at build time and would change whenever a dependency moves.
- `updates.url` pointing at the host's `localhost:3000`. The iOS simulator
  shares the host network stack, so this reaches a server running on the Mac.
  A **physical device cannot** — it needs the Mac's LAN address over HTTPS.
- `updates.requestHeaders."expo-channel-name": "staging"` — how the client
  tells the server which channel it is on.
- An ATS exception for `localhost`. iOS blocks cleartext HTTP in Release
  builds; without this the client cannot reach the server at all, and the
  failure looks like "no updates available". **Development only** — production
  deployments serve over HTTPS and need no exception.

Verify the config reached the native project before spending time on a build:

```bash
plutil -p ios/exampleapp/Supporting/Expo.plist
```

It must show `EXUpdatesURL`, `EXUpdatesRuntimeVersion`, and
`EXUpdatesRequestHeaders`.

## The loop

Start a server and create the app:

```bash
docker run -d --name updraft-m5 -p 3000:3000 -e PUBLIC_URL=http://localhost:3000 -e PUBLISH_TOKEN=$(openssl rand -hex 32) updraft:m5
```

```bash
export UPDRAFT_PUBLISH_TOKEN=<the same token>
```

```bash
node packages/cli/dist/index.js apps create --server http://localhost:3000 --slug example-app --name "Example App"
```

Build and install once:

```bash
cd example-app && npx expo run:ios --configuration Release
```

Then, for each change: edit `App.tsx`, export, publish, and relaunch.

```bash
npx expo export
```

```bash
node ../packages/cli/dist/index.js publish --dir dist --server http://localhost:3000 --app example-app --channel staging --runtime-version 1.0.0
```

```bash
xcrun simctl terminate booted dev.updraft.exampleapp && xcrun simctl launch booted dev.updraft.exampleapp
```

Screenshot to confirm what is actually on screen:

```bash
xcrun simctl io booted screenshot /tmp/app.png
```

### Two traps in this loop

**`expo run:ios` starts a Metro dev server and opens a dev-client deep link.**
Kill it (`lsof -ti:8081 | xargs kill`) and relaunch with `simctl` before
testing, or you may be looking at a Metro-served bundle rather than the
embedded one, with expo-updates bypassed entirely.

**Never edit `App.tsx` while a build is running.** The bundle is embedded
during the Xcode build phase, so a mid-build edit produces an app whose
embedded bundle is neither version and whose test results mean nothing.

## Testing code signing

Signing needs the certificate compiled into the app, so it is a separate
build. Generate a key pair and add it to `app.json` under `updates`:

```bash
node ../packages/cli/dist/index.js keys generate --output ./certs
```

```json
"codeSigningCertificate": "./certs/certificate.pem",
"codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
```

The committed `app.json` deliberately omits these so a fresh clone builds
without generating keys first. Add them, re-run `expo prebuild --clean`, and
rebuild. Confirm the certificate reached the binary:

```bash
plutil -p ios/exampleapp/Supporting/Expo.plist | grep -i codesigning
```

Then run the server with the matching private key
(`CODE_SIGNING_PRIVATE_KEY_PATH`) and publish as usual.

**Prove the check bites.** A signature check that has never rejected anything
is decoration. Point the server at a *different* key pair with the same
`keyid`, publish, and relaunch: the app must stay on its previous update. If
the forged update applies, verification is not actually happening.

## What to watch on the server

```bash
docker logs -f updraft-m5
```

Every launch produces one manifest request. The server logs method and URL but
not headers; to see exactly what the client sends, put a logging proxy in
front of it — that is how the header record in
[protocol-notes.md](protocol-notes.md) was captured. What the client actually
sends is the ground truth, as opposed to what the specification says it should.

## Findings

Recorded in [protocol-notes.md](protocol-notes.md).
