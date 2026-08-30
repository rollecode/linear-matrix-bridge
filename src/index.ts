import { handleTransaction } from "./appservice.js";
import {
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_NOT_FOUND,
  HTTP_OK,
  MATRIX_ERRCODE_FORBIDDEN,
  MATRIX_ERRCODE_NOT_FOUND,
  MATRIX_ERRCODE_UNRECOGNIZED,
} from "./constants.js";
import { claimTransaction, pruneDedupeTables, releaseTransaction } from "./db.js";
import type { Env } from "./env.js";
import type { MatrixEvent } from "./matrix.js";
import {
  handleWebhook,
  isTimestampFresh,
  LINEAR_SIGNATURE_HEADER,
  verifySignature,
  type LinearWebhookPayload,
} from "./webhook.js";

const TRANSACTION_PATH = /^\/_matrix\/app\/v1\/transactions\/(.+)$/;
const QUERY_PATH = /^\/_matrix\/app\/v1\/(users|rooms)\/.+$/;
const PING_PATH = "/_matrix/app/v1/ping";
const WEBHOOK_PATH = "/linear/webhook";
const HEALTH_PATH = "/health";

function json(body: unknown, status: number = HTTP_OK): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function matrixError(errcode: string, error: string, status: number): Response {
  return json({ errcode, error }, status);
}

/** The homeserver proves itself with the hs_token from registration.yaml. */
function isHomeserver(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");

  return header === `Bearer ${env.MATRIX_HS_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === HEALTH_PATH) {
      return json({ ok: true });
    }

    if (url.pathname === WEBHOOK_PATH) {
      return handleLinearRequest(request, env);
    }

    if (url.pathname === PING_PATH) {
      if (!isHomeserver(request, env)) {
        return matrixError(MATRIX_ERRCODE_FORBIDDEN, "Bad hs_token", HTTP_FORBIDDEN);
      }
      return json({});
    }

    const transaction = TRANSACTION_PATH.exec(url.pathname);
    if (transaction) {
      return handleTransactionRequest(request, env, ctx, decodeURIComponent(transaction[1]!));
    }

    // The bridge claims no user or alias namespace of its own.
    if (QUERY_PATH.test(url.pathname)) {
      return matrixError(MATRIX_ERRCODE_NOT_FOUND, "Not handled by this application service", HTTP_NOT_FOUND);
    }

    return matrixError(MATRIX_ERRCODE_UNRECOGNIZED, "Unknown endpoint", HTTP_NOT_FOUND);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await pruneDedupeTables(env.DB);
  },
};

async function handleTransactionRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  txnId: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return matrixError(MATRIX_ERRCODE_UNRECOGNIZED, "Use PUT", HTTP_METHOD_NOT_ALLOWED);
  }
  if (!isHomeserver(request, env)) {
    return matrixError(MATRIX_ERRCODE_FORBIDDEN, "Bad hs_token", HTTP_FORBIDDEN);
  }

  // Synapse retries a failed transaction with the same ID, so the claim is what
  // makes handling idempotent. It is released again if handling throws.
  if (!(await claimTransaction(env.DB, txnId))) {
    return json({});
  }

  const body = await request.json<{ events?: MatrixEvent[] }>().catch(() => ({ events: [] }));

  try {
    await handleTransaction(env, body.events ?? []);
  } catch (error) {
    ctx.waitUntil(releaseTransaction(env.DB, txnId));
    console.error(`Transaction ${txnId} failed`, error);
    throw error;
  }

  return json({});
}

async function handleLinearRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Use POST" }, HTTP_METHOD_NOT_ALLOWED);
  }

  const rawBody = await request.text();
  if (!(await verifySignature(env, rawBody, request.headers.get(LINEAR_SIGNATURE_HEADER)))) {
    return json({ error: "Bad signature" }, HTTP_FORBIDDEN);
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LinearWebhookPayload;
  } catch {
    return json({ error: "Malformed JSON" }, HTTP_BAD_REQUEST);
  }

  if (!isTimestampFresh(payload)) {
    return json({ error: "Stale webhook" }, HTTP_FORBIDDEN);
  }

  await handleWebhook(env, payload);

  return json({ ok: true });
}
