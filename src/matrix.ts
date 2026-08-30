import { HTML_FORMAT, MESSAGE_EVENT_TYPE, THREAD_REL_TYPE } from "./constants.js";
import type { Env } from "./env.js";
import { markdownToHtml } from "./markdown.js";

export interface MatrixEvent {
  type: string;
  event_id: string;
  room_id: string;
  sender: string;
  origin_server_ts?: number;
  content: MatrixMessageContent;
}

export interface MatrixRelatesTo {
  rel_type?: string;
  event_id?: string;
  is_falling_back?: boolean;
  "m.in_reply_to"?: { event_id: string };
}

export interface MatrixMessageContent {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  filename?: string;
  "m.relates_to"?: MatrixRelatesTo;
}

export class MatrixError extends Error {}

export class MatrixClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly displayNames = new Map<string, string>();

  constructor(env: Env) {
    this.baseUrl = env.MATRIX_HOMESERVER_URL.replace(/\/+$/, "");
    this.accessToken = env.MATRIX_AS_TOKEN;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw new MatrixError(`Matrix ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }

    return (await response.json()) as T;
  }

  async getEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    return this.request<MatrixEvent>(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    );
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {});
  }

  /**
   * The bridge has no megolm implementation, so in an encrypted room every
   * message arrives as ciphertext it cannot read. Worth knowing on join rather
   * than discovering through silence.
   */
  async isRoomEncrypted(roomId: string): Promise<boolean> {
    try {
      await this.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`);
      return true;
    } catch {
      return false;
    }
  }

  async sendNotice(roomId: string, markdown: string): Promise<string> {
    const content: MatrixMessageContent = {
      msgtype: "m.notice",
      body: markdown,
      format: HTML_FORMAT,
      formatted_body: markdownToHtml(markdown),
    };

    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${MESSAGE_EVENT_TYPE}/${crypto.randomUUID()}`;
    const sent = await this.request<{ event_id: string }>("PUT", path, content);

    return sent.event_id;
  }

  /** Falls back to the localpart, which is better in a Linear comment than an empty string. */
  async getDisplayName(userId: string): Promise<string> {
    const cached = this.displayNames.get(userId);
    if (cached !== undefined) {
      return cached;
    }

    const fallback = userId.replace(/^@/, "").split(":")[0] ?? userId;
    let name = fallback;

    try {
      const profile = await this.request<{ displayname?: string }>(
        "GET",
        `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
      );
      name = profile.displayname?.trim() || fallback;
    } catch {
      // A missing profile is normal for users who never set one.
    }

    this.displayNames.set(userId, name);
    return name;
  }

  /**
   * Sends a threaded message. `latestEventId` is the newest event we know of in
   * the thread: MSC3440 wants the reply fallback to point there, not at the root.
   */
  async sendThreadMessage(
    roomId: string,
    threadRootEventId: string,
    latestEventId: string,
    markdown: string,
  ): Promise<string> {
    const content: MatrixMessageContent = {
      msgtype: "m.text",
      body: markdown,
      format: HTML_FORMAT,
      formatted_body: markdownToHtml(markdown),
      "m.relates_to": {
        rel_type: THREAD_REL_TYPE,
        event_id: threadRootEventId,
        is_falling_back: true,
        "m.in_reply_to": { event_id: latestEventId },
      },
    };

    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${MESSAGE_EVENT_TYPE}/${crypto.randomUUID()}`;
    const sent = await this.request<{ event_id: string }>("PUT", path, content);

    return sent.event_id;
  }
}
