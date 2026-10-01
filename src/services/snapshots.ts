import { PoolClient } from 'pg';
import { config } from '../config';
import { query } from '../db';

export type SnapshotKind = 'auto' | 'manual' | 'pre_restore' | 'pre_overwrite';

const COPY_CURRENT = `
  INSERT INTO diagram_versions
         (diagram_id, diagram_version, kind, label, name, database, content, size_bytes, author_id)
  SELECT d.id, d.version, $2, $3, d.name, d.database, d.content, d.size_bytes, COALESCE($4, d.updated_by)
    FROM diagrams d
   WHERE d.id = $1`;

/** No snapshot of the diagram's current content exists yet. */
const NOT_KEPT_YET = `NOT EXISTS (
  SELECT 1 FROM diagram_versions v WHERE v.diagram_id = d.id AND v.diagram_version = d.version)`;

/**
 * Keeps the diagram's current content before it gets replaced (by a
 * restore or a forced save). Call with the diagram row locked.
 */
export async function keepCurrent(db: PoolClient, diagramId: string, kind: 'pre_restore' | 'pre_overwrite') {
  await db.query(`${COPY_CURRENT} AND ${NOT_KEPT_YET}`, [diagramId, kind, null, null]);
}

/**
 * Called before each save: keeps the content being replaced unless a
 * snapshot was taken recently. So history has the state at the start of
 * every editing session, then one every few minutes while it goes on.
 */
export async function keepCurrentIfDue(db: PoolClient, diagramId: string) {
  await db.query(
    `${COPY_CURRENT} AND NOT EXISTS (
       SELECT 1 FROM diagram_versions v
        WHERE v.diagram_id = d.id
          AND (v.diagram_version = d.version OR v.created_at > now() - make_interval(mins => $5)))`,
    [diagramId, 'auto', null, null, config.versions.intervalMinutes],
  );
}

/** A version someone saves on purpose; returns its id. */
export async function saveCurrent(db: PoolClient, diagramId: string, authorId: string, label: string | null) {
  const { rows } = await db.query<{ id: string }>(`${COPY_CURRENT} RETURNING id`, [
    diagramId,
    'manual',
    label,
    authorId,
  ]);
  return rows[0].id;
}

/**
 * Thins out unnamed automatic versions: all of the last day are kept,
 * then the latest of each hour for a week, then the latest of each day,
 * until the retention period ends.
 */
export async function purgeVersions() {
  await query(
    `DELETE FROM diagram_versions v
      USING (
        SELECT id, created_at, row_number() OVER (
                 PARTITION BY diagram_id,
                   CASE WHEN created_at > now() - interval '1 day' THEN id::text
                        WHEN created_at > now() - interval '7 days' THEN date_trunc('hour', created_at)::text
                        ELSE date_trunc('day', created_at)::text END
                 ORDER BY created_at DESC, id DESC) AS rank
          FROM diagram_versions
         WHERE label IS NULL AND kind <> 'manual'
      ) x
     WHERE v.id = x.id
       AND (x.rank > 1 OR ($1 > 0 AND x.created_at < now() - make_interval(days => $1)))`,
    [config.versions.retentionDays],
  );
}
