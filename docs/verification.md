# Playback acceptance and troubleshooting

## Required production evidence (separate report per node)

| Gate | Evidence | Current state |
|---|---|---|
| Render Node 01 REST/WSS TLS | Public /v4/info + ready event on exact deployed host | BLOCKED: no deployment/access supplied |
| VPS Node 02 TLS/reverse proxy | Valid certificate, WebSocket upgrade, health | BLOCKED: no VPS/domain supplied |
| Source access | Valid identifier, search, decode, playlist from each node | Only local search/decode tested; one direct YouTube identifier failed |
| Discord voice | Bot joins chosen channel; token/session/channel passed to Lavalink | BLOCKED: no bot/channel credentials |
| Actual sound | TrackStart, moving position, human listener confirmation | BLOCKED; no audio claim |
| Controls | Pause/resume/volume audible, skip/stop/end observed | REST controls tested locally without voice; live check outstanding |
| Exceptions | Controlled source loads then fails, TrackExceptionEvent observed | Live fixture outstanding |
| Reconnect/offline | Session resume; real maintenance outage; player reconstruction | Same-node protocol resume tested locally; production outage outstanding |
| Monitoring | Independent samples, clients, source errors, stale UNKNOWN | Local worker + PostgreSQL verified; deployed targets outstanding |

A runner result of BLOCKED must not be changed to PASS manually. Re-run after supplying its prerequisites. Keep exact version, host, timestamp, region/plan and network constraints in operator evidence without credential values. If audible listening succeeds but other stages fail, the report is still incomplete.

## Running the live test

1. Deploy the selected node, create an operator-approved credential for the test bot's user ID and that node.
2. Invite the bot to a test guild with View Channel, Connect and Speak. A normal voice channel is recommended; stage channels require additional speaking permissions not implemented by this example.
3. Stop any other process using the same bot token/credential. Export the private variables from `.env.example`.
4. Choose a playable track you may use, preferably long enough for the listener/control tests. Set a real supported playlist URL.
5. Prepare `TEST_EXCEPTION_IDENTIFIER` on an isolated source fixture: metadata must resolve successfully, then serving the audio must fail. A load error is not TrackExceptionEvent. For an HTTP fixture, enable HTTP only on an isolated test node with restricted egress, never casually on the public service.
6. Run `PLAYBACK_NODE_ID=render npm run test:playback`, then repeat with VPS endpoint and its distinct credential.
7. The listener joins the configured Discord voice channel and types `HEARD` only after hearing the actual test track. Do not confirm based on player position, emitted events, or frame counters alone.
8. For the optional interactive maintenance outage stage, choose OUTAGE, stop only the selected test node, verify failure, then restore it and recreate voice/player. To pass the entire acceptance suite this stage is required; declining records BLOCKED.
9. Save JSON evidence. `RECORD_PLAYBACK=true` additionally writes the report using an operator/server PostgreSQL connection. This is separate from public client authority.

## Troubleshooting by layer

| Symptom | Check |
|---|---|
| 401 | Correct client key for that node, not dashboard cookie or internal password; not revoked; account approved/enabled |
| 403 on WS | User-Id matches the key's declared bot ID; stale Session-Id may need a fresh session |
| 403 on REST session | Session belongs to a different key or expired; reconnect; never reuse another bot session |
| 409 on WS | Key already connected or old lease has not expired (45s); close old process and back off |
| 429 | Credential minute/day quota, max five players, or reconnect throttle; obey Retry-After |
| Health 503 | PostgreSQL reachable and migrated, gateway env valid, Lavalink booted/plugin downloads complete |
| Search succeeds, stream fails | IP/source restriction, expired audio URL, plugin/provider change; try another source and inspect private error categories |
| Voice connected but silence | Speak permission, mute/suppress state, volume, TrackException/Stuck, voice UDP egress, frame stats, current Discord encryption support |
| Track starts but stops after deploy | In-memory session replaced; resuming unsuccessful; rejoin voice and recreate player |
| Status UNKNOWN | No configured HTTPS target or worker stopped/no successful writes for >90s; check worker logs and DB |
| Status OFFLINE | Both probe attempts failed; inspect HTTPS/DNS/token/DB before inferring voice outage |
| Memory pressure | JVM heap plus native buffers plus Node overhead; reduce player quota/load or increase instance capacity |

For Render, validate source HTTPS and Discord voice UDP on the selected production environment. Sandbox tests cannot establish Render networking. Keep an alternative VM/VPS deployment ready if Render cannot meet those voice requirements, and record that switching Node 01 requires an explicit architecture decision.

## Automated checks

`npm test` validates password/TLS/status/payload policy. `npm run test:integration` requires a disposable `_test` PostgreSQL DB, a built Next app and a running official Lavalink with internal password. It starts its own web/gateway/worker, uses synthetic accounts, verifies DB-backed revocation, player limits and session isolation, and cleans up its processes. It never opens a Discord voice connection or claims audible playback.

### Local outage / recovery suite

`npm run test:resilience` exercises two separate **local** official Lavalink processes,
with unique passwords and ports, using a disposable PostgreSQL database. Set
`TEST_LAVALINK_JAR` to the official 4.2.2 jar, and optionally
`TEST_LAVALINK_PLUGINS` to a directory containing the pinned plugin jars already
downloaded by Lavalink. Java 17+ must be installed. Run this suite separately from
`test:integration` if they share the same test database; both reset fixture data.

The suite observes the real 30-second scheduler, rejects a duplicate worker,
injects latency into one local monitor transport, crashes/restores that node's
gateway, checks the other node remains ONLINE, and verifies incident persistence
and resolution. Allow about two minutes. The fixture labels `render`/`vps` are
node identities in a local disposable database; this does not test Render/VPS
infrastructure, public TLS, Discord voice, or audible audio.
