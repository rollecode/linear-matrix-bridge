import type { MatrixMessageContent } from "./matrix.js";

/**
 * The bot answers plain language, but only ever links, relinks or unlinks. The
 * action space is three verbs, so intent is a matter of pattern matching rather
 * than a model, and there is no code path that answers a question about anyone.
 */

const ISSUE_IDENTIFIER = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/;
const UNLINK_INTENT = /\b(unlink|detach|disconnect|wrong (one|issue|task)|not (this|that|it|right)|remove the link)\b/i;

/** Only an explicit mention counts; the display name alone appears in ordinary chatter. */
export function mentionsBot(content: MatrixMessageContent, botUserId: string): boolean {
  const mentions = (content as { "m.mentions"?: { user_ids?: string[] } })["m.mentions"];
  if (mentions?.user_ids?.includes(botUserId)) {
    return true;
  }

  if (content.formatted_body?.includes(`matrix.to/#/${botUserId}`)) {
    return true;
  }

  return (content.body ?? "").trimStart().startsWith(botUserId);
}

export function issueIdentifierIn(text: string): string | undefined {
  return ISSUE_IDENTIFIER.exec(text)?.[1]?.toUpperCase();
}

export function looksLikeUnlink(text: string): boolean {
  return UNLINK_INTENT.test(text);
}

/** Strips the mention itself so it does not dominate the search query. */
export function withoutMention(text: string, botUserId: string, botName: string): string {
  return text
    .replaceAll(botUserId, " ")
    .replace(new RegExp(`^\\s*${botName}\\b[:,]?`, "i"), "")
    .trim();
}
