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
} from '../controllers/design-controller';

const designRouter = express.Router();

// List all designs with pagination and search
designRouter.get('/', listDesigns as any);

// These endpoints mirror the gist API structure for compatibility
designRouter.post('/', createOrGet as any);
designRouter.get('/:id', get as any);
designRouter.delete('/:id', del as any);
designRouter.patch('/:id', update as any);
designRouter.post('/:id/autosave', autoSave as any);       // New endpoint for auto-save
designRouter.post('/:id/snapshot', createSnapshot as any); // Endpoint for manual version snapshots

// ====== BACKWARD COMPATIBILITY ROUTES ======
// These routes provide backward compatibility with old API structure
designRouter.get('/design/:id', getDesign as any);     // Get current snapshot as "design"
designRouter.put('/design/:id', updateDesign as any);  // Update current snapshot

designRouter.get('/:id/commits', getCommits as any);
designRouter.get('/:id/versions', getCommits as any);  // Alias for versions
designRouter.get('/:id/file-versions/:file', getRevisionsForFile as any);
designRouter.get('/:id/:sha', getRevision as any); // Must be last to avoid conflicts

export { designRouter };
