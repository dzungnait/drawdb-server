import pool from '../database/pool';
import { config } from '../config';

export async function initializeDatabase() {
  try {
    console.log('Initializing database...');

    // Create designs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS designs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255),
        is_public BOOLEAN DEFAULT false,
        share_token VARCHAR(255) UNIQUE
      )
    `);

    // Create design_versions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS design_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255),
        comment TEXT,
        UNIQUE(design_id, version_number)
      )
    `);

    // Create user_locks table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_locks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        design_id UUID NOT NULL UNIQUE REFERENCES designs(id) ON DELETE CASCADE,
        session_id VARCHAR(255) NOT NULL,
        locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_design_versions_design_id 
      ON design_versions(design_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_design_versions_created_at 
      ON design_versions(created_at)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_designs_share_token 
      ON designs(share_token)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_designs_created_by 
      ON designs(created_by)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_locks_design_id 
      ON user_locks(design_id)
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    process.exit(1);
  }
}
