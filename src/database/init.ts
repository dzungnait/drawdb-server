import pool from '../database/pool';
import { config } from '../config';

export async function initializeDatabase() {
  try {
    console.log('Initializing database...');
    console.log('Database URL:', process.env.DATABASE_URL);

    // Test connection first
    try {
      const testResult = await pool.query('SELECT NOW()');
      console.log('✅ Database connection successful:', testResult.rows[0]);
    } catch (err) {
      console.error('❌ Database connection failed:', err);
      throw err;
    }

    // Test database name
    try {
      const dbNameResult = await pool.query('SELECT current_database()');
      console.log('📊 Current database:', dbNameResult.rows[0]);
    } catch (err) {
      console.error('❌ Failed to get database name:', err);
    }

    // Create designs table
    try {
      const result = await pool.query(`
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
      console.log('✓ designs table query result:', result.command);
      
      // Verify table exists
      const checkResult = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'designs'
        )
      `);
      console.log('✓ designs table exists:', checkResult.rows[0]);
    } catch (err) {
      console.error('✗ Error creating designs table:', err);
      throw err;
    }

    // Create design_versions table
    try {
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
      console.log('✓ design_versions table created');
    } catch (err) {
      console.error('✗ Error creating design_versions table:', err);
      throw err;
    }

    // Create user_locks table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_locks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          design_id UUID NOT NULL UNIQUE REFERENCES designs(id) ON DELETE CASCADE,
          session_id VARCHAR(255) NOT NULL,
          locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✓ user_locks table created');
    } catch (err) {
      console.error('✗ Error creating user_locks table:', err);
      throw err;
    }

    // Create indexes
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_design_versions_design_id 
        ON design_versions(design_id)
      `);
      console.log('✓ idx_design_versions_design_id created');
    } catch (err) {
      console.warn('⚠ Index idx_design_versions_design_id may already exist:', (err as Error).message);
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_design_versions_created_at 
        ON design_versions(created_at)
      `);
      console.log('✓ idx_design_versions_created_at created');
    } catch (err) {
      console.warn('⚠ Index idx_design_versions_created_at may already exist:', (err as Error).message);
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_designs_share_token 
        ON designs(share_token)
      `);
      console.log('✓ idx_designs_share_token created');
    } catch (err) {
      console.warn('⚠ Index idx_designs_share_token may already exist:', (err as Error).message);
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_designs_created_by 
        ON designs(created_by)
      `);
      console.log('✓ idx_designs_created_by created');
    } catch (err) {
      console.warn('⚠ Index idx_designs_created_by may already exist:', (err as Error).message);
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_user_locks_design_id 
        ON user_locks(design_id)
      `);
      console.log('✓ idx_user_locks_design_id created');
    } catch (err) {
      console.warn('⚠ Index idx_user_locks_design_id may already exist:', (err as Error).message);
    }

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    process.exit(1);
  }
}
