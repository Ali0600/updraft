#!/usr/bin/env bash
#
# End-to-end smoke test with S3 storage and CDN-style direct delivery.
#
# The in-process suite drives S3Storage directly; this proves the container
# works when configured for it — that createStorage wires the driver from real
# environment variables, that a publish through the real CLI lands in the
# bucket, and that an asset fetched straight from the store is byte-identical
# to the one the server proxies. The equivalence of those two paths is the
# whole promise of direct delivery, so it is asserted rather than assumed.
#
# Usage: scripts/e2e-s3.sh [port]
set -euo pipefail

PORT="${1:-39150}"
MINIO_PORT=39151
IMAGE="updraft:e2e-s3"
CONTAINER="updraft-e2e-s3-$$"
MINIO="updraft-e2e-minio-$$"
NETWORK="updraft-e2e-net-$$"
BASE="http://localhost:${PORT}"
MINIO_BASE="http://localhost:${MINIO_PORT}"
BUCKET="updraft-e2e"
TOKEN="e2e-token-0123456789abcdef0123456789abcdef"
# Test-only credentials for containers bound to loopback and destroyed on exit.
MINIO_USER="updraft-e2e-key"
MINIO_PASS="updraft-e2e-secret-0123456789"
MINIO_IMAGE="minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${ROOT}/packages/server/test/fixtures/export-basic"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "${CONTAINER}" "${MINIO}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

echo "==> building image"
docker build -f "${ROOT}/docker/Dockerfile" -t "${IMAGE}" "${ROOT}" >/dev/null
(cd "${ROOT}" && pnpm --filter '@ota/cli...' build >/dev/null 2>&1)

echo "==> starting MinIO and the server"
docker network create "${NETWORK}" >/dev/null
docker run -d --name "${MINIO}" --network "${NETWORK}" \
  -p "127.0.0.1:${MINIO_PORT}:9000" \
  -e "MINIO_ROOT_USER=${MINIO_USER}" \
  -e "MINIO_ROOT_PASSWORD=${MINIO_PASS}" \
  "${MINIO_IMAGE}" server /data >/dev/null

for _ in $(seq 1 60); do
  curl -fsS "${MINIO_BASE}/minio/health/live" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "${MINIO_BASE}/minio/health/live" >/dev/null || fail "MinIO did not start"

# Create the bucket and make it publicly readable, which is what direct
# delivery requires and what the deployment docs describe.
# Run from the package that depends on the SDK, so the bare specifier resolves.
(cd "${ROOT}/packages/server" && node --input-type=module -e "$(cat <<NODE
import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
const client = new S3Client({
  endpoint: '${MINIO_BASE}',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: '${MINIO_USER}', secretAccessKey: '${MINIO_PASS}' },
});
await client.send(new CreateBucketCommand({ Bucket: '${BUCKET}' }));
await client.send(new PutBucketPolicyCommand({
  Bucket: '${BUCKET}',
  Policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::${BUCKET}/*'],
    }],
  }),
}));
NODE
)")
pass "bucket created and made publicly readable"

docker run -d --name "${CONTAINER}" --network "${NETWORK}" \
  -p "127.0.0.1:${PORT}:3000" \
  -e "PUBLIC_URL=${BASE}" \
  -e "PUBLISH_TOKEN=${TOKEN}" \
  -e STORAGE_DRIVER=s3 \
  -e "S3_BUCKET=${BUCKET}" \
  -e "S3_ENDPOINT=http://${MINIO}:9000" \
  -e "S3_ACCESS_KEY_ID=${MINIO_USER}" \
  -e "S3_SECRET_ACCESS_KEY=${MINIO_PASS}" \
  -e "ASSETS_BASE_URL=${MINIO_BASE}/${BUCKET}" \
  "${IMAGE}" >/dev/null

for _ in $(seq 1 60); do
  curl -fsS "${BASE}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "${BASE}/healthz" >/dev/null || {
  docker logs "${CONTAINER}" >&2
  fail "server did not start with STORAGE_DRIVER=s3"
}
pass "server started against S3 storage"

echo "==> publishing through the real CLI"
export UPDRAFT_PUBLISH_TOKEN="${TOKEN}"
node "${ROOT}/packages/cli/dist/index.js" apps create \
  --server "${BASE}" --slug demo --name Demo >/dev/null
node "${ROOT}/packages/cli/dist/index.js" publish \
  --dir "${FIXTURE}" --server "${BASE}" --app demo \
  --channel production --runtime-version 1.0.0 >/dev/null
pass "published into the bucket"

echo "==> checking the manifest addresses the bucket"
curl -fsS -o "${WORK}/manifest.txt" \
  -H 'expo-protocol-version: 1' -H 'expo-platform: ios' \
  -H 'expo-runtime-version: 1.0.0' -H 'accept: multipart/mixed' \
  -H 'expo-channel-name: production' \
  "${BASE}/api/manifest/demo"

ASSET_URL="$(grep -o "${MINIO_BASE}/${BUCKET}/assets/[a-f0-9]\{64\}" "${WORK}/manifest.txt" | head -1)"
[ -n "${ASSET_URL}" ] || {
  cat "${WORK}/manifest.txt" >&2
  fail "manifest does not address assets at ASSETS_BASE_URL"
}
pass "manifest points at the bucket: ${ASSET_URL##*/}"

HASH="${ASSET_URL##*/}"

echo "==> comparing the two delivery paths"
# Straight from the object store, exactly as a device would in direct mode.
curl -fsS -o "${WORK}/direct.bin" "${ASSET_URL}"
DIRECT_TYPE="$(curl -fsS -o /dev/null -w '%{content_type}' "${ASSET_URL}")"

# And through the server, which deployed devices still use.
curl -fsS -o "${WORK}/proxied.bin" "${BASE}/assets/${HASH}"
PROXY_TYPE="$(curl -fsS -o /dev/null -w '%{content_type}' "${BASE}/assets/${HASH}")"

[ "$(sha256 "${WORK}/direct.bin")" = "${HASH}" ] || fail "bytes from the bucket do not hash to their address"
pass "bytes fetched from the bucket hash to their own address"

cmp -s "${WORK}/direct.bin" "${WORK}/proxied.bin" || fail "the two delivery paths return different bytes"
pass "bucket and proxy return identical bytes"

[ "${DIRECT_TYPE%%;*}" = "${PROXY_TYPE%%;*}" ] \
  || fail "content type differs: bucket '${DIRECT_TYPE}' vs proxy '${PROXY_TYPE}'"
pass "both paths report content type '${DIRECT_TYPE%%;*}'"

echo
echo "PASSED: S3 storage and direct delivery work end to end"
