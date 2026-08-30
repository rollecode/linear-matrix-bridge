import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSentComment } from "../src/db.js";
import {
  ISSUE_ID,
  ISSUE_IDENTIFIER,
  resetDb,
  seedLink,
  signedWebhookRequest,
  stubFetch,
  testEnv,
  THREAD_ROOT,
  type FetchStub,
} from "./helpers.js";

const COMMENT_ID = "linear-comment-1";

function commentPayload(id = COMMENT_ID) {
  return {
    action: "create",
    type: "Comment",
    webhookTimestamp: Date.now(),
    actor: { name: "Robin" },
    data: { id, body: "Looks good to me", issueId: ISSUE_ID, user: { name: "Robin" } },
  };
}

describe("Linear webhook", () => {
  let fetchStub: FetchStub;

  beforeEach(async () => {
    fetchStub = stubFetch();
    await resetDb();
    await seedLink();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a request with a bad signature", async () => {
    const response = await SELF.fetch("https://bridge.test/linear/webhook", {
      method: "POST",
      headers: { "Linear-Signature": "deadbeef" },
      body: JSON.stringify(commentPayload()),
    });

    expect(response.status).toBe(403);
    expect(fetchStub.matrixSends).toHaveLength(0);
  });

  it("rejects a request with no signature at all", async () => {
    const response = await SELF.fetch("https://bridge.test/linear/webhook", {
      method: "POST",
      body: JSON.stringify(commentPayload()),
    });

    expect(response.status).toBe(403);
  });

  it("posts a genuine comment into the mapped thread", async () => {
    const response = await SELF.fetch(await signedWebhookRequest(commentPayload()));

    expect(response.status).toBe(200);
    expect(fetchStub.matrixSends).toHaveLength(1);

    const content = fetchStub.matrixSends[0]!.body as { body: string };
    expect(content.body).toContain("Robin");
    expect(content.body).toContain("Looks good to me");
  });

  it("does not loop a comment the bridge created itself", async () => {
    await recordSentComment(testEnv.DB, COMMENT_ID);

    const response = await SELF.fetch(await signedWebhookRequest(commentPayload()));

    expect(response.status).toBe(200);
    expect(fetchStub.matrixSends).toHaveLength(0);
  });

  it("rejects a stale webhook", async () => {
    const stale = { ...commentPayload(), webhookTimestamp: Date.now() - 120_000 };

    const response = await SELF.fetch(await signedWebhookRequest(stale));

    expect(response.status).toBe(403);
    expect(fetchStub.matrixSends).toHaveLength(0);
  });

  it("announces a state change but ignores other field updates", async () => {
    const stateChange = {
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "old-state" },
      data: { id: ISSUE_ID, identifier: ISSUE_IDENTIFIER, state: { name: "In Progress" } },
    };
    const titleChange = {
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now(),
      updatedFrom: { title: "Old title" },
      data: { id: ISSUE_ID, identifier: ISSUE_IDENTIFIER, title: "New title", state: { name: "In Progress" } },
    };

    await SELF.fetch(await signedWebhookRequest(stateChange));
    await SELF.fetch(await signedWebhookRequest(titleChange));

    expect(fetchStub.matrixSends).toHaveLength(1);
    expect((fetchStub.matrixSends[0]!.body as { body: string }).body).toContain("In Progress");
  });

  it("builds the thread relation the way MSC3440 describes", async () => {
    await SELF.fetch(await signedWebhookRequest(commentPayload()));

    const content = fetchStub.matrixSends[0]!.body as {
      "m.relates_to": { rel_type: string; event_id: string; is_falling_back: boolean; "m.in_reply_to": { event_id: string } };
    };

    expect(content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: THREAD_ROOT,
      is_falling_back: true,
      "m.in_reply_to": { event_id: THREAD_ROOT },
    });
  });

  it("points the reply fallback at the newest event once the thread has one", async () => {
    await testEnv.DB.prepare("UPDATE links SET last_event_id = ? WHERE thread_root_event_id = ?")
      .bind("$newest", THREAD_ROOT)
      .run();

    await SELF.fetch(await signedWebhookRequest(commentPayload("linear-comment-2")));

    const content = fetchStub.matrixSends[0]!.body as { "m.relates_to": { "m.in_reply_to": { event_id: string } } };
    expect(content["m.relates_to"]["m.in_reply_to"].event_id).toBe("$newest");
  });
});
