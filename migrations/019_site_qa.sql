-- SUB-01's QA gate for the coin sites (src/site-qa.js, docs/SITE-QA.md), 2026-10-12. One row per check of a built site
-- version: the static checks always, the browser render (1440×900 and 390×844) where a Chromium is available. A version
-- that fails is not set live (held = 1) unless nothing earlier is live; the author can publish it anyway (overridden).
-- (016–018 belong to other work: the child launch block, the art candidates, the build progress.)
CREATE TABLE site_qa (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  version       INTEGER NOT NULL,                 -- site_versions.version checked
  status        TEXT NOT NULL CHECK (status IN ('running','passed','failed','overridden')),
  browser       TEXT NOT NULL CHECK (browser IN ('pending','ran','skipped','error')),
  browser_note  TEXT,                             -- which browser and sizes, or why there was none ("no browser")
  issues        INTEGER NOT NULL DEFAULT 0,       -- what failed the gate
  warnings      INTEGER NOT NULL DEFAULT 0,       -- reported, not blocking (contrast under AA, third-party hosts)
  report_json   TEXT,                             -- {static, browser: {state, note, viewports, ms}, issues, warnings}
  shots_json    TEXT,                             -- [{file, viewport, kind, width}] on the volume: DATA_DIR/qa/<slug>/
  held          INTEGER NOT NULL DEFAULT 0,       -- 1: the previous live version was kept
  ticket_hash   TEXT,                             -- sha256 of the single-use header the QA browser sends; cleared when done
  ticket_until  INTEGER,
  runtime_ms    INTEGER,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  overridden_by TEXT,
  overridden_at INTEGER
);
CREATE INDEX site_qa_project ON site_qa(project_id, created_at);
CREATE INDEX site_qa_ticket ON site_qa(ticket_hash) WHERE ticket_hash IS NOT NULL;
