import { Client,GatewayIntentBits } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { LavalinkClient,VoiceBridge,type Track } from '../lib/lavalink-client';
const required=['DISCORD_TOKEN','DISCORD_GUILD_ID','DISCORD_VOICE_CHANNEL_ID','BOT_OWNER_ID','LAVALINK_URL','LAVALINK_CLIENT_KEY'] as const;
for(const name of required)if(!process.env[name])throw new Error(`Missing ${name}`);
const guild=process.env.DISCORD_GUILD_ID!;const channel=process.env.DISCORD_VOICE_CHANNEL_ID!;
const discord=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
await discord.login(process.env.DISCORD_TOKEN);
if(!discord.isReady())await new Promise<void>(resolve=>discord.once('clientReady',()=>resolve()));
const node=new LavalinkClient(process.env.LAVALINK_URL!,process.env.LAVALINK_CLIENT_KEY!,discord.user!.id);
const voice=new VoiceBridge(discord,node);let queue:Track[]=[];let current:Track|undefined;let joined=false;let connectedOnce=false;let commandRunning=false;
async function playNext(){current=queue.shift();if(current)await node.update(guild,{track:{encoded:current.encoded}});}
node.on('failure',code=>console.error(JSON.stringify({event:'bot_node_failure',code})));
node.on('exhausted',()=>console.error(JSON.stringify({event:'reconnect_exhausted',action:'Inspect node health and restart bot after recovery'})));
node.on('ready',packet=>{void(async()=>{
  console.log(JSON.stringify({event:'node_ready',resumed:packet.resumed}));
  if(connectedOnce&&!packet.resumed&&joined){const saved=current;await voice.leave(guild).catch(()=>{});await sleep(500);await voice.join(guild,channel);if(saved)await node.update(guild,{track:{encoded:saved.encoded}});}
  connectedOnce=true;
})().catch(()=>console.error(JSON.stringify({event:'playback_recreation_failed'})));});
node.on('packet',packet=>{if(packet.type==='TrackEndEvent'&&['finished','loadFailed'].includes(packet.reason))void playNext().catch(()=>console.error(JSON.stringify({event:'next_track_failed'})));if(packet.type==='TrackExceptionEvent')console.error(JSON.stringify({event:'source_playback_failed'}));});
node.connect();
discord.on('messageCreate',message=>{void(async()=>{
  if(message.author.bot||message.author.id!==process.env.BOT_OWNER_ID||message.guildId!==guild||!message.content.startsWith('!'))return;
  if(commandRunning){await message.reply('Command sebelumnya sedang diproses.');return;}commandRunning=true;
  try {
    const [command,...args]=message.content.slice(1).trim().split(/\s+/);const value=args.join(' ');
    switch(command){
      case 'join': if(!joined){await voice.join(guild,channel);joined=true;}break;
      case 'play':{
        if(!value)throw new Error('IDENTIFIER_REQUIRED');
        if(!joined){await voice.join(guild,channel);joined=true;}
        const result=await node.load(value);queue.push(...(result.loadType==='search'?result.tracks.slice(0,1):result.tracks.slice(0,100)));
        if(!current)await playNext();break;
      }
      case 'pause':await node.update(guild,{paused:true});break;
      case 'resume':await node.update(guild,{paused:false});break;
      case 'volume':{const volume=Number(value);if(!value||!Number.isInteger(volume)||volume<0||volume>150)throw new Error('VOLUME_0_TO_150');await node.update(guild,{volume});break;}
      case 'skip':current=undefined;await node.update(guild,{track:{encoded:null}});await playNext();break;
      case 'stop':queue=[];current=undefined;await node.update(guild,{track:{encoded:null}});break;
      case 'leave':queue=[];current=undefined;joined=false;await voice.leave(guild);break;
      default:await message.reply('Commands: !join, !play <identifier>, !pause, !resume, !volume <0-150>, !skip, !stop, !leave');return;
    }
    await message.reply('Command diproses. Playback berhasil hanya jika audio terdengar di voice channel.');
  } catch {await message.reply('Command gagal. Periksa node, izin voice, dan sumber audio. Coba lagi setelah koneksi pulih.');}
  finally {commandRunning=false;}
})().catch(()=>console.error(JSON.stringify({event:'bot_command_failed'})));});
async function close(){await voice.leave(guild).catch(()=>{});voice.dispose();node.close();discord.destroy();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
