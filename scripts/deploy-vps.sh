#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  cd /opt/mcp-telegram
  if [[ "$SSH_ORIGINAL_COMMAND" =~ ^deploy\ (ghcr\.io/terowoc/mcp-telegram@sha256:[a-f0-9]{64})$ ]]; then
    image="${BASH_REMATCH[1]}"
  else echo 'Invalid deploy command' >&2; exit 2; fi
else image="${1:-}"; fi
[[ "$image" =~ ^ghcr\.io/terowoc/mcp-telegram@sha256:[a-f0-9]{64}$ ]] || { echo 'Immutable image required' >&2; exit 2; }
exec 9>.deploy.lock
flock -n 9 || { echo 'Deployment already running' >&2; exit 1; }
# Preserve the explicit production feature choice across releases. Do not
# export it: rollback must resolve the previous deployment.env independently.
instagram="${MCP_INSTAGRAM_ENABLED:-}"
if [[ -z "$instagram" && -f deployment.env ]]; then
  instagram="$(sed -n 's/^MCP_INSTAGRAM_ENABLED=//p' deployment.env)"
fi
instagram="${instagram:-0}"
[[ "$instagram" == 0 || "$instagram" == 1 ]] || {
  echo 'Invalid Instagram feature flag; previous service is unchanged' >&2; exit 2;
}
unset MCP_INSTAGRAM_ENABLED
# The master key is provisioned separately, never generated or replaced on deploy.
python3 - <<'PY'
import os, stat
s=os.lstat('session-key.bin')
if not stat.S_ISREG(s.st_mode) or s.st_size != 32 or s.st_mode & 0o077:
    raise SystemExit('Invalid private session key; previous service is unchanged')
PY
for directory in data data/auth data/files backups releases; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || {
    echo 'Storage must be a private project directory' >&2; exit 1;
  }
done
available_mb="$(free -m | awk '/^Mem:/{print $7}')"
[[ "$available_mb" =~ ^[0-9]+$ ]] || { echo 'Cannot measure available VPS memory' >&2; exit 1; }
if (( available_mb >= 6144 )); then workers=4; memory=3g
elif (( available_mb >= 2560 )); then workers=2; memory=1536m
else echo 'Insufficient memory headroom; previous service is unchanged' >&2; exit 1; fi
registry_dir="$(mktemp -d)"
export DOCKER_CONFIG="$registry_dir"
trap 'rm -rf "$registry_dir"' EXIT
docker login ghcr.io --username terowoc --password-stdin >/dev/null
docker pull "$image" >/dev/null
release="releases/${image##*:}-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$release"
docker run --rm --network none --read-only --memory 64m --cpus 0.25 --pids-limit 16 --entrypoint cat \
  "$image" /app/deployment/compose.production.yaml > "$release/compose.yaml"
printf 'MCP_IMAGE=%s\nMCP_SAAS_MAX_WORKERS=%s\nMCP_MEMORY_LIMIT=%s\nMCP_INSTAGRAM_ENABLED=%s\n' "$image" "$workers" "$memory" "$instagram" > "$release/deployment.env"
compose() { docker compose --project-directory "$PWD" --env-file deployment.env -f compose.yaml -p mcp-telegram "$@"; }
docker compose --project-directory "$PWD" --env-file "$release/deployment.env" -f "$release/compose.yaml" -p mcp-telegram config --quiet
# Validate the same non-root runtime's key access and server config before stopping anything.
docker run --rm --network none --read-only --memory 256m --cpus 0.25 --pids-limit 32 \
  --env-file telegram.env -e MCP_PUBLIC_URL=https://tg-mcp.azimboev.uz \
  -e MCP_AUTH_DIR=/data/auth -e MCP_SESSION_KEY_FILE=/run/secrets/session-key \
  -e MCP_TELEGRAM_FILE_ROOT=/data/files -e MCP_SAAS_MAX_WORKERS="$workers" \
  -v "$PWD/session-key.bin:/run/secrets/session-key:ro" --entrypoint node "$image" \
  --max-old-space-size=128 --input-type=module -e \
  'import {configFromEnv} from "./dist/saas/main.js"; import {loadVaultKey} from "./dist/saas/session-vault.js"; const c=configFromEnv(); await loadVaultKey(c.sessionKeyFile);'
