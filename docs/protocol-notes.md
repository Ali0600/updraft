# Protocol notes

Our reading of the [Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/),
plus decisions the spec leaves open. Findings from driving the real
`expo-updates` client land here as they come up (M2 onward).

## The endpoint

`GET /api/manifest/:appSlug`

### Request headers we read

| Header | Required | Notes |
| --- | --- | --- |
| `expo-protocol-version` | no (defaults to 1) | 0 and 1 accepted; anything else is a 400 |
| `expo-platform` | yes | `ios` or `android` |
| `expo-runtime-version` | yes | opaque string, matched exactly |
| `accept` | no | must allow `multipart/mixed` or `application/expo+json`, else 406 |
| `expo-channel-name` | no (defaults to `production`) | set via `updates.requestHeaders` in app config |
| `expo-current-update-id` | no | what the client runs now; lets us answer 204 |
| `expo-embedded-update-id` | no | the bundle inside the binary |
| `expo-expect-signature` | no | M2 |

A `?channel=` query parameter is accepted as a fallback, for curl and CI checks.

### Response headers we always send

`expo-protocol-version: 1`, `expo-sfv-version: 0`, and
`cache-control: private, max-age=0` — on every response, **including 204s**,
which is the easy one to forget.

### Resolution order

1. Unknown app or channel → **404**. Deliberately not a fallthrough to a
   default, so a typo cannot serve another app's bundle.
2. No active update for (app, channel, platform, runtimeVersion) → nothing to
   apply. This is the normal answer for a freshly released binary with nothing
   published against its runtime version yet.
3. Newest row is a rollback → `rollBackToEmbedded` directive, unless the client
   reports it is already on the embedded bundle
   (`expo-current-update-id == expo-embedded-update-id`), which has nowhere to
   roll back to and would loop forever.
4. Newest update is the one the client already runs → nothing to apply
   (protocol 0: the manifest is re-served, see below).
5. Otherwise → the manifest.

"Newest" is by an internal autoincrementing `seq`, not `createdAt`: two
publishes can land in the same millisecond, and a timestamp tie has no
deterministic winner.

### How "nothing to apply" is expressed

This differs by protocol version, and the spec does not spell it out — the
behaviour below follows Expo's own reference server.

| Client | Response |
| --- | --- |
| protocol 1, `multipart/mixed` | `200` with a `noUpdateAvailable` directive part |
| protocol 1, `expo+json` | `204` — the JSON envelope has no directive slot |
| protocol 0 (any format) | `204`; directives do not exist in version 0 |

A directive is preferred over a bare `204` because it has a body, and a body
can be signed. A client that demanded a signature has no way to authenticate an
empty response.

Protocol 0 additionally has no way to say "you are already current", so an
up-to-date protocol-0 client is simply served the same manifest again. This is
why the resolver reports `upToDate` separately from `noUpdate` and carries the
manifest data in both: the route, not the resolver, decides how to render it.

## Code signing

Signing is **per request**: the client opts in with `expo-expect-signature`, and
a server with no key configured serves unsigned updates happily until one asks.

- **Signed bytes** are exactly the part body — `JSON.stringify(manifest)` or
  `JSON.stringify(directive)` — with no canonicalization. The bytes signed and
  the bytes sent must be the same string, never a re-serialization: two
  `JSON.stringify` calls can differ, and the client verifies what it received.
- **Placement**: `expo-signature` goes on the multipart **part**, not the HTTP
  response. For the bare `expo+json` envelope there are no parts, so it goes on
  the response headers.
- **Directives are signed too**, so even "nothing to apply" is authenticated.
- **Algorithm**: `rsa-v1_5-sha256` (RSA PKCS#1 v1.5 over SHA-256, base64) — the
  only one expo-updates supports.

Everything that can go wrong with a signature request is a **400**, never an
unsigned `200`: no key configured, an unknown `keyid`, an algorithm we cannot
produce, or a malformed header. Serving unsigned to a client that asked for a
signature would silently downgrade it, which is the failure this whole feature
exists to prevent.

A key configured but unreadable (missing file, invalid PEM, non-RSA) stops the
server at **boot**. Running unsigned because a PEM failed to parse would be the
same silent downgrade, one layer down.

### Key rotation

The certificate is embedded in the app binary, so rotating the key requires an
app-store release. Certificates are generated with a 10-year validity for that
reason. Clients name the key they expect via `keyid`; a request for a keyid the
server does not hold is refused rather than answered with a different key's
signature, which would fail verification on-device anyway.

## Decisions the spec leaves open

**`assets` excludes the launch asset.** The bundle appears only as
`launchAsset`. Our storage layer records it among the update's assets (it is a
blob the update owns), but repeating it in the manifest's `assets` array would
make the client fetch it twice.

**`expo-manifest-filters` is not sent.** The header is optional, and clients
match it against manifest `metadata` fields. Emitting a filter that the
metadata does not satisfy would make the client reject an otherwise valid
manifest, so we send nothing until channels/branches need real filtering.

