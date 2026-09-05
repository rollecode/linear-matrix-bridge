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
  mentionMessage,
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

  it("nests later comments under the first one, so Linear shows one thread", async () => {
    await seedLink();

    await SELF.fetch(transactionRequest("txn-first", [threadedMessage("$m1", "first message")]));
    await SELF.fetch(transactionRequest("txn-second", [threadedMessage("$m2", "second message")]));

    const comments = fetchStub.linearCalls
      .filter((c) => String((c.body as { query: string }).query).includes("commentCreate"))
      .map((c) => (c.body as { variables: { input: { body: string; parentId?: string } } }).variables.input);

    expect(comments).toHaveLength(2);
    expect(comments[0]!.parentId).toBeUndefined();
    expect(comments[1]!.parentId).toBe("comment-0");
  });

  it("joins a room when invited, and ignores invites meant for other users", async () => {
    const invite = (target: string) => ({
      type: "m.room.member",
      event_id: `$invite-${target}`,
      room_id: ROOM_ID,
      sender: "@someone:matrix.test",
      state_key: target,
      content: { membership: "invite" },
    });

    await SELF.fetch(
      transactionRequest("txn-invite", [invite(testEnv.MATRIX_BOT_USER_ID), invite("@other:matrix.test")]),
    );

    const joins = fetchStub.requests.filter((r) => r.url.includes("/join/"));
    expect(joins).toHaveLength(1);
    expect(decodeURIComponent(joins[0]!.url)).toContain(ROOM_ID);
  });

  it("warns on joining an encrypted room, where it can read nothing", async () => {
    fetchStub.roomEncrypted = true;

    await SELF.fetch(
      transactionRequest("txn-encrypted", [
        {
          type: "m.room.member",
          event_id: "$invite-enc",
          room_id: ROOM_ID,
          sender: "@someone:matrix.test",
          state_key: testEnv.MATRIX_BOT_USER_ID,
          content: { membership: "invite" },
        },
      ]),
    );

    expect(fetchStub.matrixSends).toHaveLength(1);
    expect((fetchStub.matrixSends[0]!.body as { body: string }).body).toContain("end-to-end encrypted");
  });

  it("stays quiet when joining an unencrypted room", async () => {
    await SELF.fetch(
      transactionRequest("txn-plain", [
        {
          type: "m.room.member",
          event_id: "$invite-plain",
          room_id: ROOM_ID,
          sender: "@someone:matrix.test",
          state_key: testEnv.MATRIX_BOT_USER_ID,
          content: { membership: "invite" },
        },
      ]),
    );

    expect(fetchStub.matrixSends).toHaveLength(0);
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

  it("keeps processing after one event fails, so the queue cannot wedge", async () => {
    await seedLink();
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The first message's Linear call blows up; the second must still land.
    let call = 0;
    const inner = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("api.linear.app") && call++ === 0) {
          throw new Error("Linear is down");
        }
        return inner(input, init);
      }),
    );

    const response = await SELF.fetch(
      transactionRequest("txn-partial", [
        threadedMessage("$bad", "first"),
        threadedMessage("$good", "second"),
      ]),
    );

    expect(response.status).toBe(200);
    const comments = fetchStub.linearCalls.filter((c) =>
      String((c.body as { query: string }).query).includes("commentCreate"),
    );
    expect(comments).toHaveLength(1);
    expect((comments[0]!.body as { variables: { input: { body: string } } }).variables.input.body).toContain("second");
  });

  it("copies what was already said in the thread onto the issue", async () => {
    const root = "$existing-root";
    fetchStub.quotedEvent = {
      type: "m.room.message",
      event_id: root,
      room_id: ROOM_ID,
      sender: "@robin:matrix.test",
      content: { msgtype: "m.text", body: "The login page 500s" },
    };
    fetchStub.threadRelations = [
      {
        type: "m.room.message",
        event_id: "$older-2",
        room_id: ROOM_ID,
        sender: "@sam:matrix.test",
        content: { msgtype: "m.text", body: "Still broken on staging" },
      },
    ];

    const command = {
      type: "m.room.message",
      event_id: "$cmd-backfill",
      room_id: ROOM_ID,
      sender: "@sam:matrix.test",
      content: {
        msgtype: "m.text",
        body: `!linear link ${ISSUE_IDENTIFIER}`,
        "m.relates_to": { rel_type: "m.thread", event_id: root, is_falling_back: true },
      },
    };

    await SELF.fetch(transactionRequest("txn-backfill", [command]));

    const bodies = fetchStub.linearCalls
      .filter((c) => String((c.body as { query: string }).query).includes("commentCreate"))
      .map((c) => (c.body as { variables: { input: { body: string; parentId?: string } } }).variables.input);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.body).toContain("The login page 500s");
    expect(bodies[1]!.body).toContain("Still broken on staging");
    expect(bodies[1]!.parentId).toBe("comment-0");
  });

  it("attaches the Matrix thread to the issue for the Resources section", async () => {
    const command = {
      type: "m.room.message",
      event_id: "$cmd-attach",
      room_id: ROOM_ID,
      sender: "@sam:matrix.test",
      content: { msgtype: "m.text", body: `!linear link ${ISSUE_IDENTIFIER}` },
    };

    await SELF.fetch(transactionRequest("txn-attach", [command]));

    const attach = fetchStub.linearCalls.find((c) =>
      String((c.body as { query: string }).query).includes("attachmentCreate"),
    );
    const input = (attach!.body as { variables: { input: { url: string; title: string } } }).variables.input;

    expect(input.title).toBe("Matrix thread");
    expect(input.url).toContain("https://matrix.to/#/");
    expect(input.url).toContain(encodeURIComponent(ROOM_ID));
    expect(input.url).toContain(encodeURIComponent("$cmd-attach"));
  });

  it("links from plain language when mentioned, with no command", async () => {
    await SELF.fetch(
      transactionRequest("txn-nl", [mentionMessage("$nl-1", "can you link this discussion to the right task?")]),
    );

    const searched = fetchStub.linearCalls.find((c) =>
      String((c.body as { query: string }).query).includes("semanticSearch"),
    );
    expect(searched).toBeDefined();

    const link = await testEnv.DB.prepare("SELECT * FROM links WHERE thread_root_event_id = ?")
      .bind("$nl-1")
      .first<{ linear_issue_identifier: string }>();
    expect(link?.linear_issue_identifier).toBe(ISSUE_IDENTIFIER);
    expect((fetchStub.matrixSends[0]!.body as { body: string }).body).toContain("MEM-99");
  });

  it("moves the link when a different issue is named", async () => {
    await seedLink(null, "$nl-2");

    await SELF.fetch(transactionRequest("txn-nl-move", [mentionMessage("$nl-move", "no, that is MEM-99", "$nl-2")]));

    const link = await testEnv.DB.prepare("SELECT * FROM links WHERE thread_root_event_id = ?")
      .bind("$nl-2")
      .first<{ linear_issue_identifier: string }>();
    expect(link?.linear_issue_identifier).toBe("MEM-42");
  });

  it("unlinks on a plain-language correction", async () => {
    await seedLink(null, "$nl-3");

    await SELF.fetch(transactionRequest("txn-nl-unlink", [mentionMessage("$nl-un", "wrong issue, unlink please", "$nl-3")]));

    const link = await testEnv.DB.prepare("SELECT * FROM links WHERE thread_root_event_id = ?").bind("$nl-3").first();
    expect(link).toBeNull();
    expect((fetchStub.matrixSends[0]!.body as { body: string }).body).toContain("Unlinked");
  });

  it("never runs a search for someone who is not mentioning it", async () => {
    await SELF.fetch(
      transactionRequest("txn-nomention", [threadedMessage("$chat", "what has rolle been doing lately?")]),
    );

    expect(fetchStub.linearCalls).toHaveLength(0);
  });

  it("searches on the thread, not on the sentence asking for a link", async () => {
    fetchStub.quotedEvent = {
      type: "m.room.message",
      event_id: "$topic-root",
      room_id: ROOM_ID,
      sender: "@robin:matrix.test",
      content: { msgtype: "m.text", body: "the deploy keeps timing out on staging" },
    };
    fetchStub.threadRelations = [];

    await SELF.fetch(
      transactionRequest("txn-query", [
        mentionMessage("$ask", "look for the task, I forget what this was about", "$topic-root"),
      ]),
    );

    const searched = fetchStub.linearCalls.find((c) =>
      String((c.body as { query: string }).query).includes("semanticSearch"),
    );
    const term = (searched!.body as { variables: { query: string } }).variables.query;

    expect(term).toContain("deploy keeps timing out");
    expect(term).not.toContain("I forget what this was about");
  });

  it("carries the earlier conversation across when the bot picks the issue itself", async () => {
    fetchStub.quotedEvent = {
      type: "m.room.message",
      event_id: "$half-hour",
      room_id: ROOM_ID,
      sender: "@robin:matrix.test",
      content: { msgtype: "m.text", body: "the deploy keeps timing out on staging" },
    };
    fetchStub.threadRelations = [
      {
        type: "m.room.message",
        event_id: "$half-hour-2",
        room_id: ROOM_ID,
        sender: "@sam:matrix.test",
        content: { msgtype: "m.text", body: "looks like the health check is too slow" },
      },
    ];

    await SELF.fetch(
      transactionRequest("txn-nl-backfill", [mentionMessage("$ask-b", "link this to whatever it is", "$half-hour")]),
    );

    const bodies = fetchStub.linearCalls
      .filter((c) => String((c.body as { query: string }).query).includes("commentCreate"))
      .map((c) => (c.body as { variables: { input: { body: string } } }).variables.input.body);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("deploy keeps timing out");
    expect(bodies[1]).toContain("health check is too slow");
    expect((fetchStub.matrixSends[0]!.body as { body: string }).body).toContain("Copied 2 earlier messages");
  });

  it("carries it across when a person names the issue in plain language", async () => {
    fetchStub.quotedEvent = {
      type: "m.room.message",
      event_id: "$named-root",
      room_id: ROOM_ID,
      sender: "@robin:matrix.test",
      content: { msgtype: "m.text", body: "the certificate expired overnight" },
    };
    fetchStub.threadRelations = [];

    await SELF.fetch(
      transactionRequest("txn-nl-named", [mentionMessage("$ask-n", `this is ${ISSUE_IDENTIFIER}`, "$named-root")]),
    );

    const bodies = fetchStub.linearCalls
      .filter((c) => String((c.body as { query: string }).query).includes("commentCreate"))
      .map((c) => (c.body as { variables: { input: { body: string } } }).variables.input.body);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("certificate expired overnight");
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
