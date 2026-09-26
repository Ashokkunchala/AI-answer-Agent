-- Per-turn quality signals used for coaching and analytics.
CREATE TABLE IF NOT EXISTS interview_quality (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  overall_score INTEGER NOT NULL DEFAULT 0,
  relevance_score INTEGER NOT NULL DEFAULT 0,
  clarity_score INTEGER NOT NULL DEFAULT 0,
  completeness_score INTEGER NOT NULL DEFAULT 0,
  grounding_score INTEGER NOT NULL DEFAULT 0,
  guard_flags_json TEXT NOT NULL DEFAULT '[]',
  followups_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_interview_quality_session ON interview_quality(session_id, created_at);
