import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,execFileSync,type ChildProcess } from 'node:child_process';
import { randomUUID,randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import { database,query } from '../lib/db';
import { digest,limit } from '../lib/security';
import { LavalinkClient } from '../lib/lavalink-client';
const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl||!new URL(databaseUrl).pathname.endsWith('_test'))throw new Error('Integration requires a disposable DATABASE_URL ending in _test');
if(!process.env.LAVALINK_SERVER_PASSWORD)throw new Error('A running official Lavalink on SERVER_PORT is required');
const origin='http://localhost:3001';const audio='http://127.0.0.1:10001';const children:ChildProcess[]=[];
async function ready(url:string){for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await sleep(300);}throw new Error('STARTUP_TIMEOUT');}
async function request(path:string,body?:unknown,cookie?:string,customOrigin=origin){return fetch(origin+'/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:customOrigin}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});}
test('real PostgreSQL, Next API and official Lavalink gateway boundaries',async t=>{
 const nodes:LavalinkClient[]=[];
 try {
  execFileSync(process.execPath,['--import','tsx','scripts/migrate.ts'],{env:process.env,stdio:'pipe'});
  await query('TRUNCATE users, sessions, client_keys, connections, gateway_sessions, client_days, rate_limits, request_buckets, health_checks, incidents, audit_logs, playback_runs CASCADE');
  const monitorToken=randomBytes(32).toString('hex');
  children.push(spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p','3001','-H','0.0.0.0'],{env:{...process.env,APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex')},stdio:'ignore'}));
  children.push(spawn(process.execPath,['--import','tsx','services/gateway.ts'],{env:{...process.env,NODE_ID:'render',PORT:'10001',MONITOR_TOKEN:monitorToken},stdio:'ignore'}));
  await ready(origin+'/api/health');await ready(audio+'/healthz');
  const email='test-operator@example.invalid',password='integration-test-password-only';let cookie='';let keyA='';let keyB='';let keyAId='';
  await t.test('registration, session cookie, CSRF, admin isolation and audio approval',async()=>{
   assert.equal((await request('register',{email,password},undefined,'https://evil.invalid')).status,403);
   assert.equal((await request('register',{email,password})).status,201);
   const login=await request('login',{email,password});assert.equal(login.status,200);const header=login.headers.get('set-cookie')!;assert.match(header,/HttpOnly/i);assert.match(header,/SameSite=lax/i);cookie=header.split(';')[0];
   assert.equal((await request('admin',undefined,cookie)).status,403);
   assert.equal((await request('keys',{name:'before approval',nodeId:'render',botId:'123456789012345678'},cookie)).status,403);
   await query('UPDATE users SET access_approved=true WHERE email=$1',[email]);
  });
  await t.test('per-node credentials only reveal the client token once',async()=>{
   for(const label of ['a','b']){const response=await request('keys',{name:label,nodeId:'render',botId:'123456789012345678'},cookie);assert.equal(response.status,201);const value=await response.json();if(label==='a'){keyA=value.token;keyAId=value.id;}else keyB=value.token;}
   const listing=await(await request('keys',undefined,cookie)).text();assert.equal(listing.includes(keyA),false);assert.equal(listing.includes(process.env.LAVALINK_SERVER_PASSWORD!),false);
   const stored=(await query('SELECT token_hash FROM client_keys WHERE id=$1',[keyAId])).rows[0];assert.equal(stored.token_hash,digest(keyA));
   const wrongNode=await(await request('keys',{name:'vps-only',nodeId:'vps',botId:'123456789012345678'},cookie)).json();assert.equal((await fetch(audio+'/v4/info',{headers:{Authorization:wrongNode.token}})).status,401);
  });
  const first=new LavalinkClient(audio,keyA,'123456789012345678',true),second=new LavalinkClient(audio,keyB,'123456789012345678',true);nodes.push(first,second);first.on('failure',()=>{});second.on('failure',()=>{});
  await t.test('official Lavalink info and ready; credential-bound session isolation',async()=>{
   for(const node of nodes){const event=node.waitFor(p=>p.op==='ready');node.connect();await event;const info=await node.rest('/v4/info');assert.equal(info.version.semver,'4.2.2');assert.ok(info.plugins.some((p:{name:string})=>p.name==='youtube-plugin'));}
   const foreign=await fetch(`${audio}/v4/sessions/${first.session}/players`,{headers:{Authorization:keyB}});assert.equal(foreign.status,403);
   const duplicate=new LavalinkClient(audio,keyA,'123456789012345678',true);duplicate.on('failure',()=>{});const response=new Promise<number>(resolve=>{duplicate.connect();duplicate.socket!.once('unexpected-response',(_req,res)=>resolve(res.statusCode!));});assert.equal(await response,409);duplicate.close();
   assert.equal((await fetch(audio+'/v4/routeplanner/status',{headers:{Authorization:keyA}})).status,404);
  });
  await t.test('monitor is authenticated and never emits secrets',async()=>{
   assert.equal((await fetch(audio+'/internal/stats')).status,401);const response=await fetch(audio+'/internal/stats',{headers:{Authorization:`Bearer ${monitorToken}`}});assert.equal(response.status,200);const stats=await response.json();assert.equal(stats.clients,2);assert.equal(typeof stats.players,'number');assert.equal(JSON.stringify(stats).includes(keyA),false);
  });
  await t.test('real Lavalink player controls, quotas and session resume',async()=>{
   const guild='123456789012345678';const player=await first.update(guild,{volume:50,paused:true});assert.equal(player.volume,50);assert.equal(player.paused,true);
   assert.equal((await first.update(guild,{paused:false})).paused,false);
   for(let i=1;i<5;i++)await first.update(String(BigInt(guild)+BigInt(i)),{volume:50});
   await assert.rejects(()=>first.update('123456789012345699',{volume:50}),/429/);
   await first.destroy(guild);await assert.rejects(()=>first.player(guild),/404/);
   const session=second.session;const readyEvent=second.waitFor(p=>p.op==='ready',30000);second.socket!.terminate();const packet=await readyEvent;assert.equal(packet.resumed,true);assert.equal(second.session,session);
  });
  await t.test('atomic distributed quota admits exactly the allowed number',async()=>{
   const key=`test:${randomUUID()}`;const checks=await Promise.allSettled(Array.from({length:25},()=>limit(key,7)));assert.equal(checks.filter(r=>r.status==='fulfilled').length,7);
  });
  await t.test('revocation rejects REST, disconnects active socket, and destroys players',async()=>{
   const disconnected=once(first,'disconnected');assert.equal((await request('keys/revoke',{id:keyAId},cookie)).status,200);await assert.rejects(()=>first.rest('/v4/info'),/401/);
   await Promise.race([disconnected,sleep(20000).then(()=>{throw new Error('REVOCATION_TIMEOUT');})]);first.close();
   const response=await fetch(`http://127.0.0.1:${process.env.SERVER_PORT||2333}/v4/sessions/${first.session}/players`,{headers:{Authorization:process.env.LAVALINK_SERVER_PASSWORD!}});if(response.status===404) assert.ok(true,'Closed session removed by Lavalink');else {assert.equal(response.status,200);assert.equal((await response.json()).length,0);}
   const stats=await(await fetch(`http://127.0.0.1:${process.env.SERVER_PORT||2333}/v4/stats`,{headers:{Authorization:process.env.LAVALINK_SERVER_PASSWORD!}})).json();assert.equal(stats.players,0);
  });
  await t.test('persistent worker records real local health and UNKNOWN missing configuration',async()=>{
   children.push(spawn(process.execPath,['--import','tsx','services/monitor.ts'],{env:{...process.env,NODE_RENDER_URL:audio,MONITOR_RENDER_TOKEN:monitorToken,NODE_VPS_URL:'',MONITOR_VPS_TOKEN:'',ALLOW_LOCAL_NODES:'true'},stdio:'ignore'}));
   for(let i=0;i<50;i++){if((await query('SELECT 1 FROM health_checks WHERE node_id=$1',['render'])).rowCount)break;await sleep(200);}
   const response=await request('public');assert.equal(response.status,200);const data=await response.json();assert.equal(data.nodes.find((n:{id:string})=>n.id==='render').status,'ONLINE');assert.equal(data.nodes.find((n:{id:string})=>n.id==='vps').status,'UNKNOWN');
   assert.equal(JSON.stringify(data).includes(keyA),false);assert.equal(JSON.stringify(data).includes(monitorToken),false);
   await query("UPDATE health_checks SET checked_at=now()-interval '10 minutes'");const stale=await(await request('public')).json();assert.equal(stale.nodes[0].status,'UNKNOWN');assert.equal(stale.nodes[0].players,null);
  });
  await t.test('admin role, incident lifecycle and account access revocation',async()=>{
   execFileSync(process.execPath,['--import','tsx','scripts/admin.ts',email],{env:process.env,stdio:'pipe'});
   assert.equal((await request('admin',undefined,cookie)).status,200);
   const me=await(await request('me',undefined,cookie)).json();
   assert.equal((await request('admin/user',{id:me.user.id,action:'disable'},cookie)).status,400);
   assert.equal((await request('admin/incidents',{nodeId:'vps',title:'Integration incident',details:'Synthetic maintenance exercise'},cookie)).status,201);
   const incident=(await query("SELECT id FROM incidents WHERE title='Integration incident'")).rows[0];
   assert.equal((await request('admin/incidents/resolve',{id:incident.id},cookie)).status,200);
   assert.ok((await query('SELECT resolved_at FROM incidents WHERE id=$1',[incident.id])).rows[0].resolved_at);
   const other=randomUUID();await query("INSERT INTO users(id,email,password_hash,access_approved) VALUES($1,'revocation@example.invalid','unused',true)",[other]);
   assert.equal((await request('admin/user',{id:other,action:'disable'},cookie)).status,200);
   assert.equal((await query('SELECT disabled FROM users WHERE id=$1',[other])).rows[0].disabled,true);
   assert.ok((await query("SELECT 1 FROM audit_logs WHERE action='user.disable' AND target=$1",[other])).rowCount);
  });
  await t.test('logout revokes the server-side session',async()=>{assert.equal((await request('logout',{},cookie)).status,200);assert.equal((await request('keys',undefined,cookie)).status,401);});
 } finally {
  for(const node of nodes)node.close();for(const child of children)child.kill('SIGTERM');
  await Promise.all(children.map(async child=>{if(child.exitCode!==null)return;const killed=setTimeout(()=>child.kill('SIGKILL'),3000);await once(child,'exit');clearTimeout(killed);}));
  await database().end();
 }
});
