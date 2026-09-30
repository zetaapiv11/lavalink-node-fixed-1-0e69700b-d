import { readdir, readFile } from 'node:fs/promises';
import { database, transaction } from '../lib/db';
try {
  await transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(8246101)');
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f=>f.endsWith('.sql')).sort()) {
      if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1',[file])).rowCount) continue;
      await db.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
      console.log(`Applied ${file}`);
    }
  });
} finally { await database().end(); }
