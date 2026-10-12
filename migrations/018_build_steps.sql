-- SUB-01's build, step by step (build-steps.js, 2026-10-12): the generate job records each step it goes through
-- (queued, brief, app, art, site, qa, ready) with its start, end, outcome and the provider
-- that did it. The city shows the timeline live and the ETA comes from these rows (median of the last 20 finished
-- builds per step). One row per step per run; a run is one attempt of one generate job (a retry starts a fresh run).
-- Observation only: nothing reads these rows to decide what gets built.
CREATE TABLE build_steps (
  idea_id     TEXT NOT NULL REFERENCES ideas(id),
  job_id      TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  step        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'skipped')),
  provider    TEXT,                -- who did it, as the author reads it ('language model', 'Higgsfield + local fallback', …)
  planned     TEXT,                -- who was meant to (the provider at the start); the ETA medians are kept per planned provider
  note        TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (idea_id, job_id, attempt, step)
);
CREATE INDEX build_steps_updated ON build_steps(updated_at);
CREATE INDEX build_steps_finished ON build_steps(step, state, ended_at);
