import express from 'express';
import * as c from '../controllers/team-controller';
import { asyncHandler as h, requireUser } from '../auth/middleware';
import { shareLimiter } from '../middleware/rate-limit';

const teamRouter = express.Router();

teamRouter.use(requireUser);

teamRouter.get('/', h(c.list));
teamRouter.post('/', h(c.create));
teamRouter.get('/:id', h(c.get));
teamRouter.patch('/:id', h(c.rename));
teamRouter.delete('/:id', h(c.remove));
teamRouter.post('/:id/members', shareLimiter, h(c.addMember));
teamRouter.patch('/:id/members/:userId', h(c.changeRole));
teamRouter.delete('/:id/members/:userId', h(c.removeMember));
teamRouter.delete('/:id/invites/:inviteId', h(c.cancelInvite));

export { teamRouter };
