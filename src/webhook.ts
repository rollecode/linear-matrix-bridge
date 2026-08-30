import { WEBHOOK_MAX_CLOCK_SKEW_MS } from "./constants.js";
import { findLinkByIssue, isSentComment, recordSentEvent, setLastEvent } from "./db.js";
import type { Env } from "./env.js";
import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";
import { MatrixClient } from "./matrix.js";

export const LINEAR_SIGNATURE_HEADER = "Linear-Signature";

export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: string;
  createdAt?: string;
  url?: string;
  webhookTimestamp?: number;
  actor?: { id?: string; type?: string; name?: string };
  updatedFrom?: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface CommentData {
  id: string;
  body?: string;
  issueId?: string;
  user?: { name?: string };
}

interface IssueData {
  id: string;
  identifier?: string;
  state?: { name?: string };
}

/** Verified against the raw body: re-stringifying parsed JSON changes the bytes and breaks the HMAC. */
export async function verifySignature(env: Env, rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) {
    return false;
  }

  const expected = await hmacSha256Hex(env.LINEAR_WEBHOOK_SECRET, rawBody);

  return timingSafeEqual(expected, signature.trim().toLowerCase());
}

export function isTimestampFresh(payload: LinearWebhookPayload, now: number = Date.now()): boolean {
  if (typeof payload.webhookTimestamp !== "number") {
    return true;
  }

  return Math.abs(now - payload.webhookTimestamp) <= WEBHOOK_MAX_CLOCK_SKEW_MS;
}

export async function handleWebhook(env: Env, payload: LinearWebhookPayload): Promise<void> {
  if (payload.type === "Comment" && payload.action === "create") {
    await handleCommentCreated(env, payload);
    return;
  }

  if (payload.type === "Issue" && payload.action === "update") {
    await handleIssueStateChange(env, payload);
  }
}

async function handleCommentCreated(env: Env, payload: LinearWebhookPayload): Promise<void> {
  const comment = payload.data as unknown as CommentData;

  if (!comment.issueId || !comment.body) {
    return;
  }

  // The bridge wrote this comment itself a moment ago; echoing it back would loop.
  if (await isSentComment(env.DB, comment.id)) {
    return;
  }

  const link = await findLinkByIssue(env.DB, comment.issueId);
  if (!link) {
    return;
  }

  const author = comment.user?.name ?? payload.actor?.name ?? "Linear";
  await postToThread(env, link.matrix_room_id, link.thread_root_event_id, link.last_event_id, `**${author}** on ${link.linear_issue_identifier}:\n\n${comment.body}`);
}

async function handleIssueStateChange(env: Env, payload: LinearWebhookPayload): Promise<void> {
  if (!("stateId" in (payload.updatedFrom ?? {}))) {
    return;
  }

  const issue = payload.data as unknown as IssueData;
  const stateName = issue.state?.name;
  if (!stateName) {
    return;
  }

  const link = await findLinkByIssue(env.DB, issue.id);
  if (!link) {
    return;
  }

  await postToThread(
    env,
    link.matrix_room_id,
    link.thread_root_event_id,
    link.last_event_id,
    `${link.linear_issue_identifier} moved to **${stateName}**`,
  );
}

async function postToThread(
  env: Env,
  roomId: string,
  threadRootEventId: string,
  lastEventId: string | null,
  markdown: string,
): Promise<void> {
  const matrix = new MatrixClient(env);
  const eventId = await matrix.sendThreadMessage(roomId, threadRootEventId, lastEventId ?? threadRootEventId, markdown);

  await recordSentEvent(env.DB, eventId);
  await setLastEvent(env.DB, threadRootEventId, eventId);
}
