import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_ID,
  ISSUE_IDENTIFIER,
  resetDb,
  ROOM_ID,
  seedLink,
  stubFetch,
  testEnv,
  threadedMessage,
  THREAD_ROOT,
  transactionRequest,
  type FetchStub,
} from "./helpers.js";

describe("Matrix appservice transactions", () => {
  let fetchStub: FetchStub;

  beforeEach(async () => {
    fetchStub = stubFetch();
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a transaction carrying the wrong hs_token", async () => {
    const response = await SELF.fetch(transactionRequest("txn-1", [], "wrong-token"));

    expect(response.status).toBe(403);
  });

  it("processes a repeated transaction ID only once", async () => {
    await seedLink();
    const events = [threadedMessage("$msg-1", "This is broken again")];

    await SELF.fetch(transactionRequest("txn-repeat", events));
    await SELF.fetch(transactionRequest("txn-repeat", events));

    const comments = fetchStub.linearCalls.filter((call) =>
      String((call.body as { query: string }).query).includes("commentCreate"),
    );
    expect(comments).toHaveLength(1);
  });

  it("turns a message in a mapped thread into a Linear comment", async () => {
    await seedLink();

    await SELF.fetch(transactionRequest("txn-comment", [threadedMessage("$msg-2", "Still failing on staging")]));

    const comment = fetchStub.linearCalls.find((call) =>
      String((call.body as { query: string }).query).includes("commentCreate"),
    );
    const input = (comment!.body as { variables: { input: { issueId: string; body: string } } }).variables.input;

    expect(input.issueId).toBe(ISSUE_ID);
    expect(input.body).toContain("Still failing on staging");
    expect(input.body).toContain("Test User");
  });

  it("ignores messages in threads that are not mapped", async () => {
    await SELF.fetch(transactionRequest("txn-unmapped", [threadedMessage("$msg-3", "Chatter")]));

    expect(fetchStub.linearCalls).toHaveLength(0);
  });

  it("ignores the bridge's own messages", async () => {
    await seedLink();
    const own = threadedMessage("$msg-4", "Bridged text", testEnv.MATRIX_BOT_USER_ID);

    await SELF.fetch(transactionRequest("txn-own", [own]));

    expect(fetchStub.linearCalls).toHaveLength(0);
  });

  it("ignores edits", async () => {
    await seedLink();
    const edit = threadedMessage("$msg-5", "* corrected");
    edit.content["m.relates_to"] = { rel_type: "m.replace", event_id: "$msg-2" } as never;

    await SELF.fetch(transactionRequest("txn-edit", [edit]));

    expect(fetchStub.linearCalls).toHaveLength(0);
  });

  it("creates an issue and anchors the thread on the command event", async () => {
    const command = {
      type: "m.room.message",
      event_id: "$cmd-1",
      room_id: ROOM_ID,
      sender: "@sam:matrix.test",
      content: { msgtype: "m.text", body: "!linear Fix the login bug" },
    };

    await SELF.fetch(transactionRequest("txn-create", [command]));

    const created = fetchStub.linearCalls.find((call) =>
      String((call.body as { query: string }).query).includes("issueCreate"),
    );
    expect((created!.body as { variables: { input: { title: string } } }).variables.input.title).toBe("Fix the login bug");

    const link = await testEnv.DB.prepare("SELECT * FROM links WHERE thread_root_event_id = ?")
      .bind("$cmd-1")
      .first<{ linear_issue_identifier: string }>();
    expect(link?.linear_issue_identifier).toBe(ISSUE_IDENTIFIER);

    const reply = fetchStub.matrixSends[0]!.body as {
      body: string;
      "m.relates_to": { event_id: string };
    };
    expect(reply["m.relates_to"].event_id).toBe("$cmd-1");
    expect(reply.body).toContain(ISSUE_IDENTIFIER);
  });

  it("uses the replied-to message as the description and as the anchor", async () => {
    fetchStub.quotedEvent = {
      type: "m.room.message",
      event_id: "$original",
      room_id: ROOM_ID,
      sender: "@robin:matrix.test",
      content: { msgtype: "m.text", body: "The login page 500s on submit" },
    };

    const command = {
      type: "m.room.message",
      event_id: "$cmd-2",
      room_id: ROOM_ID,
      sender: "@sam:matrix.test",
      content: {
        msgtype: "m.text",
        body: "!linear",
        "m.relates_to": { "m.in_reply_to": { event_id: "$original" } },
      },
    };

    await SELF.fetch(transactionRequest("txn-reply", [command]));

    const created = fetchStub.linearCalls.find((call) =>
      String((call.body as { query: string }).query).includes("issueCreate"),
    );
    const input = (created!.body as { variables: { input: { title: string; description: string } } }).variables.input;
    expect(input.title).toBe("The login page 500s on submit");
    expect(input.description).toBe("The login page 500s on submit");

    const link = await testEnv.DB.prepare("SELECT * FROM links WHERE thread_root_event_id = ?")
      .bind("$original")
      .first();
    expect(link).not.toBeNull();
  });

  it("links an existing issue to the current thread", async () => {
    const command = {
      type: "m.room.message",
      event_id: THREAD_ROOT,
      room_id: ROOM_ID,
      sender: "@sam:matrix.test",
      content: { msgtype: "m.text", body: `!linear link ${ISSUE_IDENTIFIER}` },
    };

    await SELF.fetch(transactionRequest("txn-link", [command]));

    const link = await testEnv.DB.prepare("SELECT * FROM links WHERE thread_root_event_id = ?")
      .bind(THREAD_ROOT)
      .first<{ linear_issue_id: string }>();
    expect(link?.linear_issue_id).toBe(ISSUE_ID);
  });
});
