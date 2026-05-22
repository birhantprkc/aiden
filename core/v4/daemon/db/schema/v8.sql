-- v4.9.0 Slice 4 — daemon_incarnations: one row per daemon process boot.
--
-- The daemon's persistent identity lives in <aidenRoot>/daemon/daemon_id;
-- each boot gets a fresh incarnation_id (inc_<uuidv7>). The pair is what
-- callers correlate trace/run records against. Distinct from the v1
-- `daemon_instances` table (which uses random-UUID instance_id and
-- pre-dates the identity substrate); v4.9 keeps both alive so existing
-- recovery code (`evaluateBootState`, `reclaimStuckRuns`) keeps working
-- unchanged.
CREATE TABLE IF NOT EXISTS daemon_incarnations (
  incarnation_id  TEXT    PRIMARY KEY,
  daemon_id       TEXT    NOT NULL,
  pid             INTEGER NOT NULL,
  started_at      TEXT    NOT NULL,   -- ISO 8601
  ended_at        TEXT,                -- ISO 8601 or NULL
  exit_reason     TEXT,                -- 'clean' | 'sigterm' | 'sigint' | 'crash' | 'unknown'
  exit_code       INTEGER,
  aiden_version   TEXT,
  node_version    TEXT
);
CREATE INDEX IF NOT EXISTS idx_incarnations_daemon
  ON daemon_incarnations(daemon_id, started_at DESC);
