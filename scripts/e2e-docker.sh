#!/usr/bin/env bash
#
# End-to-end smoke test against the real container over HTTP.
#
# Exercises what the in-process test suite structurally cannot: the built
# bundle, migrations running from dist/, and real network delivery of assets.
#
# Usage: scripts/e2e-docker.sh [port]
set -euo pipefail

PORT="${1:-39140}"
IMAGE="ota-os:e2e"
CONTAINER="ota-e2e-$$"
BASE="http://localhost:${PORT}"
TOKEN="e2e-token-0123456789abcdef0123456789abcdef"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${ROOT}/packages/server/test/fixtures/export-basic"
CERTS="$(mktemp -d)"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${CERTS}"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

# sha256sum on Linux/CI, shasum on macOS.
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

echo "==> building image"
docker build -f "${ROOT}/docker/Dockerfile" -t "${IMAGE}" "${ROOT}" >/dev/null

echo "==> generating code signing keys"
(cd "${ROOT}" && pnpm --filter '@ota/cli...' build >/dev/null 2>&1)
node "${ROOT}/packages/cli/dist/index.js" keys generate --output "${CERTS}" >/dev/null
[ -f "${CERTS}/private-key.pem" ] || fail "keys generate produced no private key"
pass "code signing keys generated"

echo "==> starting container on :${PORT}"
docker run -d --name "${CONTAINER}" -p "${PORT}:3000" \
  -e "PUBLIC_URL=${BASE}" \
  -e "PUBLISH_TOKEN=${TOKEN}" \
  -e "CODE_SIGNING_PRIVATE_KEY_PATH=/keys/private-key.pem" \
  -e "CODE_SIGNING_KEY_ID=main" \
  -v "${CERTS}:/keys:ro" \
  "${IMAGE}" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "${BASE}/healthz" >/dev/null || { docker logs "${CONTAINER}"; fail "server never became healthy"; }
pass "container is serving (migrations ran from the bundle)"

echo "==> admin API requires a token"
code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/admin/apps")
[ "${code}" = "401" ] || fail "unauthenticated admin request returned ${code}, expected 401"
pass "unauthenticated admin request rejected"

echo "==> building the CLI"
(cd "${ROOT}" && pnpm --filter '@ota/cli...' build >/dev/null 2>&1) || fail "cli build failed"
CLI="${ROOT}/packages/cli/dist/index.js"
export UPDRAFT_PUBLISH_TOKEN="${TOKEN}"

echo "==> creating app"
node "${CLI}" apps create --server "${BASE}" --slug demo --name "Demo App" >/dev/null
pass "app created via the CLI"

BUNDLE_FILE="${FIXTURE}/_expo/static/js/ios/index.hbc"
ICON_FILE="${FIXTURE}/assets/icon.txt"
BUNDLE_HASH=$(sha256 "${BUNDLE_FILE}")
ICON_HASH=$(sha256 "${ICON_FILE}")

