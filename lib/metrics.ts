import { query } from './db';
export type NodeStatus = 'ONLINE'|'DEGRADED'|'OFFLINE'|'UNKNOWN';
export function visibleStatus(status: NodeStatus | null, checkedAt: Date | string | null, now = Date.now()): NodeStatus {
  return !checkedAt || now - new Date(checkedAt).getTime() > 90000 ? 'UNKNOWN' : status ?? 'UNKNOWN';
}
export async function publicMetrics() {
  const [nodes, history, incidents, requests] = await Promise.all([
    query(`SELECT n.id,n.name,n.provider,n.public_url,h.status,h.checked_at,h.latency_ms,h.players,h.playing,h.clients,h.cpu,h.ram_used,h.ram_allocated,h.process_uptime,
      a.samples,a.online_samples,a.first_sample,
      (SELECT count(*)::int FROM client_days d WHERE d.node_id=n.id AND d.day=CURRENT_DATE) daily_clients,
      (SELECT json_build_object('checked_at',p.checked_at,'audible_confirmed',p.audible_confirmed) FROM playback_runs p WHERE p.node_id=n.id ORDER BY p.checked_at DESC LIMIT 1) playback
      FROM nodes n LEFT JOIN LATERAL (SELECT * FROM health_checks WHERE node_id=n.id ORDER BY checked_at DESC LIMIT 1) h ON true
      LEFT JOIN LATERAL (SELECT count(*)::int samples,count(*) FILTER(WHERE status='ONLINE')::int online_samples,min(checked_at) first_sample FROM health_checks WHERE node_id=n.id AND checked_at>now()-interval '24 hours') a ON true ORDER BY n.id`),
    query(`SELECT node_id,date_trunc('hour',checked_at) time,round(avg(latency_ms)) latency_ms,round(avg(players)) players,
      count(*)::int samples,count(*) FILTER(WHERE status='ONLINE')::int online_samples FROM health_checks WHERE checked_at>now()-interval '24 hours' GROUP BY node_id,time ORDER BY time`),
    query('SELECT id,node_id,title,details,opened_at,resolved_at FROM incidents ORDER BY opened_at DESC LIMIT 30'),
    query(`SELECT node_id,minute,requests::int,errors::int,starts::int,exceptions::int,ends::int FROM request_buckets WHERE minute>now()-interval '24 hours' ORDER BY minute`),
  ]);
  return { generated_at: new Date().toISOString(), nodes: nodes.rows.map(n => {
    const status = visibleStatus(n.status,n.checked_at);
    const available = status === 'ONLINE' || status === 'DEGRADED';
    return { ...n, status, players: available ? n.players : null, playing: available ? n.playing : null,
      clients: available ? n.clients : null, cpu: available ? n.cpu : null, ram_used: available ? n.ram_used : null,
      daily_clients: available ? n.daily_clients : null,
      uptime_pct: n.samples ? Math.round(n.online_samples / n.samples * 10000) / 100 : null,
      coverage_pct: Math.min(100, Math.round(n.samples / 2880 * 10000) / 100),
    };
  }), history: history.rows, incidents: incidents.rows, requests: requests.rows };
}
