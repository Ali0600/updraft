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
2. No active update for (app, channel, platform, runtimeVersion) → **204**.
   This is the normal answer for a freshly released binary with nothing
   published against its runtime version yet.
3. Newest row is a rollback → `rollBackToEmbedded` directive, unless the client
   reports it is already on the embedded bundle
   (`expo-current-update-id == expo-embedded-update-id`), which is a 204.
4. Newest update is the one the client already runs → **204**.
5. Otherwise → the manifest.

"Newest" is by an internal autoincrementing `seq`, not `createdAt`: two
publishes can land in the same millisecond, and a timestamp tie has no
deterministic winner.

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

**Asset addressing is content-based.** Assets are stored and served under the
hex SHA-256 of their bytes, while the manifest carries the same digest in
base64url as the protocol requires. The route validates `^[a-f0-9]{64}$` before
storage is consulted and derives the storage key itself, so client input never
reaches a filesystem path. Uppercase hex is rejected so one blob cannot be
addressed two ways.

## Things to watch when the real client arrives (M2)

- Where the client expects `expo-signature`: on the **multipart part**, not the
  HTTP response headers.
- Whether the client requires a `fileExtension` on every asset.
- Whether `metadata` needs specific fields, and whether `extra.expoClient` (the
  public Expo config) is required by modules such as expo-font.
- Exact part naming: we emit `manifest` and `directive`.
