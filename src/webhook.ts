import { WEBHOOK_MAX_CLOCK_SKEW_MS } from "./constants.js";
import { findLinksByIssue, isSentComment, recordSentEvent, setLastEvent, type Link } from "./db.js";
import type { Env } from "./env.js";
import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";
import { HttpMatrixClient, type MatrixGateway } from "./matrix.js";

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

export async function handleWebhook(
  env: Env,
  payload: LinearWebhookPayload,
  matrix: MatrixGateway = new HttpMatrixClient(env),
): Promise<void> {
  if (payload.type === "Comment" && payload.action === "create") {
    await handleCommentCreated(env, payload, matrix);
    return;
  }

  if (payload.type === "Issue" && payload.action === "update") {
    await handleIssueStateChange(env, payload, matrix);
  }
}

async function handleCommentCreated(env: Env, payload: LinearWebhookPayload, matrix: MatrixGateway): Promise<void> {
  const comment = payload.data as unknown as CommentData;

  if (!comment.issueId || !comment.body) {
    return;
  }

  // The bridge wrote this comment itself a moment ago; echoing it back would loop.
  if (await isSentComment(env.DB, comment.id)) {
    return;
  }

  const links = await findLinksByIssue(env.DB, comment.issueId);
  const author = comment.user?.name ?? payload.actor?.name ?? "Linear";

  for (const link of links) {
    await postToThread(env, matrix, link, `**${author}** posted on Linear (${link.linear_issue_identifier}):\n\n${comment.body}`);
  }
}

async function handleIssueStateChange(env: Env, payload: LinearWebhookPayload, matrix: MatrixGateway): Promise<void> {
  if (!("stateId" in (payload.updatedFrom ?? {}))) {
    return;
  }

  const issue = payload.data as unknown as IssueData;
  const stateName = issue.state?.name;
  if (!stateName) {
    return;
  }

  for (const link of await findLinksByIssue(env.DB, issue.id)) {
    await postToThread(env, matrix, link, `${link.linear_issue_identifier} moved to **${stateName}**`);
  }
}

/** One thread failing must not stop the others from getting the update. */
async function postToThread(env: Env, matrix: MatrixGateway, link: Link, markdown: string): Promise<void> {
  try {
    const eventId = await matrix.sendThreadMessage(
      link.matrix_room_id,
      link.thread_root_event_id,
      link.last_event_id ?? link.thread_root_event_id,
      markdown,
    );

    await recordSentEvent(env.DB, eventId);
    await setLastEvent(env.DB, link.thread_root_event_id, eventId);
  } catch (error) {
    console.error(`Could not post to thread ${link.thread_root_event_id} in ${link.matrix_room_id}`, error);
  }
}
