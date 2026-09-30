#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v docker >/dev/null || { echo 'Install Docker Engine and Compose v2 for your VPS OS first.' >&2; exit 1; }
docker compose version >/dev/null
if [[ ! -f deploy/vps/.env ]]; then
  echo 'Copy deploy/vps/.env.example to deploy/vps/.env, fill secrets and TLS domain, then retry.' >&2
  exit 1
fi
chmod 600 deploy/vps/.env
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml build --pull
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml up -d --wait --wait-timeout 180
echo 'Containers started. Verify HTTPS/WSS and run the Discord playback test before opening public access.'
