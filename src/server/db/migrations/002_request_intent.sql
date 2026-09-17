-- user_version 1 -> 2
-- Split request identity from the execution snapshot so a replay is still the
-- same paid operation after candidates or settings change.
-- Never edit 001_initial.sql; old rows keep a NULL identity hash.

ALTER TABLE ai_runs ADD COLUMN request_intent_hash TEXT;
ALTER TABLE ai_runs ADD COLUMN intent_hash_version INTEGER NOT NULL DEFAULT 1;
