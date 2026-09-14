-- Feini Brain initial migration (user_version 0 -> 1).
-- Adapted from reference/sql/001_initial.sql. Executed inside the migration
-- transaction; PRAGMAs are set by the bootstrap in database.ts.
--
-- Never edit this file after release: add 002_*.sql instead.

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
INSERT INTO app_meta(key,value) VALUES ('dataset_revision','0');

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  capture_request_id TEXT NOT NULL UNIQUE,
  capture_request_hash TEXT NOT NULL,
  captured_text TEXT NOT NULL CHECK(length(captured_text) BETWEEN 1 AND 10000),
  raw_text TEXT NOT NULL CHECK(length(raw_text) BETWEEN 1 AND 10000),
  raw_version INTEGER NOT NULL DEFAULT 1 CHECK(raw_version >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  structured_base_raw_version INTEGER,
  title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 100),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 500),
  type TEXT NOT NULL DEFAULT 'idea' CHECK(type IN ('idea','concept','question','decision','quote','todo','observation')),
  keywords_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(keywords_json)),
  importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
  manual_fields_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(manual_fields_json)),
  status TEXT NOT NULL DEFAULT 'raw' CHECK(status IN ('raw','processing','done','error','stale')),
  last_run_id TEXT,
  error_code TEXT,
  error_message TEXT,
  source_type TEXT NOT NULL DEFAULT 'other' CHECK(source_type IN ('chatgpt','claude','web','book','myself','other')),
  source_ref TEXT CHECK(source_ref IS NULL OR length(source_ref) <= 2048),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_items_created ON knowledge_items(created_at DESC,id DESC);
CREATE INDEX idx_items_type_status ON knowledge_items(type,status,created_at DESC);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 32),
  normalized TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
  PRIMARY KEY(item_id,tag_id),
  UNIQUE(item_id,position)
) STRICT;
CREATE INDEX idx_item_tags_tag ON item_tags(tag_id,item_id);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('organize','mindmap','flow','connection_test')),
  subject_id TEXT,
  input_revision INTEGER,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','interrupted','conflict')),
  config_revision INTEGER NOT NULL,
  config_snapshot_json TEXT NOT NULL CHECK(json_valid(config_snapshot_json)),
  candidate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(candidate_ids_json)),
  result_ref TEXT,
  error_code TEXT,
  error_message TEXT,
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  prompt_version TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2),
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE UNIQUE INDEX idx_one_active_organize ON ai_runs(subject_id)
  WHERE kind = 'organize' AND state = 'running';
CREATE UNIQUE INDEX idx_one_global_running ON ai_runs((1)) WHERE state = 'running';
CREATE INDEX idx_runs_state_deadline ON ai_runs(state,deadline_at);

CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('similar_to','extends','supports','contradicts','causes','depends_on','example_of','related_to')),
  origin TEXT NOT NULL CHECK(origin IN ('ai','manual')),
  review_status TEXT NOT NULL CHECK(review_status IN ('suggested','accepted','rejected')),
  score REAL CHECK(score IS NULL OR (score >= 0 AND score <= 1)),
  reason TEXT NOT NULL DEFAULT '' CHECK(length(reason) <= 300),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
  source_raw_version INTEGER NOT NULL CHECK(source_raw_version >= 1),
  target_raw_version INTEGER NOT NULL CHECK(target_raw_version >= 1),
  run_id TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_id != target_id),
  CHECK(origin != 'manual' OR (review_status = 'accepted' AND score IS NULL)),
  CHECK(origin != 'ai' OR score IS NOT NULL),
  CHECK(relation_type NOT IN ('similar_to','contradicts','related_to') OR source_id < target_id),
  UNIQUE(source_id,target_id,relation_type)
) STRICT;
CREATE INDEX idx_relations_target ON relations(target_id,review_status);
CREATE INDEX idx_relations_source ON relations(source_id,review_status);

CREATE TABLE views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK(kind IN ('graph','mindmap','flow')),
  selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
  source_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(source_snapshot_json)),
  content_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(content_json)),
  content_hash TEXT,
  renderer_version TEXT NOT NULL,
  prompt_version TEXT,
  run_id TEXT REFERENCES ai_runs(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  generated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_views_kind_updated ON views(kind,updated_at DESC,id DESC);
