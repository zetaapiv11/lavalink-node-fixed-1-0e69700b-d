# VPS installation — Node 02

## Prerequisites

- A Linux VPS with at least 2 GiB RAM for the provided 1 GiB Java heap plus gateway/OS; capacity must be measured with actual load.
- Docker Engine with Compose v2 installed using the [official OS-specific Docker instructions](https://docs.docker.com/engine/install/). Do not run this VPS setup in the website container.
- Public DNS A record (and AAAA only if working IPv6) for a dedicated audio domain, directed to the VPS.
- Inbound TCP 443 for HTTPS/WSS, TCP 80 for ACME/redirect, and your administration SSH port. Never publish 2333. Port 10000 is bound only to loopback.
- Outbound DNS, HTTPS to source/Discord endpoints, UDP voice traffic to Discord, and TCP 5432 to the external Render PostgreSQL host. Do not constrain voice UDP to the website's TCP 443 port.
- In Render database settings, allowlist **only the VPS public egress IP** (and any necessary private administration sources) for external DB access. Use the external database URL and verified TLS. `ipAllowList: []` in the Blueprint initially prevents all external DB access.

## Install

```bash
# Use your normal repository checkout, then:
npm ci # only necessary here if running migration/bot utilities outside Docker
cp deploy/vps/.env.example deploy/vps/.env
chmod 600 deploy/vps/.env
# Edit private .env; supply VPS_DOMAIN, ACME_EMAIL, external DATABASE_URL,
# unique LAVALINK_SERVER_PASSWORD and unique MONITOR_TOKEN.
# Run the database migration from the Render deployment first.
./install-vps.sh
```

`NODE_ID=vps`, internal port 2333 and gateway port 10000 are set in Compose. Caddy proxies HTTP and WebSocket upgrades on its container network and obtains/renews public TLS certificates automatically. Certificate state is retained in named Docker volumes; keep these volumes on restart/upgrade. Audio source/plugin artifacts may be downloaded again on container replacement.

## Verify

```bash
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml ps
curl --fail https://audio.example.com/healthz
# Inspect private logs locally; redact before sharing.
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml logs --tail 80 audio
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml logs --tail 80 caddy
```

Create an approved Node 02 client credential via the website. Export `LAVALINK_URL=https://audio.example.com` and `LAVALINK_CLIENT_KEY` privately into the bot process. Use port 443/secure=true. Run `PLAYBACK_NODE_ID=vps npm run test:playback` with Discord credentials, guild and voice channel.

Configure the Render worker `NODE_VPS_URL` and `MONITOR_VPS_TOKEN` to match VPS gateway `MONITOR_TOKEN`. Public dashboard should show a new measured sample; it should still say playback unverified until listening evidence exists.

## Upgrades and rollback

Back up the database before migrations and note the current git revision/image ID. Build from the pinned lockfile and Lavalink tag. Run `docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml up -d --build --wait`; this can interrupt active audio. Reconnect/resume is bounded and a new player may be needed. For rollback, deploy the previously validated image and a compatible schema; do not blindly reverse production SQL or delete persistent volumes.

Rotate a leaked client key using dashboard revoke/create. Rotate internal password and monitor token independently on the affected node and update worker secrets. Do not log raw values. A website account suspension revokes all its keys.

## Port 80

Caddy may redirect HTTP to HTTPS, but clients must originate at HTTPS. An Authorization header sent to HTTP is exposed before the redirect. Public HTTP origins are rejected by the supplied client/worker. A successful curl to an HTTP health endpoint is not a secure connection test.

## Resource and credential isolation

Gateway DB access is needed to enforce revocation and session ownership. Treat each gateway as a trusted backend with access to the service database, restrict database networks, keep OS/Docker patched, and protect environment files. The initial deployment uses one application DB role; for stricter isolation, provision separate least-privilege DB roles for web, monitor and gateway and validate their table grants before rollout. Caddy does not require database/node secrets; its service should receive only its domain/ACME variables.
