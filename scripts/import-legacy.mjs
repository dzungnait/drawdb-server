#!/usr/bin/env node
/**
 * Copies the diagrams of the earlier drawDB server (tables designs,
 * design_snapshot, design_versions) into this server's database.
 *
 *   node scripts/import-legacy.mjs --from <old db url> --to <new db url> \
 *     --owner <email> [--dry-run]
 *
 * - Each design becomes a diagram with the same id (so links keep working),
 *   owned by --owner, an existing account here. The old PINs and share
 *   tokens are not carried over: access is given by sharing.
 * - Its old versions become named versions ("Old version 12"), which are
 *   kept forever. The old server didn't record authors; the owner is
 *   shown instead of "deleted user".
 * - Designs in the old trash stay in the trash.
 * - Diagrams already here are skipped, so it can be run again.
 *
 * Everything is written in one transaction. The old database is only read.
 */
import pg from 'pg';

// The old tables use timestamps without a time zone, written in UTC
pg.types.setTypeParser(1114, (s) => new Date(`${s.replace(' ', 'T')}Z`));

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'dry-run') out.dryRun = true;
    else out[key] = argv[++i];
  }
  if (!out.from || !out.to || !out.owner) {
    console.error(
      'Usage: node scripts/import-legacy.mjs --from <old db url> --to <new db url> --owner <email> [--dry-run]',
    );
    process.exit(2);
  }
  return out;
}

/** The old export format, in the shape this server stores. */
function toContent(data) {
  return {
    tables: data.tables ?? [],
    references: data.relationships ?? data.references ?? [],
    notes: data.notes ?? [],
    areas: data.subjectAreas ?? data.areas ?? [],
    views: data.views ?? [],
    types: data.types ?? [],
    enums: data.enums ?? [],
  };
}

const sizeOf = (content) => Buffer.byteLength(JSON.stringify(content));

async function main() {
  const { from, to, owner, dryRun } = args();
  const source = new pg.Client({ connectionString: from });
  const target = new pg.Client({ connectionString: to });
  await source.connect();
  await target.connect();
  try {
    const {
      rows: [user],
    } = await target.query('SELECT id, email FROM users WHERE email = lower($1)', [owner]);
    if (!user) throw new Error(`No account with the email ${owner} here; sign up first`);

    const { rows: designs } = await source.query(
      `SELECT d.id, d.name, d.created_at, d.updated_at, d.deleted_at,
              s.data, s.updated_at AS saved_at
         FROM designs d JOIN design_snapshot s ON s.design_id = d.id
        ORDER BY d.created_at`,
    );
    const { rows: existing } = await target.query('SELECT id FROM diagrams WHERE id = ANY($1)', [
      designs.map((d) => d.id),
    ]);
    const skip = new Set(existing.map((r) => r.id));

    await target.query('BEGIN');
    let diagrams = 0;
    let versions = 0;
    for (const d of designs) {
      if (skip.has(d.id)) {
        console.log(`skip     ${d.id}  ${d.name} (already here)`);
        continue;
      }
      const content = toContent(d.data);
      const database = d.data.database || 'generic';
      await target.query(
        `INSERT INTO diagrams (id, owner_id, updated_by, name, database, content, size_bytes,
                               created_at, updated_at, deleted_at)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          d.id,
          user.id,
          d.name,
          database,
          content,
          sizeOf(content),
          d.created_at ?? new Date(),
          d.saved_at ?? d.updated_at ?? new Date(),
          d.deleted_at,
        ],
      );
      diagrams++;

      const { rows: old } = await source.query(
        `SELECT version_number, data, created_at FROM design_versions
          WHERE design_id = $1 ORDER BY version_number`,
        [d.id],
      );
      for (const v of old) {
        const versionContent = toContent(v.data);
        await target.query(
          `INSERT INTO diagram_versions (diagram_id, diagram_version, kind, label, name, database,
                                         content, size_bytes, author_id, created_at)
           VALUES ($1, 1, 'manual', $2, $3, $4, $5, $6, $7, $8)`,
          [
            d.id,
            `Old version ${v.version_number}`,
            v.data.title || d.name,
            v.data.database || database,
            versionContent,
            sizeOf(versionContent),
            user.id,
            v.created_at ?? new Date(),
          ],
        );
      }
      versions += old.length;
      const counts = `${content.tables.length} tables, ${content.references.length} references`;
      console.log(`import   ${d.id}  ${d.name} (${counts}, ${old.length} versions)`);
    }

    if (dryRun) {
      await target.query('ROLLBACK');
      console.log(`\nDry run: would import ${diagrams} diagrams and ${versions} versions`);
    } else {
      await target.query('COMMIT');
      console.log(`\nImported ${diagrams} diagrams and ${versions} versions for ${user.email}`);
    }
  } catch (e) {
    await target.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
