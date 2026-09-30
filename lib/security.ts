import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db';
const scrypt = promisify(scryptCallback);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(':');
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function secretEqual(supplied: string, expected: string) {
  return expected.length >= 32 && timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(expected)));
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function privateIdentity(value: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET_REQUIRED');
  return createHmac('sha256', secret).update(value).digest('hex');
}
// Atomic fixed-window counters shared by every process. Unknown identity uses a global bucket.
export async function limit(key: string, max: number, seconds = 60) {
  const { rows } = await query(`INSERT INTO rate_limits(key,window_start,hits) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.window_start <= now()-($2 * interval '1 second') THEN 1 ELSE rate_limits.hits+1 END,
    window_start=CASE WHEN rate_limits.window_start <= now()-($2 * interval '1 second') THEN now() ELSE rate_limits.window_start END RETURNING hits`, [key, seconds]);
  if (rows[0].hits > max) throw new HttpError(429, 'Batas request tercapai. Coba lagi nanti.');
}
export function safeUrl(raw: string, allowLoopback = false) {
  const url = new URL(raw);
  const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_NODE_URL');
  if (url.protocol !== 'https:' && !(allowLoopback && local && url.protocol === 'http:')) throw new Error('TLS_REQUIRED');
  return url;
}
