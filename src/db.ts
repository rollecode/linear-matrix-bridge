import { DEDUPE_RETENTION_DAYS, MS_PER_DAY } from "./constants.js";
import type { BridgeDatabase } from "./runtime.js";

export interface Link {
  matrix_room_id: string;
  thread_root_event_id: string;
  linear_issue_id: string;
  linear_issue_identifier: string;
  last_event_id: string | null;
  linear_parent_comment_id: string | null;
  created_at: number;
}

export async function claimTransaction(db: BridgeDatabase, txnId: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO processed_transactions (txn_id, created_at) VALUES (?, ?)")
    .bind(txnId, Date.now())
    .run();

  return result.meta.changes > 0;
}

/** Undo a claim so the homeserver's retry of the same transaction ID is processed rather than skipped. */
export async function releaseTransaction(db: BridgeDatabase, txnId: string): Promise<void> {
  await db.prepare("DELETE FROM processed_transactions WHERE txn_id = ?").bind(txnId).run();
}

export async function findLinkByThread(db: BridgeDatabase, roomId: string, threadRootEventId: string): Promise<Link | null> {
  return db
    .prepare("SELECT * FROM links WHERE matrix_room_id = ? AND thread_root_event_id = ?")
    .bind(roomId, threadRootEventId)
    .first<Link>();
}

/** One issue can back several threads, so Linear-side events fan out to all of them. */
export async function findLinksByIssue(db: BridgeDatabase, linearIssueId: string): Promise<Link[]> {
  const rows = await db
    .prepare("SELECT * FROM links WHERE linear_issue_id = ? ORDER BY created_at")
    .bind(linearIssueId)
    .all<Link>();

  return rows.results;
}

/** Returns false when that thread is already linked to something. */
export async function createLink(
  db: BridgeDatabase,
  link: Omit<Link, "created_at" | "last_event_id" | "linear_parent_comment_id">,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO links
       (matrix_room_id, thread_root_event_id, linear_issue_id, linear_issue_identifier, last_event_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      link.matrix_room_id,
      link.thread_root_event_id,
      link.linear_issue_id,
      link.linear_issue_identifier,
      Date.now(),
    )
    .run();

  return result.meta.changes > 0;
}

/** The Linear comment every later bridged comment nests under, so one Matrix thread is one Linear thread. */
export async function setLinearParentComment(
  db: BridgeDatabase,
  threadRootEventId: string,
  commentId: string,
): Promise<void> {
  await db
    .prepare("UPDATE links SET linear_parent_comment_id = ? WHERE thread_root_event_id = ? AND linear_parent_comment_id IS NULL")
    .bind(commentId, threadRootEventId)
    .run();
}

/** Tracked so threaded replies can fall back to the newest event in the thread, as MSC3440 asks. */
export async function setLastEvent(db: BridgeDatabase, threadRootEventId: string, eventId: string): Promise<void> {
  await db
    .prepare("UPDATE links SET last_event_id = ? WHERE thread_root_event_id = ?")
    .bind(eventId, threadRootEventId)
    .run();
}

export async function recordSentComment(db: BridgeDatabase, linearCommentId: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO sent_comments (linear_comment_id, created_at) VALUES (?, ?)")
    .bind(linearCommentId, Date.now())
    .run();
}

export async function isSentComment(db: BridgeDatabase, linearCommentId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM sent_comments WHERE linear_comment_id = ?")
    .bind(linearCommentId)
    .first<{ hit: number }>();

  return row !== null;
}

export async function recordSentEvent(db: BridgeDatabase, matrixEventId: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO sent_events (matrix_event_id, created_at) VALUES (?, ?)")
    .bind(matrixEventId, Date.now())
    .run();
}

export async function isSentEvent(db: BridgeDatabase, matrixEventId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM sent_events WHERE matrix_event_id = ?")
    .bind(matrixEventId)
    .first<{ hit: number }>();

  return row !== null;
}

export async function pruneDedupeTables(db: BridgeDatabase, now: number = Date.now()): Promise<void> {
  const cutoff = now - DEDUPE_RETENTION_DAYS * MS_PER_DAY;

  await db.batch([
    db.prepare("DELETE FROM sent_comments WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM sent_events WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM processed_transactions WHERE created_at < ?").bind(cutoff),
  ]);
}
