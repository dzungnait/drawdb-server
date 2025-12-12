import express from 'express';
import {
  createOrGet,
  del,
  get,
  getCommits,
  update,
  getRevision,
  getRevisionsForFile,
} from '../controllers/design-controller';
import {
  lock,
  unlock,
  heartbeat,
} from '../controllers/lock-controller';

const designRouter = express.Router();

// These endpoints mirror the gist API structure for compatibility
designRouter.post('/', createOrGet as any);
designRouter.get('/:id', get as any);
designRouter.delete('/:id', del as any);
designRouter.patch('/:id', update as any);
designRouter.get('/:id/commits', getCommits as any);
designRouter.get('/:id/:sha', getRevision as any);
designRouter.get('/:id/file-versions/:file', getRevisionsForFile as any);

// Lock management endpoints
designRouter.post('/:id/lock', lock as any);
designRouter.delete('/:id/unlock', unlock as any);
designRouter.post('/:id/heartbeat', heartbeat as any);

export { designRouter };
