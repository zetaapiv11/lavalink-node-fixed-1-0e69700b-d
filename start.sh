#!/usr/bin/env bash
set -Eeuo pipefail
: "${LAVALINK_SERVER_PASSWORD:?Missing internal node password}"
: "${MONITOR_TOKEN:?Missing monitoring token}"
: "${DATABASE_URL:?Missing PostgreSQL URL}"
: "${NODE_ID:?Use render or vps}"
if (( ${#LAVALINK_SERVER_PASSWORD} < 32 || ${#MONITOR_TOKEN} < 32 )); then
  echo 'Node secrets must have at least 32 characters.' >&2
  exit 1
fi
cd /opt/Lavalink
java -Xms256M -Xmx1024M -jar Lavalink.jar &
java_pid=$!
cd /opt/service
node --import tsx services/gateway.ts &
gateway_pid=$!
cleanup() { kill "$java_pid" "$gateway_pid" 2>/dev/null || true; wait "$java_pid" "$gateway_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 143' TERM INT
wait -n "$java_pid" "$gateway_pid"
exit 1
