import { env } from "cloudflare:test";
import { vi } from "vitest";
import { hmacSha256Hex } from "../src/crypto.js";
import type { Env } from "../src/env.js";

export const ROOM_ID = "!room:matrix.test";
export const THREAD_ROOT = "$thread-root";
export const ISSUE_ID = "issue-uuid";
export const ISSUE_IDENTIFIER = "MEM-42";
export const SENT_EVENT_ID = "$sent-by-bridge";

export const testEnv = env as unknown as Env;

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

export interface FetchStub {
  requests: RecordedRequest[];
  matrixSends: RecordedRequest[];
  linearCalls: RecordedRequest[];
  /** What `GET /event/{eventId}` resolves to, for the reply-to-a-message flow. */
  quotedEvent: unknown;
  /** Whether the room reports m.room.encryption state. */
  roomEncrypted: boolean;
}

/**
 * Replaces global fetch so no test touches a real homeserver or the Linear API.
 * Matrix sends resolve to a fixed event ID; Linear mutations resolve to canned data.
 */
export function stubFetch(): FetchStub {
  const stub: FetchStub = { requests: [], matrixSends: [], linearCalls: [], quotedEvent: null, roomEncrypted: false };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const recorded: RecordedRequest = { url, method, body };

      stub.requests.push(recorded);

      if (url.includes("/_matrix/client/v3/rooms/") && url.includes("/send/")) {
        stub.matrixSends.push(recorded);
        return Response.json({ event_id: SENT_EVENT_ID });
      }

      if (url.includes("/state/m.room.encryption")) {
        return stub.roomEncrypted
          ? Response.json({ algorithm: "m.megolm.v1.aes-sha2" })
          : Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
      }

      if (url.includes("/_matrix/client/v3/rooms/") && url.includes("/event/")) {
        return Response.json(stub.quotedEvent);
      }

      if (url.includes("/_matrix/client/v3/profile/")) {
        return Response.json({ displayname: "Test User" });
      }

      if (url.includes("api.linear.app")) {
        stub.linearCalls.push(recorded);
        return Response.json({ data: linearResponse(String((body as { query?: string })?.query ?? "")) });
      }

      return Response.json({});
    }),
  );

  return stub;
}

function linearResponse(query: string): unknown {
  if (query.includes("issueCreate")) {
    return {
      issueCreate: {
        success: true,
        issue: {
          id: ISSUE_ID,
          identifier: ISSUE_IDENTIFIER,
          title: "Fix the login bug",
          url: `https://linear.app/test/issue/${ISSUE_IDENTIFIER}`,
        },
      },
    };
  }

  if (query.includes("commentCreate")) {
    return { commentCreate: { success: true, comment: { id: "comment-uuid" } } };
  }

  return {
    issues: {
      nodes: [
        {
          id: ISSUE_ID,
          identifier: ISSUE_IDENTIFIER,
          title: "Fix the login bug",
          url: `https://linear.app/test/issue/${ISSUE_IDENTIFIER}`,
        },
      ],
    },
  };
}

/** Test storage is shared within a file, so each test starts from an empty database. */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM sent_comments"),
    env.DB.prepare("DELETE FROM sent_events"),
    env.DB.prepare("DELETE FROM processed_transactions"),
  ]);
}

export async function seedLink(lastEventId: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO links
     (matrix_room_id, thread_root_event_id, linear_issue_id, linear_issue_identifier, last_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(ROOM_ID, THREAD_ROOT, ISSUE_ID, ISSUE_IDENTIFIER, lastEventId, Date.now())
    .run();
}

export function threadedMessage(eventId: string, body: string, sender = "@sam:matrix.test") {
  return {
    type: "m.room.message",
    event_id: eventId,
    room_id: ROOM_ID,
    sender,
    content: {
      msgtype: "m.text",
      body,
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: THREAD_ROOT,
        is_falling_back: true,
        "m.in_reply_to": { event_id: THREAD_ROOT },
      },
    },
  };
}

export async function signedWebhookRequest(payload: unknown): Promise<Request> {
  const rawBody = JSON.stringify(payload);
  const signature = await hmacSha256Hex(testEnv.LINEAR_WEBHOOK_SECRET, rawBody);

  return new Request("https://bridge.test/linear/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Linear-Signature": signature },
    body: rawBody,
  });
}

export function transactionRequest(txnId: string, events: unknown[], token = "hs-token"): Request {
  return new Request(`https://bridge.test/_matrix/app/v1/transactions/${txnId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
}
