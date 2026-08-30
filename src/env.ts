import type { BridgeDatabase } from "./runtime.js";

export type LinearAuthMode = "api_key" | "oauth";

export interface Env {
  DB: BridgeDatabase;

  MATRIX_HOMESERVER_URL: string;
  /** Full MXID of the bridge's own user, built from `sender_localpart` in registration.yaml. */
  MATRIX_BOT_USER_ID: string;
  /** Comma-separated room IDs the bridge acts in. Empty means every room it is invited to. */
  MATRIX_ALLOWED_ROOMS: string;
  COMMAND_PREFIX: string;

  LINEAR_TEAM_ID: string;
  LINEAR_AUTH_MODE: LinearAuthMode;
  LINEAR_API_URL?: string;

  MATRIX_AS_TOKEN: string;
  MATRIX_HS_TOKEN: string;
  LINEAR_TOKEN: string;
  LINEAR_WEBHOOK_SECRET: string;
}

export function allowedRooms(env: Env): Set<string> {
  return new Set(
    (env.MATRIX_ALLOWED_ROOMS ?? "")
      .split(",")
      .map((room) => room.trim())
      .filter((room) => room.length > 0),
  );
}

export function isRoomAllowed(env: Env, roomId: string): boolean {
  const rooms = allowedRooms(env);
  return rooms.size === 0 || rooms.has(roomId);
}
