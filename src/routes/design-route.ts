import express from 'express';
import {
  createOrGet,
  del,
  get,
  getCommits,
  update,
  getRevision,
  getRevisionsForFile,
  listDesigns,
  createSnapshot,
  autoSave,
  getDesign,
  updateDesign,
  verifyPin,
  updatePin,
} from '../controllers/design-controller';
import { pinGuard } from '../middleware/pin-guard';

const designRouter = express.Router();

// List all designs with pagination and search
designRouter.get('/', listDesigns as any);

// Create new design (no PIN guard — PIN is set HERE during creation)
designRouter.post('/', createOrGet as any);

// Verify PIN and receive access token (no PIN guard — this IS the verification step)
designRouter.post('/:id/verify-pin', verifyPin as any);

// Update/set/remove PIN — requires current PIN if already protected (verified inside controller)
designRouter.patch('/:id/pin', pinGuard as any, updatePin as any);

// All routes below are protected by pinGuard
designRouter.get('/:id', pinGuard as any, get as any);
designRouter.delete('/:id', pinGuard as any, del as any);
designRouter.patch('/:id', pinGuard as any, update as any);
designRouter.post('/:id/autosave', pinGuard as any, autoSave as any);
designRouter.post('/:id/snapshot', pinGuard as any, createSnapshot as any);

// ====== BACKWARD COMPATIBILITY ROUTES ======
designRouter.get('/design/:id', pinGuard as any, getDesign as any);
designRouter.put('/design/:id', pinGuard as any, updateDesign as any);

designRouter.get('/:id/commits', pinGuard as any, getCommits as any);
designRouter.get('/:id/versions', pinGuard as any, getCommits as any);
designRouter.get('/:id/file-versions/:file', pinGuard as any, getRevisionsForFile as any);
designRouter.get('/:id/:sha', pinGuard as any, getRevision as any); // Must be last

export { designRouter };
