import { query, queryOne } from '../db';
import { emitToRoom } from '../collab/rooms';
import { forbidden, HttpError, notFound } from '../utils/http-error';
import { load } from './diagram-service';
import { UserRow } from './user-service';

/** Comments plus replies, per diagram. */
const MAX_COMMENTS = 2000;

interface CommentRow {
  id: string;
  thread_id: string | null;
  table_id: string | null;
  field_id: string | null;
  author_id: string | null;
  author_name: string | null;
  author_avatar: string | null;
  body: string;
  resolved_at: Date | null;
  resolved_by_name: string | null;
  created_at: Date;
  edited_at: Date | null;
}

/**
 * Everyone the diagram is shared with can read and write comments, viewers
 * included. Not someone who only has a link: comments show who wrote them.
 */
async function loadForComments(diagramId: string, user: UserRow) {
  const access = await load(diagramId, user);
  if (access.via === 'link') throw forbidden('members_only');
  return access;
}

/** Tells everyone with the diagram open to fetch the comments again. */
const changed = (diagramId: string) => emitToRoom(diagramId, 'comments', { diagramId });

export async function listComments(diagramId: string, user: UserRow) {
  await loadForComments(diagramId, user);
  const rows = await query<CommentRow>(
    `SELECT c.id, c.thread_id, c.table_id, c.field_id, c.author_id, a.name AS author_name,
            a.avatar_url AS author_avatar, c.body, c.resolved_at, r.name AS resolved_by_name,
            c.created_at, c.edited_at
       FROM diagram_comments c
       LEFT JOIN users a ON a.id = c.author_id
       LEFT JOIN users r ON r.id = c.resolved_by
      WHERE c.diagram_id = $1
      ORDER BY c.created_at, c.id`,
    [diagramId],
  );
  const comment = (row: CommentRow) => ({
    id: row.id,
    author: row.author_id
      ? { id: row.author_id, name: row.author_name, avatarUrl: row.author_avatar }
      : null,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  });
  const threads = new Map<string, ReturnType<typeof thread>>();
  const thread = (row: CommentRow) => ({
    id: row.id,
    tableId: row.table_id,
    fieldId: row.field_id,
    resolved: row.resolved_at ? { at: row.resolved_at, by: row.resolved_by_name } : null,
    comments: [comment(row)],
  });
  for (const row of rows) {
    if (!row.thread_id) threads.set(row.id, thread(row));
    else threads.get(row.thread_id)?.comments.push(comment(row));
  }
  return { threads: [...threads.values()] };
}

async function assertRoom(diagramId: string) {
  const count = await queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM diagram_comments WHERE diagram_id = $1',
    [diagramId],
  );
  if (count!.n >= MAX_COMMENTS) {
    throw new HttpError(403, 'comment_limit_reached', `Up to ${MAX_COMMENTS} comments per diagram`);
  }
}

/** Starts a thread about a table, or one of its fields. */
export async function addThread(
  diagramId: string,
  user: UserRow,
  input: { tableId: string; fieldId?: string | null; body: string },
) {
  await loadForComments(diagramId, user);
  await assertRoom(diagramId);
  await query(
    `INSERT INTO diagram_comments (diagram_id, table_id, field_id, author_id, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [diagramId, input.tableId, input.fieldId ?? null, user.id, input.body],
  );
  changed(diagramId);
  return listComments(diagramId, user);
}

async function loadThread(diagramId: string, threadId: string) {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM diagram_comments WHERE id = $1 AND diagram_id = $2 AND thread_id IS NULL',
    [threadId, diagramId],
  );
  if (!row) throw notFound('comment_not_found');
}

export async function reply(diagramId: string, user: UserRow, threadId: string, body: string) {
  await loadForComments(diagramId, user);
  await loadThread(diagramId, threadId);
  await assertRoom(diagramId);
  await query(
    `INSERT INTO diagram_comments (diagram_id, thread_id, author_id, body) VALUES ($1, $2, $3, $4)`,
    [diagramId, threadId, user.id, body],
  );
  // Answering a resolved thread opens it again
  await query('UPDATE diagram_comments SET resolved_at = NULL, resolved_by = NULL WHERE id = $1', [
    threadId,
  ]);
  changed(diagramId);
  return listComments(diagramId, user);
}

export async function resolveThread(
  diagramId: string,
  user: UserRow,
  threadId: string,
  resolved: boolean,
) {
  await loadForComments(diagramId, user);
  await loadThread(diagramId, threadId);
  await query(
    resolved
      ? 'UPDATE diagram_comments SET resolved_at = now(), resolved_by = $2 WHERE id = $1'
      : 'UPDATE diagram_comments SET resolved_at = NULL, resolved_by = NULL WHERE id = $1',
    resolved ? [threadId, user.id] : [threadId],
  );
  changed(diagramId);
  return listComments(diagramId, user);
}

async function loadComment(diagramId: string, commentId: string) {
  const row = await queryOne<{ author_id: string | null }>(
    'SELECT author_id FROM diagram_comments WHERE id = $1 AND diagram_id = $2',
    [commentId, diagramId],
  );
  if (!row) throw notFound('comment_not_found');
  return row;
}

/** Only the author edits their comment. */
export async function editComment(
  diagramId: string,
  user: UserRow,
  commentId: string,
  body: string,
) {
  await loadForComments(diagramId, user);
  const row = await loadComment(diagramId, commentId);
  if (row.author_id !== user.id) throw forbidden('author_only');
  await query('UPDATE diagram_comments SET body = $2, edited_at = now() WHERE id = $1', [
    commentId,
    body,
  ]);
  changed(diagramId);
  return listComments(diagramId, user);
}

/** The author, or the diagram's owner; the first comment takes its thread. */
export async function deleteComment(diagramId: string, user: UserRow, commentId: string) {
  const { role } = await loadForComments(diagramId, user);
  const row = await loadComment(diagramId, commentId);
  if (row.author_id !== user.id && role !== 'owner') throw forbidden('author_only');
  await query('DELETE FROM diagram_comments WHERE id = $1', [commentId]);
  changed(diagramId);
  return listComments(diagramId, user);
}
