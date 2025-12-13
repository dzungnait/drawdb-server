import { Pool } from 'pg';
import { config } from '../config';

console.log('Connecting to database:', config.database.url);

const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err: Error) => {
  console.error('❌ Pool error:', err);
});

pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL');
});

export default pool;
