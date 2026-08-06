#!/usr/bin/env bash
# Starts MinIO for the S3 storage tests and waits until it answers.
#
# A `docker run` step rather than a `services:` block, because service
# containers cannot pass a command and minio/minio does nothing without
# `server /data`. Pinned by digest for the same reason every third-party
# action in this repo is pinned by SHA.
#
# The credentials below are test-only, for a container bound to loopback and
# destroyed with the runner. They are deliberately not "minioadmin", so that
# scanning this repository for real-looking credentials never matches here.
set -euo pipefail

MINIO_IMAGE="minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"

docker run -d --name updraft-minio \
  -p 127.0.0.1:9000:9000 \
  -e MINIO_ROOT_USER=updraft-test-key \
  -e MINIO_ROOT_PASSWORD=updraft-test-secret-0123456789 \
  "$MINIO_IMAGE" server /data

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
    echo "MinIO is up"
    exit 0
  fi
  sleep 1
done

echo "MinIO did not become ready" >&2
docker logs updraft-minio >&2 || true
exit 1
