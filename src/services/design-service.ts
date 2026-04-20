import pool from '../database/pool';
import { Design, DesignVersion } from '../interfaces/design';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const generateShareToken = () => crypto.randomBytes(16).toString('hex').substring(0, 21);
const PIN_SALT_ROUNDS = 10;

export const DesignService = {
  // Hash a plain-text PIN
  hashPin: async (pin: string): Promise<string> => {
    return bcrypt.hash(pin, PIN_SALT_ROUNDS);
  },

  // Compare plain-text PIN against stored hash
  verifyPinHash: async (pin: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(pin, hash);
  },

  // Create a new design
  createDesign: async (
    name: string,
    description?: string,
    isPublic?: boolean,
    createdBy?: string,
    pinHash?: string,
  ): Promise<Design> => {
    const shareToken = generateShareToken();
    const query = `
      INSERT INTO designs (name, description, is_public, share_token, created_by, pin_hash, pin_protected)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const result = await pool.query(query, [
      name,
      description || '',
      isPublic || false,
      shareToken,
      createdBy || null,
      pinHash || null,
      pinHash ? true : false,
    ]);
    return result.rows[0] as Design;
  },

  // Get design by ID (excludes soft-deleted)
  getDesign: async (designId: string): Promise<Design | null> => {
    const query = 'SELECT * FROM designs WHERE id = $1 AND deleted_at IS NULL';
    const result = await pool.query(query, [designId]);
    return result.rows[0] || null;
  },

  // Get design by share token (excludes soft-deleted)
  getDesignByShareToken: async (shareToken: string): Promise<Design | null> => {
    const query = 'SELECT * FROM designs WHERE share_token = $1 AND deleted_at IS NULL';
    const result = await pool.query(query, [shareToken]);
    return result.rows[0] || null;
  },

  // Update design metadata
  updateDesign: async (
    designId: string,
    name?: string,
    description?: string,
  ): Promise<Design> => {
    const query = `
      UPDATE designs
      SET name = COALESCE($2, name),
          description = COALESCE($3, description),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [designId, name || null, description || null]);
    return result.rows[0] as Design;
  },

  // Soft-delete design
  deleteDesign: async (designId: string): Promise<void> => {
    const query = 'UPDATE designs SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL';
    await pool.query(query, [designId]);
  },

  // Restore a soft-deleted design
  restoreDesign: async (designId: string): Promise<Design | null> => {
    const query = 'UPDATE designs SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *';
    const result = await pool.query(query, [designId]);
    return result.rows[0] || null;
  },

  // Permanently delete a design (hard delete)
  permanentlyDeleteDesign: async (designId: string): Promise<void> => {
    const query = 'DELETE FROM designs WHERE id = $1';
    await pool.query(query, [designId]);
  },

  // ====== DESIGN SNAPSHOT OPERATIONS (Auto-save/Current State) ======
  
  // Save or update current design snapshot (auto-save)
  saveSnapshot: async (
    designId: string,
    data: Record<string, any>,
    createdBy?: string,
    lastModifiedBy?: string,
  ): Promise<any> => {
    // Use UPSERT to either insert or update existing snapshot
    const query = `
      INSERT INTO design_snapshot (design_id, data, version, created_by, last_modified_by)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (design_id) 
      DO UPDATE SET 
        data = EXCLUDED.data,
        version = design_snapshot.version + 1,
        updated_at = CURRENT_TIMESTAMP,
        last_modified_by = EXCLUDED.last_modified_by
      RETURNING *
    `;
    const result = await pool.query(query, [
      designId,
      JSON.stringify(data),
      createdBy || null,
      lastModifiedBy || null,
    ]);
    return {
      ...result.rows[0],
      data: data,
    };
  },

  // Save with version conflict detection
  saveSnapshotWithVersionCheck: async (
    designId: string,
    data: Record<string, any>,
    expectedVersion: number,
    lastModifiedBy?: string,
  ): Promise<{ success: boolean; data?: any; conflict?: any }> => {
    try {
      // First, get current version
      const currentSnapshot = await DesignService.getSnapshot(designId);
      
      if (currentSnapshot && currentSnapshot.version !== expectedVersion) {
        // Version conflict detected
        return {
          success: false,
          conflict: {
            message: "Conflict detected: Design has been modified by another user",
            currentVersion: currentSnapshot.version,
            expectedVersion: expectedVersion,
            currentData: currentSnapshot.data,
            serverLastModifiedBy: currentSnapshot.last_modified_by,
            serverUpdatedAt: currentSnapshot.updated_at
          }
        };
      }

      // No conflict, proceed with save
      const result = await DesignService.saveSnapshot(designId, data, undefined, lastModifiedBy);
      return {
        success: true,
        data: result
      };
    } catch (error) {
      console.error("Error in saveSnapshotWithVersionCheck:", error);
      throw error;
    }
  },

  // Get current snapshot
  getSnapshot: async (designId: string): Promise<any | null> => {
    const query = `
      SELECT * FROM design_snapshot
      WHERE design_id = $1
    `;
    const result = await pool.query(query, [designId]);
    if (!result.rows[0]) return null;

    const row = result.rows[0];
    return {
      ...row,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    };
  },

  // ====== DESIGN VERSIONS OPERATIONS (Manual Version Records) ======

  // ====== DESIGN VERSIONS OPERATIONS (Manual Version Records) ======
  
  // Save a new manual version record
  saveVersion: async (
    designId: string,
    data: Record<string, any>,
    versionName?: string,
    comment?: string,
    createdBy?: string,
  ): Promise<DesignVersion> => {
    // Get next version number
    const versionQuery = `
      SELECT COALESCE(MAX(version_number), 0) + 1 as next_version
      FROM design_versions
      WHERE design_id = $1
    `;
    const versionResult = await pool.query(versionQuery, [designId]);
    const nextVersion = versionResult.rows[0].next_version;

    // Insert new version
    const query = `
      INSERT INTO design_versions (design_id, version_number, version_name, data, created_by, comment)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const result = await pool.query(query, [
      designId,
      nextVersion,
      versionName || `Version ${nextVersion}`,
      JSON.stringify(data),
      createdBy || null,
      comment || null,
    ]);
    return {
      ...result.rows[0],
      data: data,
    } as DesignVersion;
  },

  // Get version by number
  getVersion: async (designId: string, versionNumber: number): Promise<DesignVersion | null> => {
    const query = `
      SELECT * FROM design_versions
      WHERE design_id = $1 AND version_number = $2
    `;
    const result = await pool.query(query, [designId, versionNumber]);
    if (!result.rows[0]) return null;

    const row = result.rows[0];
    return {
      ...row,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    } as DesignVersion;
  },

  // Get all versions for a design (with pagination)
  getVersions: async (
    designId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<{
    versions: DesignVersion[];
    total: number;
  }> => {
    const query = `
      SELECT * FROM design_versions
      WHERE design_id = $1
      ORDER BY version_number DESC
      LIMIT $2 OFFSET $3
    `;
    const countQuery = 'SELECT COUNT(*) FROM design_versions WHERE design_id = $1';

    const [result, countResult] = await Promise.all([
      pool.query(query, [designId, limit, offset]),
      pool.query(countQuery, [designId]),
    ]);

    const versions = result.rows.map((row: any) => ({
      ...row,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    })) as DesignVersion[];

    return {
      versions,
      total: parseInt(countResult.rows[0].count, 10),
    };
  },

  // ====== COMPATIBILITY LAYER (Keep old functions for backward compatibility) ======
  
  // Get latest version (for backward compatibility)
  getLatestVersion: async (designId: string): Promise<DesignVersion | null> => {
    // Return current snapshot as a "version" for compatibility
    const snapshot = await DesignService.getSnapshot(designId);
    if (!snapshot) return null;

    return {
      id: snapshot.id,
      design_id: designId,
      version_number: 1,
      version_name: "Current",
      data: snapshot.data,
      created_at: snapshot.updated_at,
      created_by: snapshot.created_by,
      comment: "Current working state",
    } as DesignVersion;
  },

  // Update version (for backward compatibility - actually updates snapshot)
  updateVersion: async (
    versionId: string,
    data: Record<string, any>,
  ): Promise<DesignVersion> => {
    // Find design by snapshot ID and update snapshot
    const query = `
      SELECT design_id FROM design_snapshot WHERE id = $1
    `;
    const result = await pool.query(query, [versionId]);
    if (!result.rows[0]) {
      throw new Error("Snapshot not found");
    }

    const designId = result.rows[0].design_id;
    const snapshot = await DesignService.saveSnapshot(designId, data);
    
    return {
      id: snapshot.id,
      design_id: designId,
      version_number: 1,
      version_name: "Current",
      data: snapshot.data,
      created_at: snapshot.updated_at,
      created_by: snapshot.created_by,
      comment: "Current working state",
    } as DesignVersion;
  },

  // List all designs with pagination and search
  listDesigns: async (
    page: number,
    limit: number,
    search: string,
  ): Promise<{ designs: any[]; total: number }> => {
    const offset = (page - 1) * limit;
    
    // Build search condition (always exclude soft-deleted)
    const searchCondition = search
      ? `WHERE deleted_at IS NULL AND (name ILIKE $1 OR description ILIKE $1)`
      : 'WHERE deleted_at IS NULL';
    
    const params: any[] = search ? [`%${search}%`, limit, offset] : [limit, offset];
    
    // Get total count
    const countQuery = `SELECT COUNT(*) FROM designs ${searchCondition}`;
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);
    
    // Get paginated results with current snapshot info
    const query = `
      SELECT 
        d.id,
        d.name,
        d.description,
        d.share_token,
        d.created_at,
        d.updated_at,
        d.is_public,
        d.pin_protected,
        ds.data as current_data,
        ds.updated_at as last_modified
      FROM designs d
      LEFT JOIN design_snapshot ds ON ds.design_id = d.id
      ${searchCondition}
      ORDER BY d.updated_at DESC
      LIMIT $${search ? '2' : '1'} OFFSET $${search ? '3' : '2'}
    `;
    
    const result = await pool.query(query, params);
    
    // Parse data and extract metadata
    const designs = result.rows.map(row => {
      const data = typeof row.current_data === 'string' 
        ? JSON.parse(row.current_data) 
        : row.current_data || {};
      
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        share_token: row.share_token,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_modified: row.last_modified,
        is_public: row.is_public,
        pin_protected: row.pin_protected || false,
        database: data.database || 'Generic',
        tables: data.tables || [],
        relationships: data.relationships || [],
      };
    });
    
    return { designs, total };
  },

  // Update or remove PIN protection for a design
  updatePinProtection: async (
    designId: string,
    pinHash: string | null,
    pinProtected: boolean,
  ): Promise<void> => {
    await pool.query(
      'UPDATE designs SET pin_hash = $1, pin_protected = $2 WHERE id = $3',
      [pinHash, pinProtected, designId],
    );
  },
};
