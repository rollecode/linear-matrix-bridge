import type { BridgeDatabase } from "./runtime.js";
import type { MatrixGateway } from "./matrix.js";

export type LinearAuthMode = "api_key" | "oauth";

export interface Env {
  DB: BridgeDatabase;
  /**
   * Live Matrix transport, injected by the server entrypoint. Absent on
   * Workers, where the appservice HTTP client is the only option.
   */
  gateway?: MatrixGateway;

  MATRIX_HOMESERVER_URL: string;
  /** Full MXID of the bridge's own user, built from `sender_localpart` in registration.yaml. */
  MATRIX_BOT_USER_ID: string;
  /** Comma-separated room IDs the bridge acts in. Empty means every room it is invited to. */
  MATRIX_ALLOWED_ROOMS: string;
  COMMAND_PREFIX: string;
  /** Shown as the attachment subtitle on Linear issues. */
  MATRIX_HOMESERVER_NAME?: string;
  /** Icon for the Linear attachment, so the thread shows a Matrix mark under Resources. */
  MATRIX_ICON_URL?: string;

  LINEAR_TEAM_ID: string;
  LINEAR_AUTH_MODE: LinearAuthMode;
  LINEAR_API_URL?: string;

  MATRIX_AS_TOKEN: string;
  /** Device access token for the bot user. Server deployment only; must stay stable or the crypto store is invalidated. */
  MATRIX_BOT_ACCESS_TOKEN: string;
  BOT_STORAGE_PATH?: string;
  CRYPTO_STORAGE_PATH?: string;
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
