-- Teams, and sharing diagrams with a whole team

CREATE TABLE teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- admin: manages the team and its members; member: belongs to it
  role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user_idx ON team_members (user_id);

-- Like diagram_invites: emails without an account yet
CREATE TABLE team_invites (
  id         BIGSERIAL PRIMARY KEY,
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, email)
);

CREATE INDEX team_invites_email_idx ON team_invites (email);

-- Diagrams shared with every member of a team
CREATE TABLE diagram_team_shares (
  diagram_id UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  shared_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (diagram_id, team_id)
);

CREATE INDEX diagram_team_shares_team_idx ON diagram_team_shares (team_id);
