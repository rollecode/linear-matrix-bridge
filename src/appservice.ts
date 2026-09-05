import {
  DERIVED_TITLE_MAX_LENGTH,
  MAX_EVENTS_PER_TRANSACTION,
  MESSAGE_EVENT_TYPE,
  REPLACE_REL_TYPE,
  THREAD_REL_TYPE,
} from "./constants.js";
import {
  createLink,
  findLinkByThread,
  isSentEvent,
  recordSentComment,
  recordSentEvent,
  setLastEvent,
  setLinearParentComment,
} from "./db.js";
import { isRoomAllowed, type Env } from "./env.js";
import { LinearClient } from "./linear.js";
import { htmlToMarkdown, stripReplyFallback } from "./markdown.js";
import { HttpMatrixClient, type MatrixEvent, type MatrixGateway, type MatrixRelatesTo } from "./matrix.js";

const TEXT_MSGTYPES = new Set(["m.text", "m.notice", "m.emote"]);
const LINK_SUBCOMMAND = "link";

interface Bridge {
  env: Env;
  matrix: MatrixGateway;
  linear: LinearClient;
}

export async function handleTransaction(
  env: Env,
  events: MatrixEvent[],
  matrix: MatrixGateway = new HttpMatrixClient(env),
): Promise<void> {
  const bridge: Bridge = { env, matrix, linear: new LinearClient(env) };

  if (events.length > MAX_EVENTS_PER_TRANSACTION) {
    console.warn(
      `Transaction carried ${events.length} events; handling the first ${MAX_EVENTS_PER_TRANSACTION} and dropping the rest`,
    );
  }

  // One bad event must not fail the transaction. Synapse retries a failed
  // transaction under the same ID forever, so throwing here would wedge the
  // queue behind a message that will never succeed.
  for (const event of events.slice(0, MAX_EVENTS_PER_TRANSACTION)) {
    try {
      await handleEvent(bridge, event);
    } catch (error) {
      console.error(`Dropping event ${event.event_id} in ${event.room_id}`, error);
    }
  }
}

async function handleEvent(bridge: Bridge, event: MatrixEvent): Promise<void> {
  if (event.sender === bridge.env.MATRIX_BOT_USER_ID) {
    return;
  }
  if (!isRoomAllowed(bridge.env, event.room_id)) {
    return;
  }
  if (event.type === "m.room.member") {
    await acceptInvite(bridge, event);
    return;
  }
  if (event.type !== MESSAGE_EVENT_TYPE) {
    return;
  }
  if (await isSentEvent(bridge.env.DB, event.event_id)) {
    return;
  }

  await handleMessage(bridge, event);
}

async function acceptInvite(bridge: Bridge, event: MatrixEvent): Promise<void> {
  const membership = (event.content as { membership?: string }).membership;
  const target = (event as MatrixEvent & { state_key?: string }).state_key;

  if (membership !== "invite" || target !== bridge.env.MATRIX_BOT_USER_ID) {
    return;
  }

  await bridge.matrix.joinRoom(event.room_id);

  if (!bridge.matrix.supportsEncryption && (await bridge.matrix.isRoomEncrypted(event.room_id))) {
    const eventId = await bridge.matrix.sendNotice(
      event.room_id,
      "This room is end-to-end encrypted, and the bridge cannot read encrypted messages, so `!linear` will do nothing here. Use it in an unencrypted room.",
    );
    await recordSentEvent(bridge.env.DB, eventId);
  }
}

async function handleMessage(bridge: Bridge, event: MatrixEvent): Promise<void> {
  const relatesTo = event.content["m.relates_to"];

  // Edits arrive as a new event replacing an old one. Bridging them would
  // duplicate the comment, so they are deliberately ignored.
  if (relatesTo?.rel_type === REPLACE_REL_TYPE) {
    return;
  }

  const body = stripReplyFallback(event.content.body ?? "");
  const prefix = bridge.env.COMMAND_PREFIX;

  if (body === prefix || body.startsWith(`${prefix} `)) {
    await handleCommand(bridge, event, body.slice(prefix.length).trim());
    return;
  }

  const threadRootEventId = threadRootOf(relatesTo);
  if (!threadRootEventId) {
    return;
  }

  const link = await findLinkByThread(bridge.env.DB, event.room_id, threadRootEventId);
  if (!link) {
    return;
  }

  const text = messageText(event);
  if (!text) {
    return;
  }

  const authorName = await bridge.matrix.getDisplayName(event.sender);
  const commentBody = bridge.linear.attributesToApp ? text : `**${authorName}** on Matrix:\n\n${text}`;

  const commentId = await bridge.linear.createComment(
    link.linear_issue_id,
    commentBody,
    authorName,
    link.linear_parent_comment_id,
  );

  console.log(`Bridged a message from ${event.sender} to ${link.linear_issue_identifier} as comment ${commentId}`);

  // Linear will webhook this comment straight back at us; remember it so we drop it.
  await recordSentComment(bridge.env.DB, commentId);

  // The first one opens the Linear comment thread that the rest nest under.
  if (!link.linear_parent_comment_id) {
    await setLinearParentComment(bridge.env.DB, link.thread_root_event_id, commentId);
  }
  await setLastEvent(bridge.env.DB, link.thread_root_event_id, event.event_id);
}

