import { Request, Response } from 'express';
import { z } from 'zod';
import * as links from '../services/link-service';

const diagramId = z.string().uuid();
const role = z.enum(['editor', 'viewer']);

const params = (req: Request) => ({
  id: diagramId.parse(req.params.id),
  role: role.parse(req.params.role),
});

export async function list(req: Request, res: Response) {
  res.json({ links: await links.listLinks(diagramId.parse(req.params.id), req.user!) });
}

export async function set(req: Request, res: Response) {
  const { id, role: r } = params(req);
  const body = z.object({ expiresAt: z.coerce.date().nullish() }).parse(req.body);
  res.json({ links: await links.setLink(id, req.user!, r, body.expiresAt ?? null) });
}

export async function regenerate(req: Request, res: Response) {
  const { id, role: r } = params(req);
  res.json({ links: await links.regenerateLink(id, req.user!, r) });
}

export async function remove(req: Request, res: Response) {
  const { id, role: r } = params(req);
  res.json({ links: await links.deleteLink(id, req.user!, r) });
}
