-- Thread to issue mapping, plus the dedupe tables that keep the bridge from
-- talking to itself. A Worker instance does not survive between requests, so
-- all of this has to be durable rather than in memory.

CREATE TABLE links (
  matrix_room_id TEXT NOT NULL,
  thread_root_event_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  linear_issue_identifier TEXT NOT NULL,
  last_event_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX links_thread_root_event_id ON links (thread_root_event_id);
CREATE UNIQUE INDEX links_linear_issue_id ON links (linear_issue_id);

CREATE TABLE sent_comments (
  linear_comment_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE sent_events (
  matrix_event_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE processed_transactions (
  txn_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE INDEX sent_comments_created_at ON sent_comments (created_at);
CREATE INDEX sent_events_created_at ON sent_events (created_at);
CREATE INDEX processed_transactions_created_at ON processed_transactions (created_at);
