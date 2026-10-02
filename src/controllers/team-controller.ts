import { Request, Response } from 'express';
import { z } from 'zod';
import * as teams from '../services/team-service';

const teamId = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const role = z.enum(['admin', 'member']);
const userId = z.string().uuid();

export async function list(req: Request, res: Response) {
  res.json({ teams: await teams.listTeams(req.user!) });
}

export async function create(req: Request, res: Response) {
  const body = z.object({ name }).parse(req.body);
  res.status(201).json({ team: await teams.createTeam(req.user!, body.name) });
}

export async function get(req: Request, res: Response) {
  res.json({ team: await teams.getTeam(teamId.parse(req.params.id), req.user!) });
}

export async function rename(req: Request, res: Response) {
  const body = z.object({ name }).parse(req.body);
  res.json({ team: await teams.renameTeam(teamId.parse(req.params.id), req.user!, body.name) });
}

export async function remove(req: Request, res: Response) {
  await teams.deleteTeam(teamId.parse(req.params.id), req.user!);
  res.status(204).end();
}

export async function addMember(req: Request, res: Response) {
  const body = z.object({ email: z.string().trim().email().max(254), role }).parse(req.body);
  res.json(await teams.addMember(teamId.parse(req.params.id), req.user!, body.email, body.role));
}

export async function changeRole(req: Request, res: Response) {
  const body = z.object({ role }).parse(req.body);
  const team = await teams.changeMemberRole(
    teamId.parse(req.params.id),
    req.user!,
    userId.parse(req.params.userId),
    body.role,
  );
  res.json({ team });
}

export async function removeMember(req: Request, res: Response) {
  await teams.removeMember(teamId.parse(req.params.id), req.user!, userId.parse(req.params.userId));
  res.status(204).end();
}

export async function cancelInvite(req: Request, res: Response) {
  const inviteId = z
    .string()
    .regex(/^\d{1,18}$/)
    .parse(req.params.inviteId);
  res.json({ team: await teams.cancelInvite(teamId.parse(req.params.id), req.user!, inviteId) });
}

// ---- diagrams shared with teams (mounted under /diagrams/:id/teams)

const diagramId = z.string().uuid();
const shareRole = z.enum(['editor', 'viewer']);

export async function share(req: Request, res: Response) {
  const body = z.object({ teamId, role: shareRole }).parse(req.body);
  await teams.shareWithTeam(diagramId.parse(req.params.id), req.user!, body.teamId, body.role);
  res.status(204).end();
}

export async function changeShare(req: Request, res: Response) {
  const body = z.object({ role: shareRole }).parse(req.body);
  await teams.shareWithTeam(
    diagramId.parse(req.params.id),
    req.user!,
    teamId.parse(req.params.teamId),
    body.role,
  );
  res.status(204).end();
}

export async function unshare(req: Request, res: Response) {
  await teams.unshareWithTeam(
    diagramId.parse(req.params.id),
    req.user!,
    teamId.parse(req.params.teamId),
  );
  res.status(204).end();
}
