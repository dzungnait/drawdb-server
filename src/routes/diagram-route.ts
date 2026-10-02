import express from 'express';
import * as c from '../controllers/diagram-controller';
import * as v from '../controllers/version-controller';
import * as m from '../controllers/member-controller';
import * as l from '../controllers/link-controller';
import * as t from '../controllers/team-controller';
import * as cm from '../controllers/comment-controller';
import { withShareLink } from '../utils/request-context';
import { shareLimiter } from '../middleware/rate-limit';
import { asyncHandler as h, requireUser } from '../auth/middleware';

const diagramRouter = express.Router();

// A share link (X-Share-Link header) can grant access to one diagram
diagramRouter.use(withShareLink);

diagramRouter.get('/', requireUser, h(c.list));
diagramRouter.get('/trash', requireUser, h(c.trash));
// Signed out works too, with a view link
diagramRouter.get('/:id', h(c.get));

diagramRouter.use(requireUser);

diagramRouter.post('/', h(c.create));
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
diagramRouter.post('/:id/owner', h(m.transferOwnership));

diagramRouter.get('/:id/links', h(l.list));
diagramRouter.put('/:id/links/:role', h(l.set));
diagramRouter.post('/:id/links/:role/regenerate', h(l.regenerate));
diagramRouter.delete('/:id/links/:role', h(l.remove));

diagramRouter.post('/:id/teams', h(t.share));
diagramRouter.patch('/:id/teams/:teamId', h(t.changeShare));
diagramRouter.delete('/:id/teams/:teamId', h(t.unshare));

diagramRouter.get('/:id/comments', h(cm.list));
diagramRouter.post('/:id/comments', h(cm.create));
diagramRouter.post('/:id/comments/:commentId/replies', h(cm.reply));
diagramRouter.post('/:id/comments/:commentId/resolve', h(cm.resolve));
diagramRouter.patch('/:id/comments/:commentId', h(cm.edit));
diagramRouter.delete('/:id/comments/:commentId', h(cm.remove));

export { diagramRouter };
