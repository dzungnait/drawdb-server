import { Request, Response } from 'express';
import { z } from 'zod';
import * as comments from '../services/comment-service';

const diagramId = z.string().uuid();
const commentId = z.string().regex(/^\d{1,18}$/);
const body = z.string().trim().min(1).max(5000);
// Table and field ids as the editor makes them
const elementId = z.union([z.string().min(1).max(100), z.number().int()]).transform(String);

export async function list(req: Request, res: Response) {
  res.json(await comments.listComments(diagramId.parse(req.params.id), req.user!));
}

export async function create(req: Request, res: Response) {
  const input = z
    .object({ tableId: elementId, fieldId: elementId.nullish(), body })
    .parse(req.body);
  res.status(201).json(await comments.addThread(diagramId.parse(req.params.id), req.user!, input));
}

export async function reply(req: Request, res: Response) {
  const input = z.object({ body }).parse(req.body);
  res
    .status(201)
    .json(
      await comments.reply(
        diagramId.parse(req.params.id),
        req.user!,
        commentId.parse(req.params.commentId),
        input.body,
      ),
    );
}

export async function resolve(req: Request, res: Response) {
  const input = z.object({ resolved: z.boolean() }).parse(req.body);
  res.json(
    await comments.resolveThread(
      diagramId.parse(req.params.id),
      req.user!,
      commentId.parse(req.params.commentId),
      input.resolved,
    ),
  );
}

export async function edit(req: Request, res: Response) {
  const input = z.object({ body }).parse(req.body);
  res.json(
    await comments.editComment(
      diagramId.parse(req.params.id),
      req.user!,
      commentId.parse(req.params.commentId),
      input.body,
    ),
  );
}

export async function remove(req: Request, res: Response) {
  res.json(
    await comments.deleteComment(
      diagramId.parse(req.params.id),
      req.user!,
      commentId.parse(req.params.commentId),
    ),
  );
}
