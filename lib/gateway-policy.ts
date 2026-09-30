import { z } from 'zod';
export const playerPatch = z.object({
  track:z.object({encoded:z.string().max(16000).nullable().optional(),identifier:z.string().max(2000).optional(),userData:z.record(z.string(),z.unknown()).optional()}).strict().optional(),
  position:z.number().int().nonnegative().optional(),endTime:z.number().int().positive().nullable().optional(),
  volume:z.number().int().min(0).max(150).optional(),paused:z.boolean().optional(),
  voice:z.object({token:z.string().min(1).max(4000),endpoint:z.string().max(300).regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.discord\.media(?::443)?$/i),sessionId:z.string().min(1).max(200),channelId:z.string().regex(/^\d{17,20}$/)}).strict().optional(),
}).strict();
export const sessionPatch=z.object({resuming:z.boolean().optional(),timeout:z.number().int().min(0).max(60).optional()}).strict();
export function protocolRoute(method:string,path:string) {
  if(method==='GET' && ['/version','/v4/info','/v4/stats','/v4/loadtracks','/v4/decodetrack'].includes(path)) return {kind:'read' as const};
  const match=path.match(/^\/v4\/sessions\/([A-Za-z0-9_-]{1,100})(?:\/players(?:\/(\d{17,20}))?)?$/);
  if(!match) return null;
  const sessionOnly=path===`/v4/sessions/${match[1]}`;
  if(sessionOnly && method==='PATCH') return {kind:'session' as const,session:match[1]};
  if(!sessionOnly && (method==='GET' || (match[2] && ['PATCH','DELETE'].includes(method)))) return {kind:'player' as const,session:match[1],guild:match[2]};
  return null;
}
