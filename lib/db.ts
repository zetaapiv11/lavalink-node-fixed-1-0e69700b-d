import pg from 'pg';
import { databaseConfig } from './database-config';
const globalDb = globalThis as unknown as { pool?: pg.Pool };
export function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_UNCONFIGURED');
  if (!globalDb.pool) {
    globalDb.pool = new pg.Pool(databaseConfig(process.env.DATABASE_URL,process.env.DATABASE_SSL === 'true'));
    globalDb.pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
  }
  return globalDb.pool;
}
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  return database().query<T>(sql, params);
}
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
