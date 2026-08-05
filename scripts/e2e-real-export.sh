#!/usr/bin/env bash
#
# Publishes a genuine `npx expo export` through the CLI to a real container.
#
# The other E2E uses a hand-made fixture so it stays fast and offline. This one
# proves the pipeline against Metro's actual output: real Hermes bundles, real
# content-addressed assets, both platforms, shared assets deduped.
#
# Usage: scripts/e2e-real-export.sh [port]
set -euo pipefail

PORT="${1:-39160}"
IMAGE="updraft:e2e-real"
CONTAINER="updraft-real-$$"
BASE="http://localhost:${PORT}"
TOKEN="real-e2e-0123456789abcdef0123456789abcdef"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT}/example-app"
CLI="${ROOT}/packages/cli/dist/index.js"

export UPDRAFT_PUBLISH_TOKEN="${TOKEN}"

cleanup() { docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

[ -d "${APP_DIR}/node_modules" ] || fail "run 'npm install' in example-app first"

echo "==> exporting the example app with metro"
(cd "${APP_DIR}" && rm -rf dist && npx expo export --platform ios --platform android >/dev/null 2>&1) \
  || fail "expo export failed"
# Optional but recommended: some modules read the public config at runtime.
(cd "${APP_DIR}" && npx expo config --json --type public > dist/expoConfig.json 2>/dev/null) \
  || echo "  note: could not write expoConfig.json; publishing without it"
pass "export produced $(find "${APP_DIR}/dist" -type f | wc -l | tr -d ' ') files"

echo "==> building and starting the server"
docker build -f "${ROOT}/docker/Dockerfile" -t "${IMAGE}" "${ROOT}" >/dev/null
docker run -d --name "${CONTAINER}" -p "${PORT}:3000" \
  -e "PUBLIC_URL=${BASE}" -e "PUBLISH_TOKEN=${TOKEN}" "${IMAGE}" >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "${BASE}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "${BASE}/healthz" >/dev/null || { docker logs "${CONTAINER}"; fail "server never became healthy"; }
pass "server up"

echo "==> building the CLI"
(cd "${ROOT}" && pnpm --filter @ota/cli build >/dev/null 2>&1) || fail "cli build failed"

echo "==> creating the app"
node "${CLI}" apps create --server "${BASE}" --slug example-app --name "Example App" >/dev/null
pass "app created"

echo "==> publishing the real export"
publish_output=$(node "${CLI}" publish \
  --dir "${APP_DIR}/dist" \
  --server "${BASE}" \
  --app example-app \
  --channel staging \
  --runtime-version 1.0.0)
echo "${publish_output}" | sed 's/^/    /'
echo "${publish_output}" | grep -q 'published ios' || fail "ios was not published"
echo "${publish_output}" | grep -q 'published android' || fail "android was not published"
pass "both platforms published"

echo "==> republishing the same export uploads nothing"
second=$(node "${CLI}" publish \
  --dir "${APP_DIR}/dist" --server "${BASE}" --app example-app \
  --channel staging --runtime-version 1.0.0)
echo "${second}" | grep -q '0 to upload' || {
  echo "${second}"; fail "dedupe failed: a repeat publish re-uploaded blobs"
}
pass "content addressing deduped every blob on republish"

echo "==> the manifest matches the export, byte for byte"
for platform in ios android; do
  body=$(curl -fsS "${BASE}/api/manifest/example-app" \
    -H 'expo-protocol-version: 1' -H "expo-platform: ${platform}" \
    -H 'expo-runtime-version: 1.0.0' -H 'expo-channel-name: staging' \
    -H 'accept: multipart/mixed')
  printf '%s' "${body}" > "/tmp/updraft-manifest-${platform}.txt"

  python3 - "/tmp/updraft-manifest-${platform}.txt" "${APP_DIR}/dist" "${platform}" "${BASE}" <<'PY'
import base64, hashlib, json, re, sys, urllib.request
from pathlib import Path

raw = Path(sys.argv[1]).read_text('utf8', 'replace')
dist, platform, base = Path(sys.argv[2]), sys.argv[3], sys.argv[4]

match = re.search(r'\r?\n\r?\n(\{.*\})\r?\n', raw, re.S)
if not match:
    print(f'FAIL: no manifest JSON in the {platform} response'); sys.exit(1)
manifest = json.loads(match.group(1))

meta = json.loads((dist / 'metadata.json').read_text())
files = meta['fileMetadata'][platform]

def b64url(data):
    return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')

bundle = (dist / files['bundle']).read_bytes()
if manifest['launchAsset']['hash'] != b64url(bundle):
    print(f'FAIL: {platform} launchAsset hash does not match the exported bundle'); sys.exit(1)
if manifest['launchAsset']['key'] != hashlib.md5(bundle).hexdigest():
    print(f'FAIL: {platform} launchAsset key is not the content MD5'); sys.exit(1)

if len(manifest['assets']) != len(files['assets']):
    print(f"FAIL: {platform} expected {len(files['assets'])} assets, manifest has {len(manifest['assets'])}")
    sys.exit(1)

for entry in files['assets']:
    data = (dist / entry['path']).read_bytes()
    found = next((a for a in manifest['assets'] if a['hash'] == b64url(data)), None)
    if not found:
        print(f"FAIL: {platform} manifest is missing {entry['path']}"); sys.exit(1)
    # Metro names assets by their MD5, so the key must equal the filename.
    if found['key'] != hashlib.md5(data).hexdigest():
        print(f"FAIL: {platform} asset key is not the content MD5"); sys.exit(1)
    if found['key'] != Path(entry['path']).name:
        print(f"FAIL: {platform} asset key does not match Metro's own filename"); sys.exit(1)

# Every URL must serve back exactly the bytes it claims.
for asset in [manifest['launchAsset'], *manifest['assets']]:
    served = urllib.request.urlopen(asset['url']).read()
    if b64url(served) != asset['hash']:
        print(f"FAIL: bytes at {asset['url']} do not hash to the manifest value"); sys.exit(1)

size = len(bundle) / 1024 / 1024
print(f"  ok: {platform} manifest verified ({size:.1f} MB bundle, {len(manifest['assets'])} asset(s)) ")
PY
done

echo "==> the expo config rides along as extra.expoClient"
if [ -f "${APP_DIR}/dist/expoConfig.json" ]; then
  grep -q 'expoClient' "/tmp/updraft-manifest-ios.txt" \
    || fail "expoConfig.json was exported but did not reach the manifest"
  pass "extra.expoClient present"
fi

echo "==> updates list surfaces the group id"
list=$(node "${CLI}" updates list --server "${BASE}" --app example-app --channel staging)
echo "${list}" | sed 's/^/    /' | head -5
group=$(echo "${list}" | awk 'NR==2 {print $1}')
[ -n "${group}" ] || fail "could not read a group id from the list output"
pass "group ${group} listed"

echo "==> rollback then republish"
node "${CLI}" rollback --server "${BASE}" --app example-app \
  --channel staging --runtime-version 1.0.0 >/dev/null
rolled=$(curl -fsS "${BASE}/api/manifest/example-app" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'expo-channel-name: staging' \
  -H 'accept: multipart/mixed')
echo "${rolled}" | grep -q 'rollBackToEmbedded' || fail "expected a rollback directive"
pass "clients receive a rollback directive"

node "${CLI}" updates republish --server "${BASE}" --group-id "${group}" >/dev/null
restored=$(curl -fsS "${BASE}/api/manifest/example-app" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'expo-channel-name: staging' \
  -H 'accept: multipart/mixed')
echo "${restored}" | grep -q 'launchAsset' || fail "republish did not restore the manifest"
pass "republish restored the update"

rm -f /tmp/updraft-manifest-*.txt
echo
echo "REAL EXPORT E2E PASSED"
