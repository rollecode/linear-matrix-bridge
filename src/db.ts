import { DEDUPE_RETENTION_DAYS, MS_PER_DAY } from "./constants.js";

export interface Link {
  matrix_room_id: string;
  thread_root_event_id: string;
  linear_issue_id: string;
  linear_issue_identifier: string;
  last_event_id: string | null;
  created_at: number;
}

export async function claimTransaction(db: D1Database, txnId: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO processed_transactions (txn_id, created_at) VALUES (?, ?)")
    .bind(txnId, Date.now())
    .run();

  return result.meta.changes > 0;
}

/** Undo a claim so the homeserver's retry of the same transaction ID is processed rather than skipped. */
export async function releaseTransaction(db: D1Database, txnId: string): Promise<void> {
  await db.prepare("DELETE FROM processed_transactions WHERE txn_id = ?").bind(txnId).run();
}

export async function findLinkByThread(db: D1Database, roomId: string, threadRootEventId: string): Promise<Link | null> {
  return db
    .prepare("SELECT * FROM links WHERE matrix_room_id = ? AND thread_root_event_id = ?")
    .bind(roomId, threadRootEventId)
    .first<Link>();
}

export async function findLinkByIssue(db: D1Database, linearIssueId: string): Promise<Link | null> {
  return db.prepare("SELECT * FROM links WHERE linear_issue_id = ?").bind(linearIssueId).first<Link>();
}

/** Returns false when the thread or the issue is already linked. */
export async function createLink(db: D1Database, link: Omit<Link, "created_at" | "last_event_id">): Promise<boolean> {
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

/** Tracked so threaded replies can fall back to the newest event in the thread, as MSC3440 asks. */
export async function setLastEvent(db: D1Database, threadRootEventId: string, eventId: string): Promise<void> {
  await db
    .prepare("UPDATE links SET last_event_id = ? WHERE thread_root_event_id = ?")
    .bind(eventId, threadRootEventId)
    .run();
}

export async function recordSentComment(db: D1Database, linearCommentId: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO sent_comments (linear_comment_id, created_at) VALUES (?, ?)")
    .bind(linearCommentId, Date.now())
    .run();
}

export async function isSentComment(db: D1Database, linearCommentId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM sent_comments WHERE linear_comment_id = ?")
    .bind(linearCommentId)
    .first<{ hit: number }>();

  return row !== null;
}

export async function recordSentEvent(db: D1Database, matrixEventId: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO sent_events (matrix_event_id, created_at) VALUES (?, ?)")
    .bind(matrixEventId, Date.now())
    .run();
}

export async function isSentEvent(db: D1Database, matrixEventId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM sent_events WHERE matrix_event_id = ?")
    .bind(matrixEventId)
    .first<{ hit: number }>();

  return row !== null;
}

export async function pruneDedupeTables(db: D1Database, now: number = Date.now()): Promise<void> {
  const cutoff = now - DEDUPE_RETENTION_DAYS * MS_PER_DAY;

  await db.batch([
    db.prepare("DELETE FROM sent_comments WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM sent_events WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM processed_transactions WHERE created_at < ?").bind(cutoff),
  ]);
}