echo "==> a corrupted upload is rejected"
code=$(printf 'not the bytes you claimed' | curl -s -o /dev/null -w '%{http_code}' \
  -X PUT "${BASE}/api/admin/assets/${BUNDLE_HASH}" \
  -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/octet-stream' \
  --data-binary @-)
[ "${code}" = "400" ] || fail "hash-mismatched upload returned ${code}, expected 400"
pass "hash-mismatched upload rejected"

echo "==> publishing the fixture export through the CLI"
publish_output=$(node "${CLI}" publish \
  --dir "${FIXTURE}" --server "${BASE}" --app demo \
  --channel production --runtime-version 1.0.0)
echo "${publish_output}" | grep -q 'published ios' || {
  echo "${publish_output}"; fail "the CLI did not publish ios"
}
pass "published via the CLI"

echo "==> republishing the same export uploads nothing"
second=$(node "${CLI}" publish \
  --dir "${FIXTURE}" --server "${BASE}" --app demo \
  --channel production --runtime-version 1.0.0)
echo "${second}" | grep -q '0 to upload' || {
  echo "${second}"; fail "dedupe failed: a repeat publish re-uploaded blobs"
}
pass "content addressing deduped every blob"

GROUP_ID=$(node "${CLI}" updates list --server "${BASE}" --app demo --channel production \
  | awk 'NR==2 {print $1}')
[ -n "${GROUP_ID}" ] || fail 'could not read a group id from "updates list"'
pass "group ${GROUP_ID} listed"

echo "==> fetching the manifest as a client would"
headers=$(mktemp); body=$(mktemp)
curl -fsS -D "${headers}" -o "${body}" "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' \
  -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' \
  -H 'expo-channel-name: production' \
  -H 'accept: multipart/mixed'

grep -qi '^expo-protocol-version: 1' "${headers}" || fail "missing expo-protocol-version header"
grep -qi '^expo-sfv-version: 0' "${headers}" || fail "missing expo-sfv-version header"
grep -qi '^content-type: multipart/mixed' "${headers}" || fail "response was not multipart/mixed"
grep -q 'name="manifest"' "${body}" || fail "no part named manifest"
pass "multipart manifest with protocol headers"

# Pull the manifest JSON out of the multipart body and check its asset URLs.
python3 - "$body" "$BUNDLE_HASH" "$BASE" <<'PY'
import json, re, sys, urllib.request, hashlib
body = open(sys.argv[1], 'rb').read().decode('utf8', 'replace')
expected_bundle_hash, base = sys.argv[2], sys.argv[3]

match = re.search(r'\r\n\r\n(\{.*\})\r\n', body, re.S)
if not match:
    print('FAIL: could not extract manifest JSON from multipart body'); sys.exit(1)
manifest = json.loads(match.group(1))

for field in ('id', 'createdAt', 'runtimeVersion', 'launchAsset', 'assets'):
    if field not in manifest:
        print(f'FAIL: manifest missing {field}'); sys.exit(1)

for asset in [manifest['launchAsset'], *manifest['assets']]:
    if not asset['url'].startswith(base):
        print(f"FAIL: asset url is not absolute against PUBLIC_URL: {asset['url']}"); sys.exit(1)
    data = urllib.request.urlopen(asset['url']).read()
    import base64
    got = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
    if got != asset['hash']:
        print(f"FAIL: bytes at {asset['url']} hash to {got}, manifest claims {asset['hash']}")
        sys.exit(1)

print(f"  ok: manifest {manifest['id']} valid; {1 + len(manifest['assets'])} asset(s) verified over HTTP")
PY

echo "==> an unpublished runtime version yields noUpdateAvailable (protocol 1)"
nothing=$(curl -fsS "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 99.0.0' -H 'accept: multipart/mixed')
echo "${nothing}" | grep -q 'noUpdateAvailable' || fail "expected a noUpdateAvailable directive"
pass "unknown runtime version returns a noUpdateAvailable directive"

echo "==> the same case on protocol 0, which has no directives, yields 204"
code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 0' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 99.0.0' -H 'accept: multipart/mixed')
[ "${code}" = "204" ] || fail "protocol 0 no-update returned ${code}, expected 204"
pass "protocol 0 returns 204"

echo "==> a traversal attempt on the asset route is rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "${BASE}/assets/..%2f..%2f..%2fetc%2fpasswd")
[ "${code}" = "400" ] || [ "${code}" = "404" ] || fail "traversal attempt returned ${code}"
pass "traversal attempt rejected (${code})"

echo "==> a signed manifest verifies against the certificate"
signed=$(mktemp)
curl -fsS -o "${signed}" "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed' \
  -H 'expo-expect-signature: sig, keyid="main", alg="rsa-v1_5-sha256"'

# Verify with the certificate only — exactly what the device has.
node -e '
const { readFileSync } = require("node:fs");
const { createVerify, X509Certificate } = require("node:crypto");
const raw = readFileSync(process.argv[1], "latin1");
const cert = readFileSync(process.argv[2], "utf8");

const sigHeader = /expo-signature:\s*(.+)\r\n/i.exec(raw);
if (!sigHeader) { console.error("FAIL: no expo-signature on the part"); process.exit(1); }
const sig = /sig="([^"]+)"/.exec(sigHeader[1]);
if (!sig) { console.error("FAIL: expo-signature has no sig member"); process.exit(1); }

// The signed bytes are the part body exactly as transmitted.
const bodyMatch = /\r\n\r\n(\{[\s\S]*\})\r\n--/.exec(raw);
if (!bodyMatch) { console.error("FAIL: could not extract the part body"); process.exit(1); }
const body = Buffer.from(bodyMatch[1], "latin1");

const ok = createVerify("SHA256").update(body).end()
  .verify(new X509Certificate(cert).publicKey, sig[1], "base64");
if (!ok) { console.error("FAIL: signature does not verify against the certificate"); process.exit(1); }

const tampered = Buffer.from(body.toString("utf8").replace("1.0.0", "9.9.9"), "utf8");
const tamperedOk = createVerify("SHA256").update(tampered).end()
  .verify(new X509Certificate(cert).publicKey, sig[1], "base64");
if (tamperedOk) { console.error("FAIL: signature also verified TAMPERED bytes"); process.exit(1); }

console.log("  ok: signature verifies, and rejects tampered bytes");
' "${signed}" "${CERTS}/certificate.pem" || fail "signature verification failed"
rm -f "${signed}"

echo "==> a client demanding an unknown keyid is refused"
code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed' \
  -H 'expo-expect-signature: sig, keyid="not-our-key"')
[ "${code}" = "400" ] || fail "unknown keyid returned ${code}, expected 400"
pass "unknown keyid refused"

echo "==> rolling back to the embedded bundle"
curl -fsS -X POST "${BASE}/api/admin/apps/demo/channels/production/rollback-to-embedded" \
  -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d '{"runtimeVersion":"1.0.0"}' >/dev/null

rollback_body=$(curl -fsS "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed')
echo "${rollback_body}" | grep -q 'rollBackToEmbedded' || fail "expected a rollBackToEmbedded directive"
pass "clients now receive a rollback directive"

echo "==> republishing restores the update"
group=$(curl -fsS -X POST "${BASE}/api/admin/updates/${GROUP_ID}/republish" \
  -H "authorization: Bearer ${TOKEN}")
echo "${group}" | grep -q '"updates"' || fail "republish did not return updates"

restored=$(curl -fsS "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed')
echo "${restored}" | grep -q 'launchAsset' || fail "expected a manifest again after republish"
# `grep -q X && fail` would abort under `set -e` on the success path, since a
# grep that correctly finds nothing exits 1.
if echo "${restored}" | grep -q 'rollBackToEmbedded'; then
  fail "still serving the rollback directive after republish"
fi
pass "manifest served again after republish"

echo "==> unsigned clients still work"
curl -fsS -o /dev/null "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed' \
  || fail "unsigned request failed"
pass "unsigned request still served"

rm -f "${headers}" "${body}"
echo
echo "E2E PASSED"
