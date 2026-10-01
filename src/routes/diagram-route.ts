import express from 'express';
import * as c from '../controllers/diagram-controller';
import * as v from '../controllers/version-controller';
import { asyncHandler as h, requireUser } from '../auth/middleware';

const diagramRouter = express.Router();

diagramRouter.use(requireUser);

diagramRouter.get('/', h(c.list));
diagramRouter.get('/trash', h(c.trash));
diagramRouter.post('/', h(c.create));
diagramRouter.get('/:id', h(c.get));
diagramRouter.put('/:id', h(c.update));
diagramRouter.delete('/:id', h(c.remove));
diagramRouter.post('/:id/restore', h(c.restore));
diagramRouter.delete('/:id/permanent', h(c.removeForever));

diagramRouter.get('/:id/versions', h(v.list));
diagramRouter.post('/:id/versions', h(v.create));
diagramRouter.get('/:id/versions/:versionId', h(v.get));
diagramRouter.patch('/:id/versions/:versionId', h(v.rename));
diagramRouter.delete('/:id/versions/:versionId', h(v.remove));
diagramRouter.post('/:id/versions/:versionId/restore', h(v.restore));

export { diagramRouter };
