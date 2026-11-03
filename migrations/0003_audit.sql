-- Audit trail for dispute drafts: who did what, when, and what was sent.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id TEXT NOT NULL,
  draft_id   INTEGER REFERENCES drafts(id),
  action     TEXT NOT NULL,   -- drafted / approved / rejected / sent / send_failed / not_sent_demo
  actor      TEXT NOT NULL,   -- person's name, or "PayHealth agent"
  detail     TEXT,            -- JSON: payload sent, PayPal response, or reason
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_dispute ON audit_log(dispute_id);

-- Free-text carrier name for carriers PayPal does not list (sent as carrier_name_other).
UPDATE evidence SET carrier = 'Sample Courier' WHERE is_demo = 1 AND carrier = 'OTHER';
