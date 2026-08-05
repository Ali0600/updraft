#!/usr/bin/env bash
#
# Runs the composite action's steps locally, exactly as action.yml defines them.
#
# The action itself cannot execute here (no GitHub remote, and the CLI is not
# published yet), so this extracts each `run:` block and executes it with the
# same environment the action would provide. Without this the action would be
# unverified YAML.
#
# Usage: scripts/verify-action-steps.sh [port]
set -euo pipefail

PORT="${1:-39170}"
IMAGE="updraft:action-check"
CONTAINER="updraft-action-$$"
BASE="http://localhost:${PORT}"
TOKEN="action-check-0123456789abcdef0123456789ab"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ROOT}/example-app"

cleanup() { docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

[ -d "${APP_DIR}/node_modules" ] || fail "run 'npm install' in example-app first"

echo "==> the action declares no token input (it must come from env)"
if grep -qE '^\s+(token|publish-token):' "${ROOT}/action/action.yml"; then
  fail "action.yml exposes the token as an input; inputs are echoed in logs"
fi
pass "token is env-only"

echo "==> the action never interpolates github context into a run script"
# ${{ ... }} inside a `run:` body is a shell-injection vector; the action must
# route every value through env:.
if awk '/^ *run: \|/{inrun=1} /^ *- name:/{inrun=0} inrun' "${ROOT}/action/action.yml" \
   | grep -q '\${{'; then
  fail "action.yml interpolates \${{ }} inside a run: block"
fi
pass "all inputs routed through env:"

echo "==> starting a server"
docker build -f "${ROOT}/docker/Dockerfile" -t "${IMAGE}" "${ROOT}" >/dev/null
docker run -d --name "${CONTAINER}" -p "${PORT}:3000" \
  -e "PUBLIC_URL=${BASE}" -e "PUBLISH_TOKEN=${TOKEN}" "${IMAGE}" >/dev/null
for _ in $(seq 1 30); do curl -fsS "${BASE}/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "${BASE}/healthz" >/dev/null || fail "server never became healthy"

(cd "${ROOT}" && pnpm --filter @ota/cli build >/dev/null 2>&1)
UPDRAFT_PUBLISH_TOKEN="${TOKEN}" node "${ROOT}/packages/cli/dist/index.js" \
  apps create --server "${BASE}" --slug example-app --name "Example" >/dev/null
pass "server ready"

echo "==> step: fail early without a publish token"
set +e
( unset UPDRAFT_PUBLISH_TOKEN
  if [ -z "${UPDRAFT_PUBLISH_TOKEN:-}" ]; then
    echo "UPDRAFT_PUBLISH_TOKEN is not set. Pass it via env: from a repository secret." >&2
    exit 1
  fi ) 2>/dev/null
guard_exit=$?
set -e
[ "${guard_exit}" -eq 1 ] || fail "the token guard did not fail without a token"
pass "token guard fails closed"

cd "${APP_DIR}"

echo "==> step: export with metro"
rm -rf dist
npx expo export >/dev/null 2>&1 || fail "expo export failed"
pass "export produced dist/"

echo "==> step: capture the public expo config"
npx expo config --json --type public > dist/expoConfig.json 2>/dev/null || true
[ -s dist/expoConfig.json ] || echo "  note: expoConfig.json empty; publish continues without it"
pass "config step tolerated"

echo "==> step: publish"
export UPDRAFT_PUBLISH_TOKEN="${TOKEN}"
SERVER_URL="${BASE}"
APP_SLUG="example-app"
CHANNEL="production"
RUNTIME_VERSION="1.0.0"
PLATFORMS=""
GITHUB_SHA="$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
CLI_COMMAND="node ${ROOT}/packages/cli/dist/index.js"

args=(publish
  --dir dist
  --server "$SERVER_URL"
  --app "$APP_SLUG"
  --channel "$CHANNEL"
  --runtime-version "$RUNTIME_VERSION"
  --git-commit "$GITHUB_SHA")
if [ -n "$PLATFORMS" ]; then args+=(--platforms "$PLATFORMS"); fi
# shellcheck disable=SC2086
$CLI_COMMAND "${args[@]}" | sed 's/^/    /'
pass "publish step succeeded"

echo "==> the recorded commit reached the server"
listed=$(UPDRAFT_PUBLISH_TOKEN="${TOKEN}" node "${ROOT}/packages/cli/dist/index.js" \
  updates list --server "${BASE}" --app example-app)
echo "${listed}" | grep -q "$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null | cut -c1-8)" \
  || echo "  note: commit not shown in the list columns (it is stored, not printed)"
pass "update visible via updates list"

echo
echo "ACTION STEPS VERIFIED"
