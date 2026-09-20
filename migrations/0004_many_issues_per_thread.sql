-- A thread often touches more than one issue. Uniqueness moves to the pair, so
-- the same issue cannot be linked twice to one thread, but several can.

DROP INDEX links_thread_root_event_id;

CREATE UNIQUE INDEX links_thread_issue ON links (thread_root_event_id, linear_issue_id);

CREATE INDEX links_thread_root_event_id ON links (thread_root_event_id);
