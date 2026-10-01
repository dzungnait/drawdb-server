-- Links that give access to anyone who has them

CREATE TABLE share_links (
  diagram_id UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  -- viewer: anyone with the link can view, even signed out;
  -- editor: anyone signed in with the link can edit
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  -- Kept readable so the owner can copy the link again any time
  token      TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (diagram_id, role)
);
