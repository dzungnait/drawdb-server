import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { DesignService } from '../services/design-service';
import { config } from '../config';

export interface PinTokenPayload {
  designId: string;
  sub: 'pin-access';
}

/**
 * Middleware that protects design routes requiring PIN verification.
 *
 * If the design is NOT pin_protected → passes through immediately.
 * If the design IS pin_protected → requires a valid Bearer token in Authorization header.
 *
 * Returns:
 *   403 { success: false, requiresPin: true } — no/invalid token, client should prompt for PIN
 *   404 — design not found
 */
export async function pinGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({ success: false, message: 'Design not found' });
    }

    // Not PIN protected — let through
    if (!design.pin_protected) {
      return next();
    }

    // PIN protected — verify Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(403).json({
        success: false,
        requiresPin: true,
        message: 'This design is PIN protected. Please verify your PIN.',
      });
    }

    const token = authHeader.slice(7); // strip "Bearer "
    try {
      const payload = jwt.verify(token, config.jwt.secret) as PinTokenPayload;

      if (payload.sub !== 'pin-access' || payload.designId !== id) {
        return res.status(403).json({
          success: false,
          requiresPin: true,
          message: 'Invalid PIN token for this design.',
        });
      }

      return next();
    } catch {
      // JWT expired or tampered
      return res.status(403).json({
        success: false,
        requiresPin: true,
        message: 'PIN token expired. Please verify your PIN again.',
      });
    }
  } catch (e) {
    console.error('[pinGuard] Error:', e);
    return res.status(500).json({ success: false, message: 'Something went wrong' });
  }
}
