-- "What to do next" is stored apart from "What happened" (events.explanation).
ALTER TABLE events ADD COLUMN next_step TEXT;
