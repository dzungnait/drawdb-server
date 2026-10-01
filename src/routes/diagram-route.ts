import express from 'express';
import * as c from '../controllers/diagram-controller';
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

export { diagramRouter };
