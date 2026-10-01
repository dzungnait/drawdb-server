import express from 'express';
import * as c from '../controllers/diagram-controller';
import * as v from '../controllers/version-controller';
import * as m from '../controllers/member-controller';
import { shareLimiter } from '../middleware/rate-limit';
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

diagramRouter.get('/:id/members', h(m.list));
diagramRouter.post('/:id/members', shareLimiter, h(m.share));
diagramRouter.patch('/:id/members/:userId', h(m.changeRole));
diagramRouter.delete('/:id/members/:userId', h(m.remove));
diagramRouter.delete('/:id/invites/:inviteId', h(m.cancelInvite));

export { diagramRouter };
