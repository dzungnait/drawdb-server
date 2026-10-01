import { Request, Response } from 'express';
import { z } from 'zod';
import * as members from '../services/member-service';

const diagramId = z.string().uuid();
const role = z.enum(['editor', 'viewer']);

export async function list(req: Request, res: Response) {
  res.json(await members.listMembers(diagramId.parse(req.params.id), req.user!));
}

export async function share(req: Request, res: Response) {
  const body = z.object({ email: z.string().trim().email().max(254), role }).parse(req.body);
  res.json(await members.shareDiagram(diagramId.parse(req.params.id), req.user!, body.email, body.role));
}

export async function changeRole(req: Request, res: Response) {
  const body = z.object({ role }).parse(req.body);
  res.json(
    await members.changeRole(diagramId.parse(req.params.id), req.user!, z.string().uuid().parse(req.params.userId), body.role),
  );
}

export async function remove(req: Request, res: Response) {
  await members.removeMember(diagramId.parse(req.params.id), req.user!, z.string().uuid().parse(req.params.userId));
  res.status(204).end();
}

export async function cancelInvite(req: Request, res: Response) {
  const inviteId = z.string().regex(/^\d{1,18}$/).parse(req.params.inviteId);
  res.json(await members.cancelInvite(diagramId.parse(req.params.id), req.user!, inviteId));
}
