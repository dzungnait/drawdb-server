-- Comments on a diagram's tables and fields, in threads

CREATE TABLE diagram_comments (
  id          BIGSERIAL PRIMARY KEY,
  diagram_id  UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  -- Replies point at the comment that starts their thread
  thread_id   BIGINT REFERENCES diagram_comments(id) ON DELETE CASCADE,
  -- What a thread is about (set on its first comment): a table, or one of
  -- its fields. Ids as in the diagram's content.
  table_id    TEXT,
  field_id    TEXT,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at   TIMESTAMPTZ
);

CREATE INDEX diagram_comments_diagram_idx ON diagram_comments (diagram_id, created_at);
CREATE INDEX diagram_comments_thread_idx ON diagram_comments (thread_id);
