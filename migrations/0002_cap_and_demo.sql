-- Daily cap on model calls. One row per UTC day.
CREATE TABLE ai_usage (
  day   TEXT PRIMARY KEY,                  -- YYYY-MM-DD (UTC)
  calls INTEGER NOT NULL DEFAULT 0
);

-- Where a draft came from: the model, or a saved draft used when the cap is reached.
ALTER TABLE drafts ADD COLUMN source TEXT NOT NULL DEFAULT 'model'; -- model / saved

-- Rows created by the demo-case button. The UI labels them so demo data
-- is never shown as a real PayPal event.
ALTER TABLE events ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evidence ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