if [[ "$instagram" == 1 ]]; then
  # Validate the pinned Python runtime before touching the running service.
  docker run --rm --network none --read-only --memory 256m --cpus 0.25 --pids-limit 16 \
    --entrypoint /opt/instagram/bin/python "$image" /app/dist/instagram/worker.py --check
fi
wait_ready() {
  local container status attempt
  container="$(compose ps -q mcp)" || return 1
  [[ -n "$container" ]] || return 1
  for attempt in $(seq 1 36); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$container")" || return 1
    [[ "$status" != healthy ]] || return 0
    [[ "$status" != unhealthy ]] || return 1
    sleep 5
  done
  return 1
}
had_container=false
previous_container=""
if [[ -f deployment.env && -f compose.yaml ]]; then
  previous_container="$(compose ps -a -q mcp)"
  [[ -z "$previous_container" ]] || had_container=true
fi
snapshot="backups/auth-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$snapshot"
for file in deployment.env compose.yaml current-release previous-release; do
  [[ ! -f "$file" ]] || cp -a "$file" "$snapshot/$file"
done
changed=false
rollback() {
  [[ "$changed" == true ]] || return
  echo 'Deployment failed; restoring coherent previous service' >&2
  if ! compose stop mcp; then
    echo 'Rollback failed: replacement did not stop; auth storage left intact' >&2
    return
  fi
  if [[ -d "$snapshot/auth" ]]; then
    cp -a "$snapshot/auth" "data/auth.restore-$$"
    [[ ! -d data/auth ]] || mv data/auth "data/auth.failed-$$"
    mv "data/auth.restore-$$" data/auth
  elif [[ -f "$snapshot/auth-was-absent" && -d data/auth ]]; then
    mv data/auth "data/auth.failed-$$"
  fi
  for file in deployment.env compose.yaml current-release previous-release; do
    if [[ -f "$snapshot/$file" ]]; then cp -a "$snapshot/$file" "$file"; else rm -f "$file"; fi
  done
  if [[ "$had_container" == true ]]; then
    if ! compose up -d --no-deps mcp || ! wait_ready; then
      echo 'Rollback failed: previous service did not become healthy' >&2
    fi
  fi
}
on_failure() {
  trap - ERR INT TERM
  rollback
  exit 1
}
trap on_failure ERR INT TERM
changed=true
if [[ "$had_container" == true ]]; then
  compose stop mcp
  [[ "$(docker inspect --format '{{.State.Running}} {{.State.ExitCode}}' "$previous_container")" == 'false 0' ]] || {
    echo 'Previous service did not finish graceful worker shutdown' >&2; on_failure;
  }
fi
# All workers have exited before SQLite/WAL/OAuth stores are copied together.
if [[ -d data/auth ]]; then cp -a data/auth "$snapshot/auth.tmp"; mv "$snapshot/auth.tmp" "$snapshot/auth"
else touch "$snapshot/auth-was-absent"; fi
cp "$release/compose.yaml" compose.yaml
cp "$release/deployment.env" deployment.env
compose up -d --no-deps mcp
if ! wait_ready; then on_failure; fi
[[ ! -f current-release ]] || cp current-release previous-release
printf '%s\n' "$release" > current-release.tmp
mv current-release.tmp current-release
changed=false
trap - ERR INT TERM
printf 'Deployed %s (workers=%s, memory=%s, instagram=%s)\n' "$image" "$workers" "$memory" "$instagram"
# Versioned release configurations, failed auth directories and backups are retained.
