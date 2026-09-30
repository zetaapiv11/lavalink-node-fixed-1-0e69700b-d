import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, copyFile, mkdir, readdir, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import { database, query } from '../lib/db';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('Requires a disposable DATABASE_URL ending in _test; test data is reset.');
}
const jar = process.env.TEST_LAVALINK_JAR;
if (!jar) throw new Error('Set TEST_LAVALINK_JAR to the official Lavalink 4.2.2 release jar.');
const root = process.cwd();
const children: ChildProcess[] = [];
const servers: Server[] = [];
let temp: string;

async function waitUntil(check: () => Promise<boolean>, label: string, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', grace = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill(signal);
  const force = setTimeout(() => child.kill('SIGKILL'), grace);
  try { await done; } finally { clearTimeout(force); }
}
const reserved = new Set<number>();
async function port() {
  for (;;) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const value = (server.address() as { port: number }).port;
    await new Promise<void>(done => server.close(() => done()));
    if (!reserved.has(value)) { reserved.add(value); return value; }
  }
}
async function launch(label: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd = root) {
  const log = await open(join(temp, `${label}.log`), 'a', 0o600);
  try {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
    children.push(child);
    await once(child, 'spawn');
    return child;
  } finally { await log.close(); }
}
async function latest(id: string) {
  return (await query('SELECT * FROM health_checks WHERE node_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
}

test('two local Lavalink instances: monitoring, outage and recovery', { timeout: 240000 }, async t => {
  temp = await mkdtemp(join(tmpdir(), 'resonance-resilience-'));
  let gatewayRender: ChildProcess | undefined;
  let gatewayVps: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let delayMs = 0;
  let proxyHits = 0;
  const passwords = { render: randomBytes(32).toString('hex'), vps: randomBytes(32).toString('hex') };
  const tokens = { render: randomBytes(32).toString('hex'), vps: randomBytes(32).toString('hex') };
  const javaPorts = { render: await port(), vps: await port() };
  const gatewayPorts = { render: await port(), vps: await port() };
  const gatewayEnv = (id: 'render' | 'vps') => ({ ...process.env, NODE_ID: id,
    PORT: String(gatewayPorts[id]), SERVER_PORT: String(javaPorts[id]),
    LAVALINK_SERVER_PASSWORD: passwords[id], MONITOR_TOKEN: tokens[id] });
  const startGateway = (id: 'render' | 'vps') => launch(`gateway-${id}`, process.execPath,
    ['--import', 'tsx', 'services/gateway.ts'], gatewayEnv(id));
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], { env: process.env, stdio: 'pipe' });
    await query('TRUNCATE users,sessions,client_keys,connections,gateway_sessions,client_days,rate_limits,request_buckets,health_checks,incidents,audit_logs,playback_runs CASCADE');
    await t.test('two independent official instances start with distinct credentials', async () => {
      for (const id of ['render', 'vps'] as const) {
        const cwd = join(temp, id);
        await mkdir(cwd);
        await copyFile(resolve('application.yml'), join(cwd, 'application.yml'));
        // Reuse already-downloaded pinned plugin jars if supplied. No fake source plugin.
        if (process.env.TEST_LAVALINK_PLUGINS) {
          await mkdir(join(cwd, 'plugins'));
          for (const name of await readdir(process.env.TEST_LAVALINK_PLUGINS)) {
            if (name.endsWith('.jar')) await copyFile(join(process.env.TEST_LAVALINK_PLUGINS, name), join(cwd, 'plugins', name));
          }
        }
        await launch(`java-${id}`, 'java', ['-Xms64M', '-Xmx256M', '-jar', resolve(jar)], gatewayEnv(id), cwd);
      }
      gatewayRender = await startGateway('render');
      gatewayVps = await startGateway('vps');
      for (const id of ['render', 'vps'] as const) {
        await waitUntil(async () => {
          try { return (await fetch(`http://127.0.0.1:${gatewayPorts[id]}/healthz`, { signal: AbortSignal.timeout(2000) })).ok; }
          catch { return false; }
        }, `gateway ${id} readiness`, 60000);
        const info = await fetch(`http://127.0.0.1:${javaPorts[id]}/v4/info`, { headers: { Authorization: passwords[id] } });
        assert.equal(info.status, 200);
        const data = await info.json();
        assert.equal(data.version.semver, '4.2.2');
        assert.ok(data.plugins.some((p: { name: string; version: string }) => p.name === 'youtube-plugin' && p.version === '1.18.2'));
        const other = id === 'render' ? 'vps' : 'render';
        assert.equal((await fetch(`http://127.0.0.1:${javaPorts[id]}/v4/info`, { headers: { Authorization: passwords[other] } })).status, 403);
      }
    });

    // Fault-injection transport: every successful payload comes from the actual gateway.
    // Only the render-labelled local fixture is delayed; no fabricated stats are returned.
    const proxy = createServer((request, response) => {
      void (async () => {
        proxyHits++;
        if (delayMs) await sleep(delayMs);
        try {
          const upstream = await fetch(`http://127.0.0.1:${gatewayPorts.render}/internal/stats`, {
            headers: { Authorization: request.headers.authorization || '' }, signal: AbortSignal.timeout(3000),
          });
          response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
          response.end(await upstream.text());
        } catch { response.writeHead(503); response.end(); }
      })().catch(() => { response.destroy(); });
    });
    servers.push(proxy);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyPort = (proxy.address() as { port: number }).port;
    const workerEnv = { ...process.env, NODE_RENDER_URL: `http://127.0.0.1:${proxyPort}`,
      NODE_VPS_URL: `http://127.0.0.1:${gatewayPorts.vps}`, MONITOR_RENDER_TOKEN: tokens.render,
      MONITOR_VPS_TOKEN: tokens.vps, ALLOW_LOCAL_NODES: 'true' };

    await t.test('persistent worker samples both actual gateways and excludes monitor clients', async () => {
      worker = await launch('monitor', process.execPath, ['--import', 'tsx', 'services/monitor.ts'], workerEnv);
      await waitUntil(async () => (await latest('render'))?.status === 'ONLINE' && (await latest('vps'))?.status === 'ONLINE', 'initial samples');
      for (const id of ['render', 'vps']) {
        const check = await latest(id);
        assert.equal(check.clients, 0);
        assert.equal(check.players, 0);
        assert.ok(check.latency_ms >= 0);
        assert.ok(Number(check.ram_used) > 0);
      }
    });
    await t.test('overlapping worker exits without duplicating the scheduler', async () => {
      const duplicate = await launch('duplicate-monitor', process.execPath, ['--import', 'tsx', 'services/monitor.ts'], workerEnv);
      const code = await Promise.race([once(duplicate, 'exit').then(([code]) => code), sleep(5000).then(() => 'TIMEOUT')]);
      assert.equal(code, 1);
      assert.equal(worker!.exitCode, null);
    });
    await t.test('actual 30-second schedule records high latency as DEGRADED independently', async () => {
      delayMs = 1800;
      await waitUntil(async () => (await latest('render'))?.status === 'DEGRADED', 'delayed sample');
      const degraded = await latest('render');
      assert.ok(degraded.latency_ms >= 1500);
      assert.equal((await latest('vps')).status, 'ONLINE');
      assert.equal((await query("SELECT count(*)::int n FROM incidents WHERE node_id='render' AND automatic AND resolved_at IS NULL")).rows[0].n, 1);
    });
    await t.test('gateway crash triggers two probe attempts and OFFLINE without affecting other node', async () => {
      delayMs = 0;
      const before = proxyHits;
      await stop(gatewayRender!, 'SIGKILL');
      await waitUntil(async () => (await latest('render'))?.status === 'OFFLINE', 'offline sample');
      assert.ok(proxyHits - before >= 2, 'Worker retries the failed probe');
      assert.equal((await latest('render')).players, null);
      assert.equal((await latest('vps')).status, 'ONLINE');
      assert.equal(gatewayVps!.exitCode, null);
      assert.equal((await query("SELECT count(*)::int n FROM incidents WHERE node_id='render' AND automatic AND resolved_at IS NULL")).rows[0].n, 1);
    });
    await t.test('restarted gateway returns ONLINE, resolves incident and retains outage history', async () => {
      gatewayRender = await startGateway('render');
      await waitUntil(async () => (await latest('render'))?.status === 'ONLINE', 'recovery sample');
      assert.equal((await latest('vps')).status, 'ONLINE');
      const incident = (await query("SELECT * FROM incidents WHERE node_id='render' AND automatic ORDER BY opened_at DESC LIMIT 1")).rows[0];
      assert.ok(incident.resolved_at);
      const states = (await query("SELECT DISTINCT status FROM health_checks WHERE node_id='render'")).rows.map(row => row.status);
      for (const expected of ['ONLINE', 'DEGRADED', 'OFFLINE']) assert.ok(states.includes(expected));
      assert.equal((await query("SELECT count(*)::int n FROM incidents WHERE node_id='vps'")).rows[0].n, 0);
    });
  } finally {
    await Promise.all(children.map(child => stop(child)));
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    await database().end();
    await rm(temp, { recursive: true, force: true });
  }
});
