import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { database, query, transaction } from '../lib/db';
import { digest, secretEqual, limit, HttpError } from '../lib/security';
import { playerPatch, protocolRoute, sessionPatch } from '../lib/gateway-policy';
import { ZodError } from 'zod';
const nodeId=process.env.NODE_ID;
const password=process.env.LAVALINK_SERVER_PASSWORD;
const monitorToken=process.env.MONITOR_TOKEN;
if(!['render','vps'].includes(nodeId??'') || !password || password.length<32 || !monitorToken || monitorToken.length<32) throw new Error('NODE_ID and independent 32+ character secrets are required');
const upstream=`http://127.0.0.1:${Number(process.env.SERVER_PORT||2333)}`;
type Key={id:string;bot_id:string;user_id:string};
async function authenticate(header?:string):Promise<Key> {
  if(!header || header.length>200) throw new HttpError(401,'Client credential required');
  const {rows}=await query<Key>(`SELECT k.id,k.bot_id,k.user_id FROM client_keys k JOIN users u ON u.id=k.user_id
    WHERE k.token_hash=$1 AND k.node_id=$2 AND k.revoked_at IS NULL AND NOT u.disabled AND u.access_approved`,[digest(header),nodeId]);
  if(!rows[0]) throw new HttpError(401,'Invalid or revoked client credential');
  return rows[0];
}
async function owned(key:Key,session:string) {
  const result=await query('SELECT 1 FROM gateway_sessions WHERE node_id=$1 AND session_id=$2 AND key_id=$3 AND expires_at>now()',[nodeId,session,key.id]);
  if(!result.rowCount) throw new HttpError(403,'Session does not belong to this credential');
}
async function upstreamFetch(path:string,init:RequestInit={}) {
  return fetch(upstream+path,{...init,headers:{Authorization:password!,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
}
async function count(kind:'requests'|'errors'|'starts'|'ends'|'exceptions') {
  await query(`INSERT INTO request_buckets(node_id,minute,${kind}) VALUES($1,date_trunc('minute',now()),1)
    ON CONFLICT(node_id,minute) DO UPDATE SET ${kind}=request_buckets.${kind}+1`,[nodeId]);
}
function safeCount(kind:Parameters<typeof count>[0]) { void count(kind).catch(()=>console.error(JSON.stringify({event:'metric_write_failed',node:nodeId}))); }
async function readBody(req:http.IncomingMessage) {
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of req) {length+=chunk.length;if(length>32768) throw new HttpError(413,'Payload too large');chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString());} catch {throw new HttpError(400,'Invalid JSON');}
}
const active=new Map<string,{browser:WebSocket;remote:WebSocket;session?:string}>();
const wss=new WebSocketServer({noServer:true,maxPayload:32768});
const server=http.createServer(async(req,res)=>{
  const send=(status:number,data:unknown)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(status===429?{'Retry-After':'60'}:{})});res.end(JSON.stringify(data));}};
  let counted=false;
  try {
    const url=new URL(req.url||'/','http://gateway');
    if(req.method==='GET' && url.pathname==='/healthz') {
      const response=await upstreamFetch('/version'); await query('SELECT 1');return send(response.ok?200:503,{status:response.ok?'ready':'unavailable'});
    }
    if(req.method==='GET' && url.pathname==='/internal/stats') {
      if(!secretEqual(req.headers.authorization||'',`Bearer ${monitorToken}`)) throw new HttpError(401,'Unauthorized');
      const response=await upstreamFetch('/v4/stats'); if(!response.ok) throw new HttpError(503,'Lavalink unavailable');
      const stats=await response.json();
      const clients=(await query('SELECT count(*)::int n FROM connections WHERE node_id=$1 AND expires_at>now()',[nodeId])).rows[0].n;
      return send(200,{players:stats.players,playingPlayers:stats.playingPlayers,uptime:stats.uptime,cpu:stats.cpu,memory:stats.memory,clients});
    }
    await limit(`gateway:attempt:${nodeId}`,2000);
    const key=await authenticate(req.headers.authorization);
    counted=true;safeCount('requests');
    await limit(`client:${key.id}`,120);await limit(`daily:${key.id}`,20000,86400);
    const route=protocolRoute(req.method||'GET',url.pathname);
    if(!route) throw new HttpError(404,'Protocol endpoint not available');
    if(route.kind !== 'read') await owned(key,route.session);
    let payload:unknown;
    if(req.method==='PATCH') payload=(route.kind==='session'?sessionPatch:playerPatch).parse(await readBody(req));
    const perform=()=>upstreamFetch(url.pathname+url.search,{method:req.method,body:payload?JSON.stringify(payload):undefined});
    let response:Response;
    if(route.kind==='player' && req.method==='PATCH') {
      response=await transaction(async db=>{
        await db.query('SELECT session_id FROM gateway_sessions WHERE node_id=$1 AND session_id=$2 FOR UPDATE',[nodeId,route.session]);
        const playersResponse=await upstreamFetch(`/v4/sessions/${route.session}/players`);
        if(!playersResponse.ok) throw new HttpError(409,'Session unavailable; reconnect');
        const players=await playersResponse.json();
        if(!players.some((p:{guildId:string})=>p.guildId===route.guild) && players.length>=5) throw new HttpError(429,'Maximum five players per credential');
        return perform();
      });
    } else response=await perform();
    if(!response.ok) {safeCount('errors');return send(response.status,{error:response.status===404?'Session or resource expired; reconnect':'Lavalink rejected the request'});}
    if(response.status===204) {res.writeHead(204);res.end();return;}
    if(url.pathname==='/version') {res.writeHead(200,{'Content-Type':'text/plain'});res.end(await response.text());return;}
    const data=await response.json();
    if(data.loadType==='error') {safeCount('errors');return send(200,{loadType:'error',data:{message:'Sumber audio gagal dimuat. Coba identifier atau sumber lain.',severity:'common',cause:'SOURCE_LOAD_FAILED'}});}
    return send(200,data);
  } catch(error) {
    if(counted)safeCount('errors');
    if(error instanceof HttpError) return send(error.status,{error:error.message});
    if(error instanceof ZodError) return send(400,{error:'Invalid protocol payload'});
    console.error(JSON.stringify({event:'gateway_request_failed',node:nodeId}));send(503,{error:'Audio node temporarily unavailable'});
  }
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.on('upgrade',(req,socket,head)=>{
  socket.on('error',()=>{});
  const reject=(status:number)=>{socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
  void(async()=>{
    if(req.url!=='/v4/websocket') throw new HttpError(404,'Not found');
    await limit(`ws:attempt:${nodeId}`,300);
    const key=await authenticate(req.headers.authorization);
    if(req.headers['user-id']!==key.bot_id) throw new HttpError(403,'Bot identity mismatch');
    await limit(`ws:${key.id}`,10);
    const oldSession=typeof req.headers['session-id']==='string'?req.headers['session-id']:undefined;
    if(oldSession) await owned(key,oldSession);
    const connectionId=randomUUID();
    const inserted=await query(`INSERT INTO connections(id,node_id,key_id,expires_at) VALUES($1,$2,$3,now()+interval '45 seconds')
      ON CONFLICT(node_id,key_id) DO UPDATE SET id=EXCLUDED.id,expires_at=EXCLUDED.expires_at WHERE connections.expires_at<now() RETURNING id`,[connectionId,nodeId,key.id]);
    if(!inserted.rowCount) throw new HttpError(409,'Credential already connected');
    if(socket.destroyed) {await query('DELETE FROM connections WHERE id=$1',[connectionId]);return;}
    wss.handleUpgrade(req,socket,head,browser=>{
      const remote=new WebSocket(upstream.replace('http:','ws:')+'/v4/websocket',{headers:{Authorization:password!,'User-Id':key.bot_id,'Client-Name':'ResonanceGateway/2.0',...(oldSession?{'Session-Id':oldSession}:{})},handshakeTimeout:10000,maxPayload:1024*1024});
      const state:{browser:WebSocket;remote:WebSocket;session?:string}={browser,remote};active.set(connectionId,state);
      let closed=false,alive=true;
      const cleanup=()=>{if(closed)return;closed=true;clearInterval(heartbeat);active.delete(connectionId);browser.close(1012,'Reconnect with backoff');remote.close();void query('DELETE FROM connections WHERE id=$1',[connectionId]).catch(()=>{});};
      browser.on('pong',()=>{alive=true;});
      browser.on('message',()=>browser.close(1008,'Use Lavalink REST for commands'));
      browser.on('error',cleanup);remote.on('error',cleanup);browser.on('close',cleanup);remote.on('close',cleanup);
      const heartbeat=setInterval(()=>{void(async()=>{
        if(!alive || browser.readyState!==WebSocket.OPEN) {browser.terminate();cleanup();return;}alive=false;browser.ping();
        try {
          await authenticate(req.headers.authorization);
          await query("UPDATE connections SET expires_at=now()+interval '45 seconds' WHERE id=$1",[connectionId]);
          await query('INSERT INTO client_days(node_id,key_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[nodeId,key.id]);
          if(state.session)await query("UPDATE gateway_sessions SET expires_at=now()+interval '2 minutes' WHERE node_id=$1 AND session_id=$2 AND key_id=$3",[nodeId,state.session,key.id]);
        } catch {await destroyPlayers(state.session);cleanup();}
      })();},15000);
      // Serialize ready persistence before forwarding any subsequent protocol event.
      let chain=Promise.resolve();
      remote.on('message',raw=>{chain=chain.then(async()=>{
        const packet=JSON.parse(raw.toString());
        if(packet.op==='ready') {
          state.session=packet.sessionId;
          await query(`INSERT INTO gateway_sessions(node_id,session_id,key_id,expires_at) VALUES($1,$2,$3,now()+interval '2 minutes')
            ON CONFLICT(node_id,session_id) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE gateway_sessions.key_id=EXCLUDED.key_id`,[nodeId,packet.sessionId,key.id]);
          await query('INSERT INTO client_days(node_id,key_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[nodeId,key.id]);
        }
        if(packet.type==='TrackStartEvent')safeCount('starts');
        if(packet.type==='TrackEndEvent')safeCount('ends');
        if(packet.type==='TrackExceptionEvent') {safeCount('exceptions');packet.exception={message:'Audio source playback failed',severity:'common',cause:'SOURCE_PLAYBACK_FAILED'};}
        if(browser.readyState===WebSocket.OPEN) {if(browser.bufferedAmount>1024*1024)throw new Error('SLOW_CLIENT');browser.send(JSON.stringify(packet));}
      }).catch(()=>{cleanup();});});
    });
  })().catch(error=>reject(error instanceof HttpError?error.status:503));
});
async function destroyPlayers(session?:string) {
  if(!session)return;
  try {const result=await upstreamFetch(`/v4/sessions/${session}/players`);if(!result.ok)return;
    for(const player of await result.json()) await upstreamFetch(`/v4/sessions/${session}/players/${player.guildId}`,{method:'DELETE'});
  } catch {console.error(JSON.stringify({event:'player_cleanup_failed',node:nodeId}));}
}
server.listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log(JSON.stringify({event:'gateway_started',node:nodeId})));
async function shutdown(){server.close();for(const {browser,remote} of active.values()){browser.close(1012,'Service restarting');remote.close();}setTimeout(()=>process.exit(0),5000).unref();await database().end();}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
