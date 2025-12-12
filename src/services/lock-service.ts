import pool from "../database/pool";
import { randomUUID } from "crypto";

export interface Lock {
  id: string;
  design_id: string;
  session_id: string;
  locked_at: Date;
}

class LockService {
  /**
   * Acquire lock on design
   * Returns true if lock acquired, false if locked by another session
   */
  async acquireLock(designId: string, sessionId: string): Promise<boolean> {
    try {
      // Check if design is already locked by another session
      const existingLock = await pool.query(
        "SELECT * FROM user_locks WHERE design_id = $1 AND session_id != $2",
        [designId, sessionId]
      );

      if (existingLock.rows.length > 0) {
        return false; // Locked by another session
      }

      // Upsert lock (update if session already has lock, insert if new)
      await pool.query(
        `INSERT INTO user_locks (id, design_id, session_id, locked_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (design_id) DO UPDATE SET
         locked_at = NOW()
         WHERE user_locks.session_id = $3`,
        [randomUUID(), designId, sessionId]
      );

      return true;
    } catch (error) {
      console.error("Error acquiring lock:", error);
      throw error;
    }
  }

  /**
   * Release lock on design
   */
  async releaseLock(designId: string, sessionId: string): Promise<void> {
    try {
      await pool.query(
        "DELETE FROM user_locks WHERE design_id = $1 AND session_id = $2",
        [designId, sessionId]
      );
    } catch (error) {
      console.error("Error releasing lock:", error);
      throw error;
    }
  }

  /**
   * Check if design is locked and by whom
   */
  async getLock(designId: string): Promise<Lock | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM user_locks WHERE design_id = $1",
        [designId]
      );
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      console.error("Error getting lock:", error);
      throw error;
    }
  }

  /**
   * Heartbeat - refresh lock expiry time
   */
  async heartbeat(designId: string, sessionId: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `UPDATE user_locks 
         SET locked_at = NOW() 
         WHERE design_id = $1 AND session_id = $2
         RETURNING *`,
        [designId, sessionId]
      );

      return result.rows.length > 0;
    } catch (error) {
      console.error("Error heartbeat:", error);
      throw error;
    }
  }
}

export default new LockService();
