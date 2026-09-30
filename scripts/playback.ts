import { Client,GatewayIntentBits } from 'discord.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { LavalinkClient,VoiceBridge,type Packet,type Track } from '../lib/lavalink-client';
import { database,query } from '../lib/db';
type Result={stage:string;status:'PASS'|'FAIL'|'BLOCKED';detail:string};
const results:Result[]=[];const started=new Date().toISOString();
const required=['DISCORD_TOKEN','DISCORD_GUILD_ID','DISCORD_VOICE_CHANNEL_ID','LAVALINK_URL','LAVALINK_CLIENT_KEY','TEST_TRACK_IDENTIFIER'];
const missing=required.filter(k=>!process.env[k]);
let node:LavalinkClient|undefined,voice:VoiceBridge|undefined,discord:Client|undefined;let track:Track|undefined;let audible=false;
const guild=process.env.DISCORD_GUILD_ID!;const channel=process.env.DISCORD_VOICE_CHANNEL_ID!;
const stages=['TLS / REST / WebSocket ready','Valid identifier load','Search','Resolve and decode','Playlist','Discord voice join','TrackStartEvent','Connected player / progressing position','Human audible confirmation','Pause / resume / volume','Skip / stop / TrackEndEvent','Natural TrackEndEvent','TrackExceptionEvent','Reconnect on same node','Node outage and recovery'];
async function stage(name:string,fn:()=>Promise<void>){try{await fn();results.push({stage:name,status:'PASS',detail:'Observed during this run'});console.log(`PASS ${name}`);return true;}catch{results.push({stage:name,status:'FAIL',detail:'Expected behavior was not observed; inspect private node logs without publishing secrets.'});console.log(`FAIL ${name}`);return false;}}
function blocked(name:string,detail:string){results.push({stage:name,status:'BLOCKED',detail});console.log(`BLOCKED ${name}: ${detail}`);}
async function eventAction(type:string,action:()=>Promise<unknown>,predicate:(p:Packet)=>boolean=()=>true){const event=node!.waitFor(p=>p.type===type&&p.guildId===guild&&predicate(p),30000);await Promise.all([event,action()]);}
async function ask(question:string){if(!process.stdin.isTTY)return '';const rl=createInterface({input:process.stdin,output:process.stdout});try{return(await rl.question(question)).trim();}finally{rl.close();}}
try {
 if(missing.length){for(const name of stages)blocked(name,`Required environment missing: ${missing.join(', ')}`);}
 else {
  discord=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]});
  const connected=await stage(stages[0],async()=>{
    await discord!.login(process.env.DISCORD_TOKEN);if(!discord!.isReady())await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('DISCORD_READY_TIMEOUT')),20000);discord!.once('clientReady',()=>{clearTimeout(timeout);resolve();});});
    node=new LavalinkClient(process.env.LAVALINK_URL!,process.env.LAVALINK_CLIENT_KEY!,discord!.user!.id);
    node.on('failure',()=>{});const ready=node.waitFor(p=>p.op==='ready');node.connect();await ready;await node.rest('/v4/info');voice=new VoiceBridge(discord!,node);
  });
  if(connected){
   await stage(stages[1],async()=>{track=(await node!.load(process.env.TEST_TRACK_IDENTIFIER!)).tracks[0];});
   await stage(stages[2],async()=>{const result=await node!.load(process.env.TEST_SEARCH_IDENTIFIER||'ytsearch:royalty free music');assert.equal(result.loadType,'search');});
   if(track)await stage(stages[3],async()=>{const decoded=await node!.rest('/v4/decodetrack?encodedTrack='+encodeURIComponent(track!.encoded));assert.equal(decoded.info.identifier,track!.info.identifier);});else blocked(stages[3],'Valid track required');
   if(process.env.TEST_PLAYLIST_IDENTIFIER)await stage(stages[4],async()=>{assert.equal((await node!.load(process.env.TEST_PLAYLIST_IDENTIFIER!)).loadType,'playlist');});else blocked(stages[4],'Set TEST_PLAYLIST_IDENTIFIER for a source that supports playlists');
   const joined=await stage(stages[5],async()=>voice!.join(guild,channel));
   if(joined&&track){
    const playing=await stage(stages[6],async()=>eventAction('TrackStartEvent',()=>node!.update(guild,{track:{encoded:track!.encoded},volume:50,paused:false})));
    let progressing=false;
    if(playing)progressing=await stage(stages[7],async()=>{await node!.waitFor(p=>p.op==='playerUpdate'&&p.guildId===guild&&p.state?.connected===true&&(p.state.position??0)>2000,30000);});
    if(progressing&&process.stdin.isTTY){const answer=await ask('Listen in the configured Discord voice channel. Type HEARD only if you hear the track: ');if(answer==='HEARD'){audible=true;results.push({stage:stages[8],status:'PASS',detail:'Human listener explicitly confirmed HEARD in this run. Self-reported listening, not automated proof.'});}else blocked(stages[8],'Listener did not confirm audio');}else blocked(stages[8],'Requires progressing player and interactive human listener; no environment flag can auto-pass');
    await stage(stages[9],async()=>{assert.equal((await node!.update(guild,{paused:true})).paused,true);assert.equal((await node!.update(guild,{volume:35})).volume,35);assert.equal((await node!.update(guild,{paused:false})).paused,false);});
    await stage(stages[10],async()=>{
      // Skip replaces the current track and starts a newly resolved track.
      const next=(await node!.load(process.env.TEST_TRACK_IDENTIFIER!)).tracks[0];
      await eventAction('TrackEndEvent',()=>node!.update(guild,{track:{encoded:next.encoded}}),p=>p.reason==='replaced');
      await eventAction('TrackEndEvent',()=>node!.update(guild,{track:{encoded:null}}),p=>p.reason==='stopped');
      assert.equal((await node!.player(guild)).track,null);
    });
    await stage(stages[11],async()=>eventAction('TrackEndEvent',()=>node!.update(guild,{track:{encoded:track!.encoded},position:0,endTime:4000}),p=>p.reason==='finished'));
    if(process.env.TEST_EXCEPTION_IDENTIFIER)await stage(stages[12],async()=>{const broken=(await node!.load(process.env.TEST_EXCEPTION_IDENTIFIER!)).tracks[0];await eventAction('TrackExceptionEvent',()=>node!.update(guild,{track:{encoded:broken.encoded},endTime:null}));});else blocked(stages[12],'Set a controlled fixture that loads metadata but fails during playback');
    await stage(stages[13],async()=>{const ready=node!.waitFor(p=>p.op==='ready',60000);node!.socket!.terminate();await ready;await node!.rest('/v4/info');});
    if(process.stdin.isTTY&&(await ask('For a maintenance outage test, type OUTAGE; otherwise press Enter: '))==='OUTAGE'){
      await ask('Stop this audio node, wait until it is offline, then press Enter. ');
      const offline=await stage('Node outage detected',async()=>{await assert.rejects(()=>node!.rest('/v4/info'));});
      await ask('Restore this audio node, wait for readiness, then press Enter. ');
      if(offline)await stage(stages[14],async()=>{node!.close();node=new LavalinkClient(process.env.LAVALINK_URL!,process.env.LAVALINK_CLIENT_KEY!,discord!.user!.id);node.on('failure',()=>{});const ready=node.waitFor(p=>p.op==='ready',60000);node.connect();await ready;voice!.dispose();voice=new VoiceBridge(discord!,node);await voice.join(guild,channel);await eventAction('TrackStartEvent',()=>node!.update(guild,{track:{encoded:track!.encoded},volume:50}));});
    }else blocked(stages[14],'Real node shutdown requires an explicit maintenance run');
   }else for(const name of stages.slice(6))blocked(name,'Track load and voice join must succeed first');
  }else for(const name of stages.slice(1))blocked(name,'Connection prerequisite failed');
 }
}finally{
 if(voice){await voice.leave(guild).catch(()=>{});voice.dispose();}node?.close();discord?.destroy();
 const report={started_at:started,finished_at:new Date().toISOString(),target:process.env.PLAYBACK_NODE_ID||'unassigned',results,audible_confirmed:audible,passed:results.length>0&&results.every(r=>r.status==='PASS')};
 const dir=resolve(process.env.PLAYBACK_REPORT_DIR||'playback-results');await mkdir(dir,{recursive:true});const filename=resolve(dir,`playback-${Date.now()}.json`);await writeFile(filename,JSON.stringify(report,null,2),{mode:0o600});console.log(`Report saved: ${filename}`);
 if(process.env.RECORD_PLAYBACK==='true'&&process.env.DATABASE_URL&&['render','vps'].includes(process.env.PLAYBACK_NODE_ID||'')){
  try{await query('INSERT INTO playback_runs(id,node_id,result,audible_confirmed) VALUES($1,$2,$3,$4)',[randomUUID(),process.env.PLAYBACK_NODE_ID,JSON.stringify(report),audible]);}finally{await database().end();}
 }
 process.exitCode=report.passed?0:results.some(r=>r.status==='FAIL')?1:2;
}