async function handleCommand(bridge: Bridge, event: MatrixEvent, rest: string): Promise<void> {
  console.log(`Command from ${event.sender} in ${event.room_id}: ${bridge.env.COMMAND_PREFIX} ${rest}`);
  const relatesTo = event.content["m.relates_to"];
  const threadRootEventId = threadRootOf(relatesTo);

  if (threadRootEventId) {
    const existing = await findLinkByThread(bridge.env.DB, event.room_id, threadRootEventId);
    if (existing) {
      await reply(bridge, event.room_id, threadRootEventId, `This thread is already linked to ${existing.linear_issue_identifier}.`);
      return;
    }
  }

  if (rest === LINK_SUBCOMMAND || rest.startsWith(`${LINK_SUBCOMMAND} `)) {
    await linkExistingIssue(bridge, event, rest.slice(LINK_SUBCOMMAND.length).trim(), threadRootEventId);
    return;
  }

  await createIssueFromCommand(bridge, event, rest, threadRootEventId);
}

async function linkExistingIssue(
  bridge: Bridge,
  event: MatrixEvent,
  identifier: string,
  threadRootEventId: string | undefined,
): Promise<void> {
  const anchor = threadRootEventId ?? event.event_id;

  if (!identifier) {
    await reply(bridge, event.room_id, anchor, `Usage: \`${bridge.env.COMMAND_PREFIX} link ABC-123\``);
    return;
  }

  const issue = await bridge.linear.findIssueByIdentifier(identifier);
  if (!issue) {
    await reply(bridge, event.room_id, anchor, `No issue called ${identifier}.`);
    return;
  }

  const linked = await createLink(bridge.env.DB, {
    matrix_room_id: event.room_id,
    thread_root_event_id: anchor,
    linear_issue_id: issue.id,
    linear_issue_identifier: issue.identifier,
  });

  if (!linked) {
    await reply(bridge, event.room_id, anchor, `This thread is already linked to an issue.`);
    return;
  }

  console.log(`Linked ${issue.identifier} to thread ${anchor} in ${event.room_id}`);
  await reply(
    bridge,
    event.room_id,
    anchor,
    `Linked to **${issue.identifier}** ${issue.title}\n${issue.url}\n\nMessages posted in this thread from now on become comments. Anything said before the link is not bridged.`,
  );
}

async function createIssueFromCommand(
  bridge: Bridge,
  event: MatrixEvent,
  title: string,
  threadRootEventId: string | undefined,
): Promise<void> {
  const quotedEventId = plainReplyTargetOf(event.content["m.relates_to"]);
  let description: string | undefined;
  let anchor = threadRootEventId ?? event.event_id;

  if (quotedEventId) {
    const quoted = await bridge.matrix.getEvent(event.room_id, quotedEventId);
    description = messageText(quoted);
    anchor = quotedEventId;
  }

  const resolvedTitle = title || deriveTitle(description);
  if (!resolvedTitle) {
    await reply(
      bridge,
      event.room_id,
      anchor,
      `Usage: \`${bridge.env.COMMAND_PREFIX} <title>\`, or reply to a message with \`${bridge.env.COMMAND_PREFIX}\`.`,
    );
    return;
  }

  const issue = await bridge.linear.createIssue(bridge.env.LINEAR_TEAM_ID, resolvedTitle, description);

  const linked = await createLink(bridge.env.DB, {
    matrix_room_id: event.room_id,
    thread_root_event_id: anchor,
    linear_issue_id: issue.id,
    linear_issue_identifier: issue.identifier,
  });

  console.log(`Created ${issue.identifier} from ${event.room_id}, thread ${anchor}, linked=${linked}`);
  const note = linked ? "" : "\n\nThis thread was already linked, so the new issue is not bridged to it.";
  await reply(bridge, event.room_id, anchor, `Created **${issue.identifier}** ${issue.title}\n${issue.url}${note}`);
}

async function reply(bridge: Bridge, roomId: string, threadRootEventId: string, markdown: string): Promise<void> {
  const link = await findLinkByThread(bridge.env.DB, roomId, threadRootEventId);
  const latest = link?.last_event_id ?? threadRootEventId;

  const eventId = await bridge.matrix.sendThreadMessage(roomId, threadRootEventId, latest, markdown);

  await recordSentEvent(bridge.env.DB, eventId);
  if (link) {
    await setLastEvent(bridge.env.DB, threadRootEventId, eventId);
  }
}

function threadRootOf(relatesTo: MatrixRelatesTo | undefined): string | undefined {
  return relatesTo?.rel_type === THREAD_REL_TYPE ? relatesTo.event_id : undefined;
}

/** The target of a rich reply made outside a thread; inside a thread the root is the anchor instead. */
function plainReplyTargetOf(relatesTo: MatrixRelatesTo | undefined): string | undefined {
  if (relatesTo?.rel_type === THREAD_REL_TYPE) {
    return undefined;
  }

  return relatesTo?.["m.in_reply_to"]?.event_id;
}

function messageText(event: MatrixEvent): string {
  const { msgtype, body, formatted_body, filename } = event.content;

  if (msgtype && !TEXT_MSGTYPES.has(msgtype)) {
    return `_Attachment on Matrix: ${filename ?? body ?? "file"}_`;
  }

  if (formatted_body) {
    return htmlToMarkdown(formatted_body);
  }

  return stripReplyFallback(body ?? "").trim();
}

function deriveTitle(description: string | undefined): string {
  const firstLine = (description ?? "").split("\n").find((line) => line.trim().length > 0) ?? "";
  const title = firstLine.trim();

  return title.length > DERIVED_TITLE_MAX_LENGTH ? `${title.slice(0, DERIVED_TITLE_MAX_LENGTH - 1)}…` : title;
}
