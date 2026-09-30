import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { query, transaction } from '@/lib/db';
import { checkOrigin, currentUser, requireUser } from '@/lib/auth';
import { digest, hashPassword, verifyPassword, newToken, privateIdentity, limit, HttpError } from '@/lib/security';
import { publicMetrics } from '@/lib/metrics';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const accountSchema = z.object({ email: z.email().max(254).transform(v=>v.trim().toLowerCase()), password: z.string().min(12).max(128) });
const respond = (data: unknown, status = 200) => NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400,'JSON diperlukan.');
  let value = ''; let size = 0; const decoder = new TextDecoder();
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 8192) { await reader.cancel(); throw new HttpError(413,'Request terlalu besar.'); }
    value += decoder.decode(part.value,{stream:true});
  }
  try { return JSON.parse(value + decoder.decode()); } catch { throw new HttpError(400,'JSON tidak valid.'); }
}
async function handle(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/^\/api\//,'');
  if (request.method === 'GET') {
    if (path === 'health') { await query('SELECT 1'); return respond({status:'ok'}); }
    if (path === 'public') return respond(await publicMetrics());
    if (path === 'me') return respond({user:await currentUser()});
    if (path === 'keys') {
      const user = await requireUser();
      return respond((await query('SELECT id,name,node_id,bot_id,created_at,revoked_at FROM client_keys WHERE user_id=$1 ORDER BY created_at DESC',[user.id])).rows);
    }
    if (path === 'admin') {
      await requireUser(true);
      const [users,audit,playback] = await Promise.all([
        query('SELECT id,email,role,disabled,access_approved,created_at FROM users ORDER BY created_at DESC LIMIT 200'),
        query('SELECT id,action,target,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 100'),
        query('SELECT node_id,checked_at,result,audible_confirmed FROM playback_runs ORDER BY checked_at DESC LIMIT 10')]);
      return respond({users:users.rows,audit:audit.rows,playback:playback.rows});
    }
    throw new HttpError(404,'Endpoint tidak ditemukan.');
  }
  checkOrigin(request);
  if (path === 'register' || path === 'login') {
    // A global ceiling is intentional: forwarding headers are not trusted as identity.
    await limit('auth:global',100);
    const data = accountSchema.parse(await body(request));
    await limit(`auth:${privateIdentity(data.email)}`,10,900);
    if (path === 'register') {
      const password = await hashPassword(data.password);
      await transaction(async db => {
        const id = randomUUID();
        const result = await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING id',[id,data.email,password]);
        if (result.rowCount) await db.query("INSERT INTO audit_logs(user_id,action) VALUES($1,'account.registered')",[id]);
      });
      return respond({message:'Jika alamat belum terdaftar, akun telah dibuat. Silakan login.'},201);
    }
    const { rows } = await query('SELECT id,password_hash,disabled FROM users WHERE email=$1',[data.email]);
    const valid = await verifyPassword(data.password,rows[0]?.password_hash ?? '00000000000000000000000000000000:'+'00'.repeat(64));
    if (!valid || rows[0]?.disabled) throw new HttpError(401,'Email atau password salah.');
    const token = newToken();
    await transaction(async db => {
      await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[digest(token),rows[0].id]);
      await db.query("INSERT INTO audit_logs(user_id,action) VALUES($1,'account.login')",[rows[0].id]);
    });
    const response = respond({message:'Login berhasil.'});
    response.cookies.set('resonance_session',token,{httpOnly:true,secure:process.env.APP_ORIGIN?.startsWith('https:'),sameSite:'lax',path:'/',maxAge:604800});
    return response;
  }
  const user = await requireUser(path.startsWith('admin/'));
  await limit(`dashboard:${user.id}`,30);
  if (path === 'logout') {
    const token = request.cookies.get('resonance_session')?.value;
    if (token) await query('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);
    const response = respond({message:'Logout berhasil.'}); response.cookies.delete('resonance_session'); return response;
  }
  if (path === 'keys') {
    const data = z.object({ name:z.string().trim().min(1).max(60),nodeId:z.enum(['render','vps']),botId:z.string().regex(/^\d{17,20}$/) }).parse(await body(request));
    const token = `rs_${newToken()}`; const id = randomUUID();
    await transaction(async db => {
      const locked = (await db.query('SELECT access_approved,disabled FROM users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
      if (!locked.access_approved || locked.disabled) throw new HttpError(403,'Admin harus menyetujui akses audio terlebih dahulu.');
      const count = await db.query('SELECT count(*)::int n FROM client_keys WHERE user_id=$1 AND revoked_at IS NULL',[user.id]);
      if (count.rows[0].n >= 4) throw new HttpError(409,'Maksimal empat kredensial aktif.');
      await db.query('INSERT INTO client_keys(id,user_id,node_id,name,bot_id,token_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,user.id,data.nodeId,data.name,data.botId,digest(token)]);
      await db.query("INSERT INTO audit_logs(user_id,action,target) VALUES($1,'key.created',$2)",[user.id,id]);
    });
    return respond({id,token,message:'Simpan di secret manager bot. Kredensial hanya ditampilkan sekali.'},201);
  }
  if (path === 'keys/revoke') {
    const {id} = z.object({id:z.uuid()}).parse(await body(request));
    await transaction(async db => {
      const result = await db.query('UPDATE client_keys SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id',[id,user.id]);
      if (!result.rowCount) throw new HttpError(404,'Kredensial tidak ditemukan.');
      await db.query("INSERT INTO audit_logs(user_id,action,target) VALUES($1,'key.revoked',$2)",[user.id,id]);
    });
    return respond({message:'Akses dicabut; koneksi aktif ditutup dalam 15 detik.'});
  }
  if (path === 'admin/user') {
    const data = z.object({id:z.uuid(),action:z.enum(['approve','disable','enable'])}).parse(await body(request));
    if (data.id === user.id && data.action==='disable') throw new HttpError(400,'Tidak dapat menonaktifkan akun sendiri.');
    await transaction(async db => {
      const result = await db.query(`UPDATE users SET ${data.action==='approve'?'access_approved=true':data.action==='disable'?'disabled=true':'disabled=false'} WHERE id=$1 RETURNING id`,[data.id]);
      if (!result.rowCount) throw new HttpError(404,'Akun tidak ditemukan.');
      if (data.action==='disable') {
        await db.query('DELETE FROM sessions WHERE user_id=$1',[data.id]);
        await db.query('UPDATE client_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[data.id]);
      }
      await db.query('INSERT INTO audit_logs(user_id,action,target) VALUES($1,$2,$3)',[user.id,`user.${data.action}`,data.id]);
    });
    return respond({message:'Akun diperbarui.'});
  }
  if (path === 'admin/incidents') {
    const data = z.object({nodeId:z.enum(['render','vps']),title:z.string().trim().min(3).max(120),details:z.string().trim().min(3).max(2000)}).parse(await body(request));
    await transaction(async db => {
      const id=randomUUID();
      await db.query('INSERT INTO incidents(id,node_id,title,details) VALUES($1,$2,$3,$4)',[id,data.nodeId,data.title,data.details]);
      await db.query("INSERT INTO audit_logs(user_id,action,target) VALUES($1,'incident.created',$2)",[user.id,id]);
    });
    return respond({message:'Insiden diterbitkan.'},201);
  }
  if (path === 'admin/incidents/resolve') {
    const {id}=z.object({id:z.uuid()}).parse(await body(request));
    await transaction(async db=>{
      const result = await db.query('UPDATE incidents SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL RETURNING id',[id]);
      if (!result.rowCount) throw new HttpError(404,'Insiden aktif tidak ditemukan.');
      await db.query("INSERT INTO audit_logs(user_id,action,target) VALUES($1,'incident.resolved',$2)",[user.id,id]);
    });
    return respond({message:'Insiden diselesaikan.'});
  }
  throw new HttpError(404,'Endpoint tidak ditemukan.');
}
async function route(request: NextRequest) {
  try { return await handle(request); }
  catch(error) {
    if (error instanceof ZodError) return respond({error:'Input tidak valid. Periksa format dan panjang isian.'},400);
    if (error instanceof HttpError) { const response=respond({error:error.message},error.status); if(error.status===429) response.headers.set('Retry-After','60'); return response; }
    console.error(JSON.stringify({event:'api_error'}));
    return respond({error:'Layanan data belum tersedia. Coba lagi setelah koneksi database pulih.'},503);
  }
}
export const GET=route;
export const POST=route;
