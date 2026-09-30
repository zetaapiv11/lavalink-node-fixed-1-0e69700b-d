import test from 'node:test';
import assert from 'node:assert/strict';
import { connectMonitor } from '../scripts/connect-vps-monitor.mjs';
const config = { apiKey: 'synthetic-api-key', workspaceId: 'tea-fixture', workerId: 'srv-fixture', monitorToken: 'm'.repeat(64), domain: 'audio.example.com' };
const service = { id: config.workerId, ownerId: config.workspaceId, name: 'resonance-monitor-fixture', type: 'background_worker', repo: 'https://github.com/zetaapiv11/lavalink-node-fixed-1-0e69700b-d' };
function responder(overrides = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://audio.example.com/')) {
      if (overrides.nodeFailure) return new Response('private-node-error', { status: 401 });
      return Response.json({ players: 0, playingPlayers: 0 });
    }
    if (overrides.authFailure) return new Response('private-api-key-invalid', { status: 401 });
    const body = JSON.parse(options.body);
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2024-11-05' };
    else if (body.params.name === 'get_service') result = { content: [{ type: 'text', text: JSON.stringify({ ...service, ...overrides.service }) }] };
    else if (overrides.updateFailure) result = { isError: true, content: [{ type: 'text', text: config.monitorToken }] };
    else result = { content: [{ type: 'text', text: 'Updated' }] };
    const message = { jsonrpc: '2.0', id: body.id, result };
    return new Response(overrides.sse ? `event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n` : JSON.stringify(message), { headers: { 'Mcp-Session-Id': 'synthetic-session' } });
  };
  return { calls, request };
}
for (const sse of [false, true]) test(`sync uses ${sse ? 'SSE' : 'JSON'} MCP, validates target, preserves other env and separates secrets`, async () => {
  const f = responder({ sse });
  assert.deepEqual(await connectMonitor(config, f.request), { nodeUrl: 'https://audio.example.com' });
  assert.equal(f.calls.length, 4);
  const [node, initialize, details, update] = f.calls;
  assert.equal(node.options.headers.Authorization, `Bearer ${config.monitorToken}`);
  assert.equal(initialize.options.headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal(details.options.headers['Mcp-Session-Id'], 'synthetic-session');
  assert.equal(JSON.stringify(node).includes(config.apiKey), false);
  for (const call of f.calls) assert.equal(call.options.redirect, 'error');
  const args = JSON.parse(update.options.body).params.arguments;
  assert.equal(args.replace, false);
  assert.equal(args.workspaceId, config.workspaceId);
  assert.equal(args.serviceId, config.workerId);
  assert.deepEqual(args.envVars, [{ key: 'NODE_VPS_URL', value: 'https://audio.example.com' }, { key: 'MONITOR_VPS_TOKEN', value: config.monitorToken }]);
});
test('node auth failure prevents any request to Render and does not echo secrets', async () => {
  const f = responder({ nodeFailure: true });
  await assert.rejects(connectMonitor(config, f.request), error => error.code === 'NODE' && !error.message.includes(config.monitorToken));
  assert.equal(f.calls.length, 1);
});
test('Render auth failure produces a fixed safe message', async () => {
  const f = responder({ authFailure: true });
  await assert.rejects(connectMonitor(config, f.request), error => error.code === 'AUTH' && !error.message.includes(config.apiKey));
});
test('wrong workspace, repo, service or type prevents remote mutation', async () => {
  for (const wrong of [{ ownerId: 'tea-wrong' }, { repo: 'https://github.com/example/wrong' }, { id: 'srv-wrong' }, { name: 'unrelated-worker' }, { type: 'web_service' }]) {
    const f = responder({ service: wrong });
    await assert.rejects(connectMonitor(config, f.request), error => error.code === 'TARGET');
    assert.equal(f.calls.length, 3);
  }
});
test('API tool error cannot be mistaken for success or expose its raw body', async () => {
  const f = responder({ updateFailure: true });
  await assert.rejects(connectMonitor(config, f.request), error => error.code === 'RENDER' && !error.message.includes(config.monitorToken));
});
test('invalid domain or missing API key fails before sending credentials', async () => {
  for (const change of [{ domain: 'http://audio.example.com' }, { domain: 'audio.example.com/other' }, { domain: 'audio..example.com' }, { apiKey: '' }, { monitorToken: 'short' }]) {
    const f = responder();
    await assert.rejects(connectMonitor({ ...config, ...change }, f.request), error => error.code === 'INPUT');
    assert.equal(f.calls.length, 0);
  }
});
