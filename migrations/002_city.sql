-- The city (world.js): plots, residents, project roles and community takeovers.

-- One row per claimed plot. The primary key is the first-come-first-served guard.
CREATE TABLE plots (
  plot_id     TEXT PRIMARY KEY,                -- '<district>-<1..6>', validated in world.js
  kind        TEXT NOT NULL CHECK (kind IN ('apartment','project')),
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  idea_id     TEXT UNIQUE REFERENCES ideas(id), -- one plot per idea
  claimed_at  INTEGER NOT NULL,
  CHECK ((kind = 'project') = (idea_id IS NOT NULL))
);
CREATE INDEX plots_wallet ON plots(wallet);

-- A wallet's character. plot_id is its apartment (one per wallet: the wallet is the key).
CREATE TABLE residents (
  wallet      TEXT PRIMARY KEY REFERENCES users(wallet),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 24),
  look_json   TEXT NOT NULL,
  room_json   TEXT,                            -- the apartment interior (world.js validateRoom); NULL = DEFAULT_ROOM
  plot_id     TEXT NOT NULL UNIQUE REFERENCES plots(plot_id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Community roles. Never related to fee recipients (those are locked on-chain at launch).
CREATE TABLE project_roles (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  wallet      TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('founder','community_lead','moderator')),
  granted_by  TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, wallet)
);
CREATE UNIQUE INDEX project_roles_one_founder ON project_roles(project_id) WHERE role = 'founder';

CREATE TABLE takeover_requests (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  requester   TEXT NOT NULL REFERENCES users(wallet),
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status      TEXT NOT NULL CHECK (status IN ('open','approved','rejected','withdrawn')),
  decided_by  TEXT,
  decided_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX takeover_one_open ON takeover_requests(project_id) WHERE status = 'open';

-- existing projects: the submitter is the founder
INSERT INTO project_roles (project_id, wallet, role, granted_by, granted_at)
  SELECT p.id, i.owner_wallet, 'founder', 'system', p.created_at FROM projects p JOIN ideas i ON i.id = p.idea_id;
