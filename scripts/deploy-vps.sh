#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Production forced command always starts in this root-owned directory.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  cd /opt/mcp-telegram
  if [[ "$SSH_ORIGINAL_COMMAND" =~ ^deploy\ (ghcr\.io/terowoc/mcp-telegram@sha256:[a-f0-9]{64})$ ]]; then
    image="${BASH_REMATCH[1]}"
  else
    echo 'Invalid deploy command' >&2; exit 2
  fi
else
  image="${1:-}"
fi
if [[ ! "$image" =~ ^ghcr\.io/terowoc/mcp-telegram@sha256:[a-f0-9]{64}$ ]]; then
  echo 'An immutable Telegram MCP image digest is required' >&2; exit 2
fi
exec 9>.deploy.lock
flock -n 9 || { echo 'Deployment already running' >&2; exit 1; }
registry_dir="$(mktemp -d)"
export DOCKER_CONFIG="$registry_dir"
trap 'rm -rf "$registry_dir"' EXIT
# The Actions token arrives via encrypted stdin, never via an argument or env file.
docker login ghcr.io --username terowoc --password-stdin >/dev/null
docker pull "$image" >/dev/null
compose() { docker compose --env-file deployment.env -f compose.yaml -p mcp-telegram "$@"; }
wait_ready() {
  local container status attempt
  container="$(compose ps -q mcp)" || return 1
  [[ -n "$container" ]] || return 1
  for attempt in $(seq 1 36); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$container")" || return 1
    if [[ "$status" == healthy ]]; then return 0; fi
    if [[ "$status" == unhealthy ]]; then return 1; fi
    sleep 5
  done
  return 1
}
had_container=false
if [[ -f deployment.env ]] && [[ -n "$(compose ps -a -q mcp)" ]]; then had_container=true; fi
previous_env="$(mktemp)"
[[ ! -f deployment.env ]] || cp deployment.env "$previous_env"
snapshot="backups/auth-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$snapshot"
changed=false
rollback() {
  if [[ "$changed" != true ]]; then return; fi
  echo 'Deployment failed; restoring previous service' >&2
  if ! compose stop mcp; then
    echo 'Rollback failed: replacement did not stop; auth storage left intact' >&2
    changed=false
    return
  fi
  if [[ -d "$snapshot/auth" ]]; then
    cp -a "$snapshot/auth" "data/auth.restore-$$"
    mv data/auth "data/auth.failed-$$"
    mv "data/auth.restore-$$" data/auth
  fi
  if [[ -s "$previous_env" ]]; then cp "$previous_env" deployment.env; fi
  if [[ "$had_container" == true ]]; then
    if ! compose up -d --no-deps mcp || ! wait_ready; then
      echo 'Rollback failed: previous service did not become healthy' >&2
    fi
  fi
  rm -f "$previous_env"
}
trap 'rollback; exit 1' ERR INT TERM
changed=true
if [[ "$had_container" == true ]]; then compose stop mcp; fi
# No owner writes SQLite while this consistent backup is taken.
if [[ -d data/auth ]]; then cp -a data/auth "$snapshot/auth.tmp"; mv "$snapshot/auth.tmp" "$snapshot/auth"; fi
printf 'MCP_IMAGE=%s\n' "$image" > deployment.env
compose up -d --no-deps mcp
if ! wait_ready; then rollback; exit 1; fi
changed=false
rm -f "$previous_env"
trap - ERR INT TERM
printf 'Deployed %s\n' "$image"
# Backups intentionally retained; no global image or volume cleanup.
