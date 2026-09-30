import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { database, query, transaction } from '../lib/db';
import { safeUrl } from '../lib/security';
const statsSchema = z.object({players:z.number().int().nonnegative(),playingPlayers:z.number().int().nonnegative(),clients:z.number().int().nonnegative(),
  uptime:z.number().nonnegative(),memory:z.object({used:z.number().nonnegative(),allocated:z.number().nonnegative()}),cpu:z.object({lavalinkLoad:z.number().nonnegative()})});
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;}); process.on('SIGINT',()=>{stopping=true;});
async function sample(id:'render'|'vps') {
  const url=process.env[`NODE_${id.toUpperCase()}_URL`]; const token=process.env[`MONITOR_${id.toUpperCase()}_TOKEN`];
  let status='UNKNOWN'; let latency:number|null=null; let stats:z.infer<typeof statsSchema>|null=null; let error:string|null=null;
  if(url && token) {
    try {
      const base=safeUrl(url,process.env.ALLOW_LOCAL_NODES==='true');
      await query('UPDATE nodes SET public_url=$2 WHERE id=$1',[id,base.origin]);
      for(let attempt=0;attempt<2;attempt++) {
        const start=performance.now();
        try {
          const response=await fetch(new URL('/internal/stats',base),{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000),redirect:'error'});
          if(!response.ok) throw new Error('NODE_UNAVAILABLE');
          stats=statsSchema.parse(await response.json()); latency=Math.round(performance.now()-start);
          status=latency>1500?'DEGRADED':'ONLINE'; break;
        } catch { if(attempt===1) {status='OFFLINE';error='PROBE_FAILED';} else await sleep(500); }
      }
    } catch { status='UNKNOWN';error='CONFIGURATION_ERROR'; }
  }
  await transaction(async db=>{
    await db.query(`INSERT INTO health_checks(node_id,status,latency_ms,players,playing,clients,cpu,ram_used,ram_allocated,process_uptime,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,status,latency,stats?.players??null,stats?.playingPlayers??null,stats?.clients??null,stats?.cpu.lavalinkLoad??null,stats?.memory.used??null,stats?.memory.allocated??null,stats?.uptime??null,error]);
    if(status==='OFFLINE'||status==='DEGRADED') await db.query(`INSERT INTO incidents(id,node_id,title,details,automatic) VALUES($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`,[randomUUID(),id,`${id.toUpperCase()}: ${status}`,status==='OFFLINE'?'Dua probe kontrol berturut-turut gagal. Playback belum dapat dinilai.':'Latency endpoint kontrol melebihi 1500 ms.']);
    if(status==='ONLINE') await db.query('UPDATE incidents SET resolved_at=now() WHERE node_id=$1 AND automatic AND resolved_at IS NULL',[id]);
  });
}
async function retention() {
  await query("DELETE FROM health_checks WHERE checked_at<now()-interval '30 days'");
  await query("DELETE FROM request_buckets WHERE minute<now()-interval '30 days'");
  await query("DELETE FROM client_days WHERE day<CURRENT_DATE-30");
  await query("DELETE FROM audit_logs WHERE created_at<now()-interval '90 days'");
  await query('DELETE FROM rate_limits WHERE window_start<now()-interval \'1 day\'');
  await query('DELETE FROM sessions WHERE expires_at<now()');
  await query('DELETE FROM connections WHERE expires_at<now()');
  await query('DELETE FROM gateway_sessions WHERE expires_at<now()');
}
// Session-level advisory lock protects against overlapping worker deploys.
const lock=await database().connect();
lock.on('error',()=>process.exit(1));
const acquired=(await lock.query('SELECT pg_try_advisory_lock(8246102) acquired')).rows[0].acquired;
if(!acquired) { lock.release(); await database().end(); process.exit(1); }
console.log(JSON.stringify({event:'monitor_started',interval_seconds:30}));
let cycles=0;
while(!stopping) {
  const start=Date.now();
  try { await Promise.all([sample('render'),sample('vps')]); if(cycles++%120===0) await retention(); }
  catch { console.error(JSON.stringify({event:'monitor_cycle_failed'})); }
  if(!stopping) await sleep(Math.max(100,30000-(Date.now()-start)));
}
await lock.query('SELECT pg_advisory_unlock(8246102)'); lock.release(); await database().end();
