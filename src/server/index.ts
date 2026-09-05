import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../index.js";
import type { Env, LinearAuthMode } from "../env.js";
import type { BridgeExecutionContext } from "../runtime.js";
import { SqliteD1 } from "./sqlite.js";
import { startBot } from "./bot.js";

/**
 * Runs the same Worker on a plain Node server. The fetch handler is reused
 * verbatim, so routing, token checks and loop prevention cannot drift between
 * the two deployments.
 */

const DEFAULT_PORT = 5055;
const DEFAULT_HOST = "127.0.0.1";
const PRUNE_INTERVAL_MS = 86_400_000;
const REQUEST_BODY_LIMIT_BYTES = 2_000_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

function loadMigrations(directory: string): { name: string; sql: string }[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(directory, name), "utf8") }));
}

function buildEnv(db: SqliteD1): Env {
  return {
    DB: db,
    MATRIX_HOMESERVER_URL: required("MATRIX_HOMESERVER_URL"),
    MATRIX_BOT_USER_ID: required("MATRIX_BOT_USER_ID"),
    MATRIX_ALLOWED_ROOMS: process.env.MATRIX_ALLOWED_ROOMS ?? "",
    COMMAND_PREFIX: process.env.COMMAND_PREFIX ?? "!linear",
    MATRIX_BOT_NAME: process.env.MATRIX_BOT_NAME,
    MATRIX_HOMESERVER_NAME: process.env.MATRIX_HOMESERVER_NAME,
    MATRIX_ICON_URL: process.env.MATRIX_ICON_URL,
    LINEAR_TEAM_ID: required("LINEAR_TEAM_ID"),
    LINEAR_AUTH_MODE: (process.env.LINEAR_AUTH_MODE ?? "api_key") as LinearAuthMode,
    LINEAR_API_URL: process.env.LINEAR_API_URL,
    MATRIX_AS_TOKEN: required("MATRIX_AS_TOKEN"),
    MATRIX_BOT_ACCESS_TOKEN: required("MATRIX_BOT_ACCESS_TOKEN"),
    BOT_STORAGE_PATH: process.env.BOT_STORAGE_PATH,
    CRYPTO_STORAGE_PATH: process.env.CRYPTO_STORAGE_PATH,
    MATRIX_HS_TOKEN: required("MATRIX_HS_TOKEN"),
    LINEAR_TOKEN: required("LINEAR_TOKEN"),
    LINEAR_WEBHOOK_SECRET: required("LINEAR_WEBHOOK_SECRET"),
  };
}

async function readBody(incoming: IncomingMessage): Promise<Buffer | undefined> {
  if (incoming.method === "GET" || incoming.method === "HEAD") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > REQUEST_BODY_LIMIT_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

function toRequest(incoming: IncomingMessage, body: Buffer | undefined): Request {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  return new Request(url, {
    method: incoming.method ?? "GET",
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
}

async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());

  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(body);
}

const db = new SqliteD1(process.env.DATABASE_PATH ?? "./linear-matrix-bridge.db");
const applied = db.applyMigrations(loadMigrations(process.env.MIGRATIONS_DIR ?? "./migrations"));
if (applied.length > 0) {
  console.log(`Applied migrations: ${applied.join(", ")}`);
}

const env = buildEnv(db);

// The Worker's cron trigger has no equivalent here, so the prune runs on a timer.
const prune = setInterval(() => {
  worker.scheduled({}, env).catch((error: unknown) => console.error("Prune failed", error));
}, PRUNE_INTERVAL_MS);
prune.unref();

const ctx: BridgeExecutionContext = {
  waitUntil(promise: Promise<unknown>) {
    promise.catch((error: unknown) => console.error("Background task failed", error));
  },
};

const server = createServer((incoming, outgoing) => {
  void (async () => {
    try {
      const body = await readBody(incoming);
      const response = await worker.fetch(toRequest(incoming, body), env, ctx);
      await send(response, outgoing);
    } catch (error) {
      console.error(`${incoming.method} ${incoming.url} failed`, error);
      outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Internal error" }));
    }
  })();
});

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const host = process.env.HOST ?? DEFAULT_HOST;

server.listen(port, host, () => {
  console.log(`linear-matrix-bridge listening on http://${host}:${port}`);
});

// Matrix arrives over sync, not over the appservice endpoints, so the bridge can
// decrypt. The HTTP server here is only Linear's webhook and the health check.
env.gateway = await startBot(env);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
