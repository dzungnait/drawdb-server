import { Request, Response } from "express";
import lockService from "../services/lock-service";

class LockController {
  /**
   * POST /gists/:id/lock
   * Acquire lock on design
   */
  async lock(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { sessionId } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: "sessionId required" });
        return;
      }

      const acquired = await lockService.acquireLock(id, sessionId);

      if (!acquired) {
        const lock = await lockService.getLock(id);
        res.status(409).json({
          error: "Design locked",
          lockedBy: lock?.session_id,
          lockedAt: lock?.locked_at,
        });
        return;
      }

      res.json({ success: true, designId: id, sessionId });
    } catch (error) {
      console.error("Lock error:", error);
      res.status(500).json({ error: "Failed to acquire lock" });
    }
  }

  /**
   * DELETE /gists/:id/unlock
   * Release lock on design
   */
  async unlock(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { sessionId } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: "sessionId required" });
        return;
      }

      await lockService.releaseLock(id, sessionId);
      res.json({ success: true });
    } catch (error) {
      console.error("Unlock error:", error);
      res.status(500).json({ error: "Failed to release lock" });
    }
  }

  /**
   * POST /gists/:id/heartbeat
   * Keep lock alive & check status
   */
  async heartbeat(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { sessionId } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: "sessionId required" });
        return;
      }

      const refreshed = await lockService.heartbeat(id, sessionId);

      if (!refreshed) {
        res.status(404).json({ error: "Lock not found" });
        return;
      }

      res.json({ success: true, designId: id });
    } catch (error) {
      console.error("Heartbeat error:", error);
      res.status(500).json({ error: "Failed to heartbeat" });
    }
  }
}

const lockController = new LockController();

export const lock = lockController.lock.bind(lockController);
export const unlock = lockController.unlock.bind(lockController);
export const heartbeat = lockController.heartbeat.bind(lockController);
