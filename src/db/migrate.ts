import { promises as fs } from 'fs';
import path from 'path';
import { getPool } from './index';

// Same relative location from src/db and dist/db
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
// Arbitrary constant: only one instance migrates at a time
const LOCK_ID = 7_351_001;

/**
 * Applies every migrations/*.sql file not yet recorded in
 * schema_migrations, in filename order, each in its own transaction.
 * Safe to run on every start and from several instances at once.
 */
export async function migrate(log: (msg: string) => void = console.log) {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        log(`Applied migration ${version}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${version} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
