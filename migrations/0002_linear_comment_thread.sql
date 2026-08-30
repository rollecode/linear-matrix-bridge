-- The first comment the bridge creates for a link becomes the parent of every
-- later one, so a Matrix thread maps onto a single Linear comment thread
-- rather than a pile of top-level comments.

ALTER TABLE links ADD COLUMN linear_parent_comment_id TEXT;
