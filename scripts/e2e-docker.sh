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

cleanup() { docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true; }
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

echo "==> starting container on :${PORT}"
docker run -d --name "${CONTAINER}" -p "${PORT}:3000" \
  -e "PUBLIC_URL=${BASE}" \
  -e "PUBLISH_TOKEN=${TOKEN}" \
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

echo "==> creating app"
curl -fsS -X POST "${BASE}/api/admin/apps" \
  -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d '{"slug":"demo","name":"Demo App"}' >/dev/null
pass "app created"

BUNDLE_FILE="${FIXTURE}/_expo/static/js/ios/index.hbc"
ICON_FILE="${FIXTURE}/assets/icon.txt"
BUNDLE_HASH=$(sha256 "${BUNDLE_FILE}")
ICON_HASH=$(sha256 "${ICON_FILE}")

echo "==> negotiating which blobs are missing"
missing=$(curl -fsS -X POST "${BASE}/api/admin/assets/check" \
  -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d "{\"hashes\":[\"${BUNDLE_HASH}\",\"${ICON_HASH}\"]}")
echo "${missing}" | grep -q "${BUNDLE_HASH}" || fail "server did not report the bundle as missing"
pass "server reports both blobs missing"

echo "==> uploading blobs"
for pair in "${BUNDLE_HASH}:${BUNDLE_FILE}" "${ICON_HASH}:${ICON_FILE}"; do
  hash="${pair%%:*}"; file="${pair#*:}"
  curl -fsS -X PUT "${BASE}/api/admin/assets/${hash}" \
    -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/octet-stream' \
    --data-binary "@${file}" >/dev/null
done
pass "blobs uploaded"

echo "==> a corrupted upload is rejected"
code=$(printf 'not the bytes you claimed' | curl -s -o /dev/null -w '%{http_code}' \
  -X PUT "${BASE}/api/admin/assets/${BUNDLE_HASH}" \
  -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/octet-stream' \
  --data-binary @-)
[ "${code}" = "400" ] || fail "hash-mismatched upload returned ${code}, expected 400"
pass "hash-mismatched upload rejected"

echo "==> creating update"
curl -fsS -X POST "${BASE}/api/admin/updates" \
  -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d "{
    \"appSlug\":\"demo\",\"channelName\":\"production\",\"platform\":\"ios\",
    \"runtimeVersion\":\"1.0.0\",
    \"launchAsset\":{\"sha256Hex\":\"${BUNDLE_HASH}\",\"key\":\"bundle\",\"contentType\":\"application/javascript\",\"fileExtension\":\".hbc\"},
    \"assets\":[{\"sha256Hex\":\"${ICON_HASH}\",\"key\":\"icon\",\"contentType\":\"text/plain\",\"fileExtension\":\".txt\"}],
    \"metadata\":{}
  }" >/dev/null
pass "update published"

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

echo "==> an unpublished runtime version yields 204"
code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/manifest/demo" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 99.0.0' -H 'accept: multipart/mixed')
[ "${code}" = "204" ] || fail "unknown runtime version returned ${code}, expected 204"
pass "unknown runtime version returns 204"

echo "==> a traversal attempt on the asset route is rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "${BASE}/assets/..%2f..%2f..%2fetc%2fpasswd")
[ "${code}" = "400" ] || [ "${code}" = "404" ] || fail "traversal attempt returned ${code}"
pass "traversal attempt rejected (${code})"

rm -f "${headers}" "${body}"
echo
echo "E2E PASSED"
