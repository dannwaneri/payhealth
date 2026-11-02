-- One row per PayPal webhook event. PayPal event id is the primary key,
-- so a redelivered event is ignored (idempotent insert).
CREATE TABLE events (
  id            TEXT PRIMARY KEY,          -- PayPal event id (WH-...)
  event_type    TEXT NOT NULL,             -- e.g. CUSTOMER.DISPUTE.CREATED
  resource_type TEXT,
  resource_id   TEXT,                      -- dispute id, capture id, etc.
  summary       TEXT,                      -- PayPal's own summary line
  payload       TEXT NOT NULL,             -- raw body as received
  verified      INTEGER NOT NULL DEFAULT 0,-- 1 = PayPal said SUCCESS
  verify_status TEXT,                      -- SUCCESS / FAILURE / ERROR:<msg>
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Filled by the agent (task 4)
  explanation   TEXT,
  risk_score    INTEGER,                   -- 0-100
  risk_reason   TEXT,
  analyzed_at   TEXT
);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_resource ON events(resource_id);

-- Evidence vault: facts the merchant can prove.
CREATE TABLE evidence (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,            -- tracking / receipt / policy / communication / other
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  order_id       TEXT,
  transaction_id TEXT,
  carrier        TEXT,
  tracking_number TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_evidence_txn ON evidence(transaction_id);

-- Agent drafts for dispute responses. A human must approve before submit.
CREATE TABLE drafts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id      TEXT NOT NULL,
  event_id        TEXT REFERENCES events(id),
  status          TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected / submitted / failed
  draft_json      TEXT NOT NULL,            -- evidence payload the agent proposes
  rationale       TEXT,                     -- why the agent picked this evidence
  model           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at      TEXT,
  decided_by      TEXT,
  submitted_at    TEXT,
  submit_response TEXT
);
CREATE INDEX idx_drafts_dispute ON drafts(dispute_id);
CREATE INDEX idx_drafts_status ON drafts(status);
