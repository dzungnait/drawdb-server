-- Sharing diagrams with other people

-- People a diagram is shared with (the owner is diagrams.owner_id)
CREATE TABLE diagram_members (
  diagram_id UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (diagram_id, user_id)
);

-- "Shared with me" lists
CREATE INDEX diagram_members_user_idx ON diagram_members (user_id);

-- Invitations to an email without an account yet; they become
-- memberships once someone signs up with (and owns) that email
CREATE TABLE diagram_invites (
  id         BIGSERIAL PRIMARY KEY,
  diagram_id UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, email)
);

CREATE INDEX diagram_invites_email_idx ON diagram_invites (email);
