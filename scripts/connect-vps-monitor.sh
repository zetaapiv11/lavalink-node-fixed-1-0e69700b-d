#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $# != 2 || ! $1 =~ ^tea-[a-z0-9]+$ || ! $2 =~ ^srv-[a-z0-9]+$ ]]; then
  echo 'Usage: bash scripts/connect-vps-monitor.sh WORKSPACE_ID WORKER_ID' >&2
  exit 1
fi
[[ -f deploy/vps/.env ]] || { echo 'Konfigurasi VPS belum ada. Jalankan installer terlebih dahulu.' >&2; exit 1; }
command -v docker >/dev/null
# Read from the terminal; the script sent to Node will use stdin separately.
read -r -s -p 'API key Render (input disembunyikan, tidak disimpan): ' RENDER_API_KEY </dev/tty
printf '\n' >&2
[[ -n $RENDER_API_KEY ]] || { echo 'API key kosong.' >&2; exit 1; }
export RENDER_API_KEY
export RENDER_WORKSPACE_ID=$1 RENDER_WORKER_ID=$2
trap 'unset RENDER_API_KEY' EXIT
# The API key is inherited by name; it is not embedded in command arguments.
# Existing image/env supply MONITOR_TOKEN and VPS_DOMAIN. No new image or restart.
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml run -T --rm --no-deps \
  -e RENDER_API_KEY -e RENDER_WORKSPACE_ID -e RENDER_WORKER_ID \
  --entrypoint node audio --input-type=module < scripts/connect-vps-monitor.mjs
