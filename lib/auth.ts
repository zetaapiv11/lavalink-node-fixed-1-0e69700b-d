import { cookies } from 'next/headers';
import { query } from './db';
import { digest, HttpError } from './security';
export type User = { id: string; email: string; role: 'user'|'admin'; access_approved: boolean };
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get('resonance_session')?.value;
  if (!token) return null;
  const { rows } = await query<User>(`SELECT u.id,u.email,u.role,u.access_approved FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`, [digest(token)]);
  return rows[0] ?? null;
}
export async function requireUser(admin = false) {
  const user = await currentUser();
  if (!user) throw new HttpError(401, 'Silakan login.');
  if (admin && user.role !== 'admin') throw new HttpError(403, 'Akses admin diperlukan.');
  return user;
}
export function checkOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN;
  if (!expected || request.headers.get('origin') !== new URL(expected).origin) throw new HttpError(403, 'Origin tidak diizinkan.');
}
