import { Request, Response } from 'express';
import { z } from 'zod';
import * as versions from '../services/version-service';

const diagramId = z.string().uuid();
const versionId = z.string().regex(/^\d{1,18}$/);
// Empty means unnamed
const label = z
  .string()
  .trim()
  .max(100)
  .nullish()
  .transform((v) => v || null);

const ids = (req: Request) => ({
  diagram: diagramId.parse(req.params.id),
  version: versionId.parse(req.params.versionId),
});

export async function list(req: Request, res: Response) {
  const q = z
    .object({ before: versionId.optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
    .parse(req.query);
  res.json(await versions.listVersions(diagramId.parse(req.params.id), req.user!, q));
}

export async function get(req: Request, res: Response) {
  const { diagram, version } = ids(req);
  res.json({ version: await versions.getVersion(diagram, version, req.user!) });
}

export async function create(req: Request, res: Response) {
  const body = z.object({ label }).parse(req.body);
  res.status(201).json({ version: await versions.createVersion(diagramId.parse(req.params.id), req.user!, body.label) });
}

export async function rename(req: Request, res: Response) {
  const { diagram, version } = ids(req);
  const body = z.object({ label }).parse(req.body);
  res.json({ version: await versions.renameVersion(diagram, version, req.user!, body.label) });
}

export async function remove(req: Request, res: Response) {
  const { diagram, version } = ids(req);
  await versions.deleteVersion(diagram, version, req.user!);
  res.status(204).end();
}

export async function restore(req: Request, res: Response) {
  const { diagram, version } = ids(req);
  res.json({ diagram: await versions.restoreVersion(diagram, version, req.user!) });
}
