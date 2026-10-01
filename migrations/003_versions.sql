-- Version history of diagrams

-- Who saved the current content (shown as the author of its snapshots)
ALTER TABLE diagrams ADD COLUMN updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE diagrams SET updated_by = owner_id;

CREATE TABLE diagram_versions (
  id              BIGSERIAL PRIMARY KEY,
  diagram_id      UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  -- The diagram's version number whose content this is
  diagram_version INTEGER NOT NULL,
  -- auto: taken while editing; manual: saved by a person;
  -- pre_restore / pre_overwrite: the state a restore or a forced save replaced
  kind            TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'pre_restore', 'pre_overwrite')),
  -- Named versions are kept forever; unnamed ones are thinned out over time
  label           TEXT,
  name            TEXT NOT NULL,
  database        TEXT NOT NULL,
  content         JSONB NOT NULL,
  size_bytes      INTEGER NOT NULL,
  -- Who saved it (manual) or who made the edits it holds (the others)
  author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX diagram_versions_diagram_idx ON diagram_versions (diagram_id, id DESC);
CREATE INDEX diagram_versions_unnamed_idx ON diagram_versions (created_at) WHERE label IS NULL;
