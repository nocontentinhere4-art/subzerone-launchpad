-- Help / support (src/support.js, 2026-10-12). Anyone with a problem (launch, wallet, dev buy, site, X, anything) writes
-- a report from the city's Help button or from a launch error; the owner reads it on /admin#support and the AI operator
-- through the bearer-token inbox (GET /api/support/inbox). Signed-in reports carry the wallet; every report also gets a
-- random read token (only its sha256 is stored) so an anonymous author can read the replies.
CREATE TABLE support_tickets (
  id                   TEXT PRIMARY KEY,                -- sup_…
  wallet               TEXT,                            -- the signed-in wallet, or NULL (anonymous)
  token_hash           TEXT NOT NULL UNIQUE,            -- sha256 of the author's read token
  ip_hash              TEXT NOT NULL,                   -- HMAC of the IP with a server salt (rate limits only)
  category             TEXT NOT NULL CHECK (category IN ('launch','wallet','devbuy','site','x','other')),
  source               TEXT NOT NULL DEFAULT 'help',    -- help | stepper | launch_error | devbuy_error
  message              TEXT NOT NULL,
  contact              TEXT,                            -- optional X handle or Telegram
  project_slug         TEXT,
  client_context_json  TEXT,                            -- NULL when the author unticked "include"
  server_context_json  TEXT NOT NULL,                   -- the DB state the server attached (launch intents, jobs)
  redacted             INTEGER NOT NULL DEFAULT 0,      -- 1: something that looked like a secret was removed
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','answered','closed')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX support_tickets_status ON support_tickets(status, created_at);
CREATE INDEX support_tickets_wallet ON support_tickets(wallet, created_at);
CREATE INDEX support_tickets_ip ON support_tickets(ip_hash, created_at);
CREATE INDEX support_tickets_updated ON support_tickets(updated_at);

CREATE TABLE support_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   TEXT NOT NULL REFERENCES support_tickets(id),
  author      TEXT NOT NULL,                            -- 'operator' | 'admin:<wallet>'
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX support_replies_ticket ON support_replies(ticket_id, id);
