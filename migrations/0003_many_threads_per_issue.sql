-- A Linear issue can back several Matrix threads, in different rooms. A thread
-- still points at exactly one issue, so only that side stays unique.

DROP INDEX links_linear_issue_id;

CREATE INDEX links_linear_issue_id ON links (linear_issue_id);
