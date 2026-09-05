import {
  MatrixClient as BotSdkClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
  type RustSdkCryptoStoreType,
} from "matrix-bot-sdk";
import { handleTransaction } from "../appservice.js";
import type { Env } from "../env.js";
import {
  noticeContent,
  threadedContent,
  type MatrixEvent,
  type MatrixGateway,
  type ThreadHistory,
} from "../matrix.js";

/**
 * `RustSdkCryptoStoreType.Sqlite`, inlined because it is an ambient const enum
 * and `verbatimModuleSyntax` refuses to read the value of one.
 */
const SQLITE_CRYPTO_STORE = 0 as RustSdkCryptoStoreType;

/**
 * The bridge as an ordinary Matrix user with a device, so it can decrypt.
 * An application service has no device and therefore no megolm keys, which is
 * why the appservice transport is blind in encrypted rooms.
 */
export class BotMatrixGateway implements MatrixGateway {
  readonly supportsEncryption = true;

  private readonly displayNames = new Map<string, string>();

  constructor(private readonly client: BotSdkClient) {}

  async getEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    // The SDK decrypts this for us when the room is encrypted.
    return (await this.client.getEvent(roomId, eventId)) as MatrixEvent;
  }

  async getDisplayName(userId: string): Promise<string> {
    const cached = this.displayNames.get(userId);
    if (cached !== undefined) {
      return cached;
    }

    const fallback = userId.replace(/^@/, "").split(":")[0] ?? userId;
    let name = fallback;

    try {
      const profile = (await this.client.getUserProfile(userId)) as { displayname?: string };
      name = profile.displayname?.trim() || fallback;
    } catch {
      // Users who never set a profile are normal.
    }

    this.displayNames.set(userId, name);
    return name;
  }

  async sendThreadMessage(
    roomId: string,
    threadRootEventId: string,
    latestEventId: string,
    markdown: string,
  ): Promise<string> {
    // sendMessage encrypts by itself when the room is encrypted.
    return this.client.sendMessage(roomId, threadedContent(threadRootEventId, latestEventId, markdown));
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.client.joinRoom(roomId);
  }

  async isRoomEncrypted(roomId: string): Promise<boolean> {
    return this.client.crypto.isRoomEncrypted(roomId);
  }

  async sendNotice(roomId: string, markdown: string): Promise<string> {
    return this.client.sendMessage(roomId, noticeContent(markdown));
  }

  /**
   * Fetched by ID rather than straight from the relations chunk, because
   * `getEvent` is the path that decrypts. Anything sent before this device had
   * the room key stays unreadable and is only counted.
   */
  async fetchThreadMessages(roomId: string, threadRootEventId: string, limit: number): Promise<ThreadHistory> {
    const related = (await this.client.doRequest(
      "GET",
      `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(threadRootEventId)}/m.thread`,
      { limit },
    )) as { chunk: { event_id: string }[] };

    const ids = [threadRootEventId, ...[...related.chunk].reverse().map((event) => event.event_id)];
    const messages: MatrixEvent[] = [];
    let unreadable = 0;

    for (const id of ids) {
      try {
        const event = (await this.client.getEvent(roomId, id)) as MatrixEvent;
        if (event.type === "m.room.message") {
          messages.push({ ...event, room_id: roomId });
        }
      } catch {
        unreadable++;
      }
    }

    return { messages, unreadable };
  }
}

function toMatrixEvent(roomId: string, event: Record<string, unknown>): MatrixEvent {
  return { ...(event as unknown as MatrixEvent), room_id: roomId };
}

/**
 * With no stored sync token the SDK performs a full initial sync and emits every
 * event in it, which would replay old messages into Linear on first start. Seed
 * the token so the first run begins from now.
 */
async function seedSyncToken(env: Env, storage: SimpleFsStorageProvider): Promise<void> {
  if (storage.getSyncToken()) {
    return;
  }

  const response = await fetch(`${env.MATRIX_HOMESERVER_URL.replace(/\/+$/, "")}/_matrix/client/v3/sync?timeout=0`, {
    headers: { Authorization: `Bearer ${env.MATRIX_BOT_ACCESS_TOKEN}` },
  });

  if (!response.ok) {
    throw new Error(`Could not seed the sync token: ${response.status} ${await response.text()}`);
  }

  const { next_batch: nextBatch } = (await response.json()) as { next_batch: string };
  storage.setSyncToken(nextBatch);
  console.log("Seeded sync token; starting from now rather than replaying history");
}

export async function startBot(env: Env): Promise<BotMatrixGateway> {
  const storage = new SimpleFsStorageProvider(env.BOT_STORAGE_PATH ?? "./data/bot.json");
  const cryptoStorage = new RustSdkCryptoStorageProvider(
    env.CRYPTO_STORAGE_PATH ?? "./data/crypto",
    SQLITE_CRYPTO_STORE,
  );

  await seedSyncToken(env, storage);

  const client = new BotSdkClient(env.MATRIX_HOMESERVER_URL, env.MATRIX_BOT_ACCESS_TOKEN, storage, cryptoStorage);
  const gateway = new BotMatrixGateway(client);

  client.on("room.message", (roomId: string, event: Record<string, unknown>) => {
    void handleTransaction(env, [toMatrixEvent(roomId, event)], gateway).catch((error: unknown) =>
      console.error(`Handling message in ${roomId} failed`, error),
    );
  });

  client.on("room.invite", (roomId: string, event: Record<string, unknown>) => {
    void handleTransaction(env, [toMatrixEvent(roomId, { ...event, type: "m.room.member" })], gateway).catch(
      (error: unknown) => console.error(`Handling invite to ${roomId} failed`, error),
    );
  });

  // Loud, because a silent decryption failure looks exactly like an ignored message.
  client.on("room.failed_decryption", (roomId: string, event: { event_id?: string }, error: unknown) => {
    console.error(`Could not decrypt ${event?.event_id} in ${roomId}. The sender's client has not shared keys with this device.`, error);
  });

  await client.start();
  console.log(`Matrix bot syncing as ${env.MATRIX_BOT_USER_ID}, encryption enabled`);

  return gateway;
}
