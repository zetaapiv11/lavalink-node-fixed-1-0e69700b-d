import { pathToFileURL } from 'node:url';

const endpoint = 'https://mcp.render.com/mcp';
const expectedRepo = 'https://github.com/zetaapiv11/lavalink-node-fixed-1-0e69700b-d';
const messages = {
  INPUT: 'Konfigurasi VPS/ID worker/API key belum valid.',
  NODE: 'Token monitoring tidak diterima oleh endpoint HTTPS VPS. Tidak ada perubahan Render.',
  AUTH: 'Render menolak API key. Buat/salin API key Render yang aktif lalu ulangi.',
  RENDER: 'Permintaan Render gagal. Periksa koneksi dan izin API key; detail rahasia tidak ditampilkan.',
  TARGET: 'Worker tidak cocok dengan workspace/repository/jenis layanan. Tidak ada perubahan Render.',
};
class SyncError extends Error {
  constructor(code) { super(messages[code]); this.code = code; }
}
export async function connectMonitor(config, request = fetch) {
  const { apiKey, workspaceId, workerId, monitorToken, domain } = config;
  if (!apiKey || /\s/.test(apiKey) || !/^tea-[a-z0-9]+$/.test(workspaceId ?? '') || !/^srv-[a-z0-9]+$/.test(workerId ?? '') ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain ?? '') || domain.includes('..') || !monitorToken || monitorToken.length < 32) throw new SyncError('INPUT');
  const nodeUrl = `https://${domain}`;
  // Validate the actual node first. Never follow redirects with a bearer credential.
  try {
    const response = await request(`${nodeUrl}/internal/stats`, {
      headers: { Authorization: `Bearer ${monitorToken}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const stats = await response.json();
    if (!Number.isInteger(stats.players) || !Number.isInteger(stats.playingPlayers)) throw new Error();
  } catch { throw new SyncError('NODE'); }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${apiKey}` };
  let id = 0;
  async function rpc(method, params) {
    try {
      const response = await request(endpoint, {
        method: 'POST', headers: { ...headers }, redirect: 'error', signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      });
      if (response.status === 401 || response.status === 403) throw new SyncError('AUTH');
      if (!response.ok) throw new SyncError('RENDER');
      const session = response.headers.get('Mcp-Session-Id');
      if (session) headers['Mcp-Session-Id'] = session;
      const raw = await response.text();
      const parsed = raw.trim().startsWith('{') ? JSON.parse(raw) : raw.split(/\r?\n\r?\n/)
        .map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
        .filter(Boolean).map(data => JSON.parse(data)).find(message => message.id === id);
      if (!parsed || parsed.error || !parsed.result || parsed.result.isError) throw new SyncError('RENDER');
      return parsed.result;
    } catch (error) { throw error instanceof SyncError ? error : new SyncError('RENDER'); }
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'resonance-vps-monitor-setup', version: '1.0' } });
  const details = await rpc('tools/call', { name: 'get_service', arguments: { workspaceId, serviceId: workerId } });
  let service;
  try { service = JSON.parse(details.content.find(item => item.type === 'text').text); } catch { throw new SyncError('TARGET'); }
  if (service.id !== workerId || service.ownerId !== workspaceId || service.type !== 'background_worker' || service.repo?.replace(/\.git$/, '') !== expectedRepo ||
      !/^resonance-monitor(?:-|$)/.test(service.name ?? '')) throw new SyncError('TARGET');
  await rpc('tools/call', { name: 'update_environment_variables', arguments: {
    workspaceId, serviceId: workerId, replace: false,
    envVars: [{ key: 'NODE_VPS_URL', value: nodeUrl }, { key: 'MONITOR_VPS_TOKEN', value: monitorToken }],
  } });
  return { nodeUrl };
}

if (!process.argv[1] || pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await connectMonitor({ apiKey: process.env.RENDER_API_KEY, workspaceId: process.env.RENDER_WORKSPACE_ID,
      workerId: process.env.RENDER_WORKER_ID, monitorToken: process.env.MONITOR_TOKEN, domain: process.env.VPS_DOMAIN });
    console.log('Konfigurasi monitoring VPS dikirim ke Render. Tunggu deployment worker dan sampel baru di dashboard.');
    console.log('API key tidak disimpan; password node dan database tidak diubah. Ini belum membuktikan playback Discord.');
  } catch (error) {
    console.error(error instanceof SyncError ? `[${error.code}] ${error.message}` : '[RENDER] Sinkronisasi gagal; detail rahasia tidak ditampilkan.');
    process.exitCode = 1;
  }
}
