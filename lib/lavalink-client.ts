import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { Client } from 'discord.js';
import { safeUrl } from './security';
export type Track={encoded:string;info:{title:string;identifier:string;length:number;uri:string;isStream:boolean};userData?:Record<string,unknown>};
export type Packet={op:string;type?:string;guildId?:string;sessionId?:string;resumed?:boolean;reason?:string;state?:{connected:boolean;position:number;ping:number};track?:Track;[key:string]:unknown};
export class LavalinkClient extends EventEmitter {
  readonly url:URL; socket?:WebSocket;session?:string;private closed=false;private attempt=0;private reconnectTimer?:ReturnType<typeof setTimeout>;private heartbeat?:ReturnType<typeof setInterval>;
  constructor(url:string,private password:string,private userId:string,allowLoopback=false){super();this.url=safeUrl(url,allowLoopback);if(!password)throw new Error('CLIENT_CREDENTIAL_REQUIRED');}
  async rest(path:string,method='GET',body?:unknown):Promise<any> {
    const response=await fetch(new URL(path,this.url),{method,headers:{Authorization:this.password,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`LAVALINK_HTTP_${response.status}`);
    return response.status===204?null:response.json();
  }
  connect(){this.closed=false;this.open();}
  private open(){
    const wsUrl=new URL('/v4/websocket',this.url);wsUrl.protocol=this.url.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(wsUrl,{headers:{Authorization:this.password,'User-Id':this.userId,'Client-Name':'ResonanceBot/2.0',...(this.session?{'Session-Id':this.session}:{})},handshakeTimeout:10000,maxPayload:1024*1024});this.socket=socket;
    let alive=true;
    socket.on('open',()=>{this.heartbeat=setInterval(()=>{if(!alive){socket.terminate();return;}alive=false;socket.ping();},20000);});
    socket.on('pong',()=>{alive=true;});
    socket.on('message',raw=>{void(async()=>{
      const packet=JSON.parse(raw.toString()) as Packet;
      if(packet.op==='ready') {
        this.session=packet.sessionId;
        await this.rest(`/v4/sessions/${this.session}`,'PATCH',{resuming:true,timeout:60});
        this.attempt=0;this.emit('ready',packet);
      }
      this.emit('packet',packet);
    })().catch(()=>{this.emit('failure','INVALID_NODE_RESPONSE');socket.terminate();});});
    socket.on('unexpected-response',(_req,res)=>{res.resume();if(res.statusCode===403)this.session=undefined;socket.terminate();});
    socket.on('error',()=>this.emit('failure','NODE_CONNECTION_ERROR'));
    socket.on('close',()=>{
      clearInterval(this.heartbeat);this.emit('disconnected');if(this.closed)return;
      if(this.attempt>=8){this.emit('exhausted');return;}
      const delay=Math.min(30000,1000*2**this.attempt++)+Math.floor(Math.random()*500);
      this.reconnectTimer=setTimeout(()=>this.open(),delay);
    });
  }
  waitFor(predicate:(packet:Packet)=>boolean,timeout=30000):Promise<Packet>{return new Promise((resolve,reject)=>{
    const listener=(packet:Packet)=>{if(predicate(packet)){clearTimeout(timer);this.off('packet',listener);resolve(packet);}};
    const timer=setTimeout(()=>{this.off('packet',listener);reject(new Error('EVENT_TIMEOUT'));},timeout);this.on('packet',listener);
  });}
  async load(identifier:string):Promise<{loadType:string;tracks:Track[]}>{
    const result=await this.rest('/v4/loadtracks?identifier='+encodeURIComponent(identifier));
    if(result.loadType==='error')throw new Error('SOURCE_LOAD_FAILED');
    if(result.loadType==='empty')throw new Error('NO_TRACKS_FOUND');
    const tracks=result.loadType==='track'?[result.data]:result.loadType==='playlist'?result.data.tracks:result.data;
    if(!Array.isArray(tracks)||!tracks.length)throw new Error('NO_TRACKS_FOUND');
    return{loadType:result.loadType,tracks};
  }
  async update(guild:string,body:unknown){if(!this.session)throw new Error('NODE_NOT_READY');return this.rest(`/v4/sessions/${this.session}/players/${guild}`,'PATCH',body);}
  async player(guild:string){if(!this.session)throw new Error('NODE_NOT_READY');return this.rest(`/v4/sessions/${this.session}/players/${guild}`);}
  async destroy(guild:string){if(this.session)await this.rest(`/v4/sessions/${this.session}/players/${guild}`,'DELETE');}
  close(){this.closed=true;clearTimeout(this.reconnectTimer);clearInterval(this.heartbeat);this.socket?.close();}
}
export class VoiceBridge {
  private sessions=new Map<string,{sessionId?:string;channelId?:string;token?:string;endpoint?:string}>();
  private handler:(packet:any)=>void;
  private pending=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private discord:Client,private node:LavalinkClient){
    this.handler=packet=>{void this.raw(packet).catch(()=>{this.node.emit('failure','VOICE_UPDATE_FAILED');const guild=packet.d?.guild_id;const p=this.pending.get(guild);if(p){clearTimeout(p.timer);p.reject(new Error('VOICE_UPDATE_FAILED'));this.pending.delete(guild);}});};discord.on('raw',this.handler);
  }
  private async raw(packet:any){
    const data=packet.d;const guild=data?.guild_id;if(!guild||!this.sessions.has(guild))return;
    const state=this.sessions.get(guild)!;
    if(packet.t==='VOICE_STATE_UPDATE'&&data.user_id===this.discord.user?.id){
      if(!data.channel_id){this.sessions.set(guild,{});return;}
      state.sessionId=data.session_id;state.channelId=data.channel_id;
    } else if(packet.t==='VOICE_SERVER_UPDATE'){state.token=data.token;state.endpoint=data.endpoint;}else return;
    if(state.token&&state.endpoint&&state.sessionId&&state.channelId){
      await this.node.update(guild,{voice:{token:state.token,endpoint:state.endpoint,sessionId:state.sessionId,channelId:state.channelId}});
      const pending=this.pending.get(guild);if(pending){clearTimeout(pending.timer);pending.resolve();this.pending.delete(guild);}
    }
  }
  async join(guildId:string,channelId:string){
    if(this.pending.has(guildId))throw new Error('VOICE_JOIN_IN_PROGRESS');
    const guild=await this.discord.guilds.fetch(guildId);
    if(guild.members.me?.voice.channelId){
      this.sessions.delete(guildId);
      await new Promise<void>((resolve,reject)=>{
        const listener=(_old:any,state:any)=>{if(state.guild.id===guildId&&state.id===this.discord.user?.id&&!state.channelId){clearTimeout(timer);this.discord.off('voiceStateUpdate',listener);resolve();}};
        const timer=setTimeout(()=>{this.discord.off('voiceStateUpdate',listener);reject(new Error('VOICE_LEAVE_TIMEOUT'));},10000);
        this.discord.on('voiceStateUpdate',listener);
        guild.shard.send({op:4,d:{guild_id:guildId,channel_id:null,self_mute:false,self_deaf:true}});
      });
    }
    this.sessions.set(guildId,{});
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(guildId);reject(new Error('VOICE_JOIN_TIMEOUT'));},20000);this.pending.set(guildId,{resolve,reject,timer});
      guild.shard.send({op:4,d:{guild_id:guildId,channel_id:channelId,self_mute:false,self_deaf:true}});
    });
  }
  async leave(guildId:string){
    this.sessions.delete(guildId);const guild=this.discord.guilds.cache.get(guildId);
    guild?.shard.send({op:4,d:{guild_id:guildId,channel_id:null,self_mute:false,self_deaf:true}});
    await this.node.destroy(guildId);
  }
  dispose(){this.discord.off('raw',this.handler);for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('VOICE_BRIDGE_CLOSED'));}this.pending.clear();}
}
