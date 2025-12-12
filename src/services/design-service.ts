import pool from '../database/pool';
import { Design, DesignVersion } from '../interfaces/design';
import crypto from 'crypto';

const generateShareToken = () => crypto.randomBytes(16).toString('hex').substring(0, 21);

export const DesignService = {
  // Create a new design
  createDesign: async (
    name: string,
    description?: string,
    isPublic?: boolean,
    createdBy?: string,
  ): Promise<Design> => {
    const shareToken = generateShareToken();
    const query = `
      INSERT INTO designs (name, description, is_public, share_token, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await pool.query(query, [
      name,
      description || '',
      isPublic || false,
      shareToken,
      createdBy || null,
    ]);
    return result.rows[0] as Design;
  },

  // Get design by ID
  getDesign: async (designId: string): Promise<Design | null> => {
    const query = 'SELECT * FROM designs WHERE id = $1';
    const result = await pool.query(query, [designId]);
    return result.rows[0] || null;
  },

  // Get design by share token
  getDesignByShareToken: async (shareToken: string): Promise<Design | null> => {
    const query = 'SELECT * FROM designs WHERE share_token = $1';
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

  // Delete design (cascade delete versions)
  deleteDesign: async (designId: string): Promise<void> => {
    const query = 'DELETE FROM designs WHERE id = $1';
    await pool.query(query, [designId]);
  },

  // Save a new version
  saveVersion: async (
    designId: string,
    data: Record<string, any>,
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
      INSERT INTO design_versions (design_id, version_number, data, created_by, comment)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await pool.query(query, [
      designId,
      nextVersion,
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

    return {
      ...result.rows[0],
      data: JSON.parse(result.rows[0].data),
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
      data: JSON.parse(row.data),
    })) as DesignVersion[];

    return {
      versions,
      total: parseInt(countResult.rows[0].count, 10),
    };
  },

  // Get latest version
  getLatestVersion: async (designId: string): Promise<DesignVersion | null> => {
    const query = `
      SELECT * FROM design_versions
      WHERE design_id = $1
      ORDER BY version_number DESC
      LIMIT 1
    `;
    const result = await pool.query(query, [designId]);
    if (!result.rows[0]) return null;

    return {
      ...result.rows[0],
      data: JSON.parse(result.rows[0].data),
    } as DesignVersion;
  },

  // Compare two versions
  compareVersions: async (
    designId: string,
    version1: number,
    version2: number,
  ): Promise<{
    version1: DesignVersion | null;
    version2: DesignVersion | null;
  }> => {
    const query = `
      SELECT * FROM design_versions
      WHERE design_id = $1 AND version_number IN ($2, $3)
    `;
    const result = await pool.query(query, [designId, version1, version2]);

    const versions = result.rows.reduce(
      (acc: any, row: any) => {
        const version = {
          ...row,
          data: JSON.parse(row.data),
        };
        if (row.version_number === version1) acc.version1 = version;
        if (row.version_number === version2) acc.version2 = version;
        return acc;
      },
      { version1: null, version2: null },
    );

    return versions;
  },
};
