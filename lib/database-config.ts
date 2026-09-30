import type { PoolConfig } from 'pg';
export function databaseConfig(connectionString: string, tls: boolean): PoolConfig {
  const url=new URL(connectionString);
  if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('INVALID_DATABASE_URL');
  // pg parses SSL parameters after config fields. Remove URL overrides so the
  // explicit verified-TLS policy cannot be downgraded by sslmode=require/disable.
  for(const key of [...url.searchParams.keys()])if(['ssl','sslmode','sslcert','sslkey','sslrootcert'].includes(key.toLowerCase()))url.searchParams.delete(key);
  return {connectionString:url.toString(),ssl:tls?{rejectUnauthorized:true}:false,
    max:8,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:10000};
}
