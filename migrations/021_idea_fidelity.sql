-- Does it match the idea? (src/fidelity.js, 2026-10-12). After SUB-01 composes the app and before he writes the words,
-- the idea's CORE features (the 2–5 things without which it is not this idea) are listed and each one is mapped to the
-- app's blocks and the site's tools: built, partially, or missing, with a one-line reason. One row per check (one per
-- build run); the newest row of an idea is what the author, the room PC and GET /api/ideas/:id show.
-- (021: 020 is taken by the PadPad feature work's 020_launchpad_family.sql, not merged yet; migrations are tracked by
-- file name, and this one depends only on ideas and projects, so either order applies cleanly.)
CREATE TABLE idea_fidelity (
  id          TEXT PRIMARY KEY,
  idea_id     TEXT NOT NULL REFERENCES ideas(id),
  project_id  TEXT REFERENCES projects(id),           -- set once the build has a project
  job_id      TEXT,                                   -- the generate job that ran the check (the build timeline's run)
  source      TEXT NOT NULL CHECK (source IN ('model', 'rules')),
  verdict     TEXT NOT NULL CHECK (verdict IN ('match', 'partial', 'missing')),
  result_json TEXT NOT NULL,                          -- fidelity/1: {core, tools, built, message, ...} (validateFidelity)
  created_at  INTEGER NOT NULL
);
CREATE INDEX idea_fidelity_idea ON idea_fidelity(idea_id, created_at);
-- One row per core feature that was not fully built: the admin page's "most requested missing capabilities".
CREATE TABLE fidelity_gaps (
  fidelity_id TEXT NOT NULL REFERENCES idea_fidelity(id),
  idea_id     TEXT NOT NULL REFERENCES ideas(id),
  capability  TEXT NOT NULL,                          -- kebab-case, reusable across ideas ('recursive-launchpads')
  feature     TEXT NOT NULL,                          -- the idea's own words for it, short
  status      TEXT NOT NULL CHECK (status IN ('partial', 'missing')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (fidelity_id, capability)
);
CREATE INDEX fidelity_gaps_capability ON fidelity_gaps(capability, status);
