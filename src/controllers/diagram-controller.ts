import { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import * as diagrams from '../services/diagram-service';

const id = z.string().uuid();
const items = z.array(z.unknown()).max(10_000);

// The editor's diagram state. Unknown keys are dropped rather than stored.
const content = z.object({
  tables: items.default([]),
  references: items.default([]),
  notes: items.default([]),
  areas: items.default([]),
  views: items.default([]),
  types: items.optional(),
  enums: items.optional(),
  pan: z.object({ x: z.number(), y: z.number() }).optional(),
  zoom: z.number().positive().optional(),
  gistId: z.string().max(200).optional(),
  loadedFromGistId: z.string().max(200).optional(),
});

const diagramBody = content.extend({
  name: z.string().trim().max(200).default(''),
  database: z.string().trim().min(1).max(50).default('generic'),
});

const toInput = (body: z.infer<typeof diagramBody>): diagrams.DiagramInput => {
  const { name, database, ...rest } = body;
  return { name, database, content: rest };
};

export async function list(req: Request, res: Response) {
  const { scope } = z
    .object({ scope: z.enum(['all', 'owned', 'shared']).default('all') })
    .parse(req.query);
  res.json({ diagrams: await diagrams.listDiagrams(req.user!, { scope }) });
}

export async function trash(req: Request, res: Response) {
  res.json({ diagrams: await diagrams.listDiagrams(req.user!, { trash: true }) });
}

export async function get(req: Request, res: Response) {
  // Anyone may ask, signed in or not; unverified accounts count as signed out
  // where verification is required
  const user =
    req.user && (!config.auth.requireEmailVerification || req.user.email_verified_at)
      ? req.user
      : null;
  res.json({ diagram: await diagrams.getDiagram(id.parse(req.params.id), user) });
}

export async function create(req: Request, res: Response) {
  const body = diagramBody.extend({ diagramId: id }).parse(req.body);
  const { diagramId, ...rest } = body;
  res
    .status(201)
    .json({ diagram: await diagrams.createDiagram(req.user!, diagramId, toInput(rest)) });
}

export async function update(req: Request, res: Response) {
  const body = diagramBody
    .extend({ baseVersion: z.number().int().optional(), force: z.boolean().optional() })
    .parse(req.body);
  const { baseVersion, force, ...rest } = body;
  const result = await diagrams.updateDiagram(id.parse(req.params.id), req.user!, toInput(rest), {
    baseVersion,
    force,
  });
  res.json(result);
}

export async function remove(req: Request, res: Response) {
  await diagrams.trashDiagram(id.parse(req.params.id), req.user!);
  res.status(204).end();
}

export async function restore(req: Request, res: Response) {
  res.json({ diagram: await diagrams.restoreDiagram(id.parse(req.params.id), req.user!) });
}

export async function removeForever(req: Request, res: Response) {
  await diagrams.deleteDiagramForever(id.parse(req.params.id), req.user!);
  res.status(204).end();
}