**A JSON-only client gets 204 instead of a directive.** The `application/expo+json`
envelope is manifest-only and cannot carry a directive. When a rollback is
pending and the client will not accept multipart, 204 is the only truthful
answer available; the server logs a warning.

**`expo-protocol-version` is echoed, not hardcoded.** A protocol-0 client gets
`expo-protocol-version: 0` back, matching the reference server.

**An unknown `keyid` is a 400.** The alternative — signing with whatever key we
hold — produces a signature the client cannot verify, turning a clear server
error into an opaque on-device failure.

**Asset addressing is content-based.** Assets are stored and served under the
hex SHA-256 of their bytes, while the manifest carries the same digest in
base64url as the protocol requires. The route validates `^[a-f0-9]{64}$` before
storage is consulted and derives the storage key itself, so client input never
reaches a filesystem path. Uppercase hex is rejected so one blob cannot be
addressed two ways.

**Asset `key` is the MD5 of the contents, not a filename.** This is Metro's own
convention — an exported asset is literally named after its MD5, which the
real-export E2E asserts — and it is what lets a client recognise an asset it
already has embedded in the binary and skip downloading it. The bundle gets an
MD5 key on the same basis. Two different hashes are therefore in play per
asset, doing different jobs: SHA-256 addresses and verifies the bytes, MD5
identifies the logical asset.

## Verified against a real client

Run on 2026-08-05 against `expo-updates` 57.0.12 (Expo SDK 57, React Native
0.86) in a Release build on the iOS simulator. Procedure in
[e2e-testing.md](e2e-testing.md).

Confirmed working end to end:

- **An update is delivered and applied.** Publish → relaunch → the new bundle
  runs. The client fetched the manifest, downloaded the launch asset and the
  image asset, and rendered them.
- **`noUpdateAvailable` is accepted for the "nothing ever published" case.**
  This was the open question with the most risk attached, because the
  reference server only sends the directive for "you are already current".
  The client treats it as a no-op and runs its embedded bundle. It does not
  require a 204 here.
- **`rollBackToEmbedded` returns the client to its embedded bundle.**
- **Republishing an earlier group brings that update back.**
- **`runtimeVersion` gates correctly.** An update published to the *same
  channel*, newer than what the client is running, is ignored when its
  runtime version differs — verified with a 2.0.0 update against a 1.0.0 app.
- **`metadata: {}` is accepted.** No required fields were found.
- **Asset `fileExtension` as `.hbc`/`.png` is accepted**, and the launch asset
  being served as `application/javascript` while actually being Hermes
  bytecode causes no problem — matching the reference server's behaviour.

Still unverified:

- Whether `extra.expoClient` is *required* by modules that read the public
  config at runtime (expo-font and friends). It is sent when the publisher
  writes `expoConfig.json`, and the example app works with and without it, but
  the example app does not use such a module.
- Android. Everything above is iOS; the protocol is platform-independent but
  the client is not the same code.
- A physical device, which additionally requires HTTPS (ATS) and a LAN-
  reachable address rather than `localhost`.

### What the client actually sends

Captured from `expo-updates` 57.0.12 through a logging proxy:

```
user-agent: exampleapp/1 CFNetwork/3860.500.112 Darwin/25.5.0
accept: multipart/mixed,application/expo+json,application/json
expo-protocol-version: 1
expo-platform: ios
expo-runtime-version: 1.0.0
expo-channel-name: staging
expo-current-update-id: 680b5468-...
expo-embedded-update-id: 680b5468-...
expo-expect-signature: sig, keyid="main", alg="rsa-v1_5-sha256"
expo-updates-environment: BARE
expo-api-version: 1
expo-json-error: true
```

Notes on the ones that matter:

- `accept` lists all three types, so the multipart branch is what real clients
  get. The `expo+json` path exists for compatibility, not for this client.
- `expo-expect-signature` arrives in exactly the structured-field form the
  spec describes, `keyid` and `alg` included.
- `expo-current-update-id` equals `expo-embedded-update-id` while the client
  runs its embedded bundle, which is what makes the rollback suppression check
  work.
- Three headers are not in the specification: `expo-updates-environment`
  (`BARE` for a bare/prebuilt app), `expo-api-version`, and `expo-json-error`
  (the client wants JSON error bodies, which this server already returns).
  None require server action; they are recorded so nobody mistakes them for
  something we should be handling.

### Code signing, confirmed on device

- The signature must be on the **multipart part**. Our responses carry no
  `expo-signature` HTTP header at all, and the client is satisfied.
- **The client genuinely verifies.** Serving an update signed by an unrelated
  key — same `keyid`, valid signature, newer update — is refused: the app
  stayed on its previous update. A signature check that has never rejected
  anything proves nothing, so this was tested explicitly.

### Timing behaviour worth knowing

With `fallbackToCacheTimeout` (`EXUpdatesLaunchWaitMs`) set to 10000, both
updates and rollbacks apply on the **first** relaunch: the client blocks at
launch waiting for the fetch. With the default of 0 it downloads in the
background and applies on the *next* launch, which makes the loop look broken
if you only relaunch once.
