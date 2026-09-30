# VPS installation — Node 02

## Prerequisites

- A Linux VPS with at least 2 GiB RAM for the provided 1 GiB Java heap plus gateway/OS; capacity must be measured with actual load.
- Docker Engine with Compose v2 installed using the [official OS-specific Docker instructions](https://docs.docker.com/engine/install/). Do not run this VPS setup in the website container.
- Public DNS A record (and AAAA only if working IPv6) for a dedicated audio domain, directed to the VPS.
- Inbound TCP 443 for HTTPS/WSS, TCP 80 for ACME/redirect, and your administration SSH port. Never publish 2333. Port 10000 is bound only to loopback.
- Outbound DNS, HTTPS to source/Discord endpoints, UDP voice traffic to Discord, and TCP 5432 to the external Render PostgreSQL host. Do not constrain voice UDP to the website's TCP 443 port.
- In Render database settings, allowlist **only the VPS public egress IP** (and any necessary private administration sources) for external DB access. Use the external database URL and verified TLS. `ipAllowList: []` in the Blueprint initially prevents all external DB access.

## One-command install (no manual .env editing)

On a fresh **Ubuntu 22.04/24.04/26.04 or Debian 12/13** VPS with sudo/root access, run from an interactive SSH terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/zetaapiv11/lavalink-node-fixed-1-0e69700b-d/coderabbit/build-public-lavalink-service/63eaecea/scripts/bootstrap-vps.sh -o /tmp/resonance-bootstrap.sh && sudo bash /tmp/resonance-bootstrap.sh
```

The bootstrap is downloaded before execution, installs Git/OpenSSL/Docker Engine/Compose using Docker's official apt repository when Docker is absent, and clones the task branch into `/opt/resonance`. It refuses unsupported OS versions and unrelated existing directories. Existing Docker installations must already provide Compose; conflicting container runtimes are not removed automatically. The initial download requires `curl`.

Answer only three questions: **audio domain**, **certificate email**, and **Render external PostgreSQL URL** (hidden input). The installer generates independent passwords automatically and writes a private `deploy/vps/.env` with mode 600. No editor is needed. A repeat invocation reuses the installed revision and credentials; it does not pull updates or reset local edits. Keep the generated file backed up privately.

DNS, inbound 80/443, outbound Discord UDP, Render's database IP allowlist, and the Render website's database migration must already be ready (see prerequisites). The VPS cannot create or configure resources in your Render/Discord/DNS accounts without access to those accounts. The installer verifies database connectivity with certificate validation and the migrated VPS node row before starting the stack. It then waits for containers and public HTTPS `/healthz`. Failure returns a nonzero exit status and never claims working voice playback. Existing active containers are not torn down on a preflight failure.

**Token meanings:** the generated `LAVALINK_SERVER_PASSWORD` is internal only; `MONITOR_TOKEN` belongs in the Render worker's `MONITOR_VPS_TOKEN`. Set worker `NODE_VPS_URL` to your HTTPS audio URL. These Render settings still require the operator's Render account; this VPS installer does not modify them. Obtain the bot's public client key through the website dashboard after approval. Obtain `DISCORD_TOKEN` through Discord Developer Portal → Bot → Reset Token. Never paste secrets into chat or commit the generated file.

For an existing checkout with Docker/Compose, curl, OpenSSL and flock installed:

```bash
sudo bash ./install-vps.sh
```

It uses the same three prompts on first run. `bash ./install-vps.sh --configure-only` generates/validates configuration without building or starting containers. For an empty or invalid pre-existing configuration, the installer fails without overwriting it; restore its private backup before retrying. Upgrades are explicit (see below), not hidden in repeated installation.

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

## Installer verification

Run `npm run test:installer` and `bash -n install-vps.sh scripts/bootstrap-vps.sh`. The installer suite uses real shell subprocesses and cryptographic randomness with synthetic Docker/network commands for failure paths, plus real Docker Compose parsing for URL escaping and secret isolation. It does not prove apt/systemd installation on a fresh VPS, certificate issuance, or audible Discord voice; those need the target host and account access.

## Build fails with “Unable to locate package” / “no installation candidate”

If this happens for Java, ca-certificates and tini together at Dockerfile's apt step, inspect the preceding apt repository download errors. The package messages alone cannot identify DNS, firewall, proxy, or repository availability failures. It is unrelated to old application data; do not delete volumes to fix it. A build warning about missing Git metadata is separate from the fatal apt error.

The image now downloads Debian packages over verified HTTPS with bounded retries, and treats any failed repository update as a build failure. The initial CA bundle comes from the pinned official Lavalink image; Debian's CA package is then installed normally. TLS verification and package signature checks remain enabled.

For the bootstrap's default checkout, update and retry without editing or deleting private configuration:

```bash
cd /opt/resonance && git pull --ff-only origin coderabbit/build-public-lavalink-service/63eaecea && bash ./install-vps.sh
```

Run as the same operator/root used for installation. If Git reports local changes or diverged history, stop and inspect them; do not reset the checkout or delete `.env`. If apt still fails, retain the earlier repository error lines (not only the final package messages) and diagnose Docker's outbound DNS/HTTPS connectivity. Do not disable TLS/signature verification or blindly change the host DNS.

## Image built, but database preflight failed

`Image vps-audio Built` followed by a database failure means Docker build succeeded. Do not delete application data or regenerate node passwords. Update this checkout and run only the database check to obtain a safe diagnostic code:

```bash
cd /opt/resonance && git pull --ff-only origin coderabbit/build-public-lavalink-service/63eaecea && bash ./install-vps.sh --check-database
```

This builds the current image and checks connectivity/schema, then exits without starting the stack. It does not stop existing services. Only fixed diagnostic messages are shown; no raw PostgreSQL error, URL or password is printed.

| Code | Next action |
| --- | --- |
| `DB_URL` / `DB_NAME` | Copy the correct External Database URL from the Render database's Connect menu. |
| `DB_DNS` | Ensure this is the External URL, not the private Internal URL; verify Docker DNS. |
| `DB_NETWORK` | Check database availability, VPS egress IP allowlist in Render, and outbound TCP 5432. |
| `DB_AUTH` | Check current database credentials and Render's allowed IPs; an access denial alone does not prove which is wrong. |
| `DB_MIGRATION` | Run `npm run migrate` in the Render website service Shell using this database, then retry. |
| `DB_PERMISSION` | Check application DB role grants. |
| `DB_TLS` | Check hostname, system clock and certificate chain. Keep verified TLS enabled. |
| `DB_UNKNOWN` | Cause not classified; investigate privately without sharing raw credentials. |

If the URL was entered incorrectly, no editor is needed:

```bash
cd /opt/resonance && bash ./install-vps.sh --database-url
```

Paste the new URL at the hidden prompt. Only `DATABASE_URL` is replaced atomically, with mode600; node password, monitor token, domain and other settings are preserved. Interrupted input leaves the original file intact. The installer then checks the database and proceeds with normal deployment. This does not create a Render database or run production migrations automatically. Once an external setting is fixed, rerun `bash ./install-vps.sh` normally.

## Connect VPS monitoring to the Render worker without editing .env

An HTTPS-ready VPS can still appear UNKNOWN in the dashboard until the worker has its monitoring URL **and the matching private token**. On the VPS, update the checkout, then run:

```bash
bash scripts/connect-vps-monitor.sh YOUR_RENDER_WORKSPACE_ID YOUR_RENDER_MONITOR_WORKER_ID
```

Use the existing workspace and `resonance-monitor` worker IDs from your Render account. Paste a Render API key into the hidden terminal prompt (the key value only, without `Bearer`). Do not send the key or the monitor token through chat. The helper uses the existing Docker image/configuration, verifies the VPS's authenticated stats endpoint, confirms the worker's workspace/repository/type/name, then merges only `NODE_VPS_URL` and `MONITOR_VPS_TOKEN` through Render's HTTPS MCP endpoint. It preserves other environment variables. Render automatically redeploys the worker after the update; wait for a fresh sample in the website dashboard before claiming monitoring is ready.

No `.env` editing, node restart, image build, or password rotation is required. The API key is not saved to disk; it is passed by environment-variable name to a temporary container removed at exit. The existing VPS token is read by Compose from its private environment file and is not printed. Neither credential is sent through redirects. Tests: `node --test tests/connect-vps-monitor.test.mjs`; these exercise synthetic MCP responses, not a real credential transfer from your VPS.
