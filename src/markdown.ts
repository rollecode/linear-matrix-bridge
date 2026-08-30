/**
 * Just enough Markdown and HTML for chat messages. Matrix carries HTML in
 * `formatted_body`, Linear stores Markdown, and neither side needs a full
 * parser to survive the round trip.
 */

// Control characters, so nothing a user can type collides with a placeholder.
const CODE_BLOCK_PLACEHOLDER = "\u0000";
const INLINE_CODE_PLACEHOLDER = "\u0001";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function markdownToHtml(markdown: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  let text = markdown.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/^\n+|\n+$/g, ""))}</code></pre>`);
    return `${CODE_BLOCK_PLACEHOLDER}${codeBlocks.length - 1}${CODE_BLOCK_PLACEHOLDER}`;
  });

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `${INLINE_CODE_PLACEHOLDER}${inlineCode.length - 1}${INLINE_CODE_PLACEHOLDER}`;
  });

  text = escapeHtml(text)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replaceAll("\n", "<br/>");

  text = text.replace(new RegExp(`${INLINE_CODE_PLACEHOLDER}(\\d+)${INLINE_CODE_PLACEHOLDER}`, "g"), (_m, index: string) =>
    inlineCode[Number(index)] ?? "",
  );

  return text.replace(new RegExp(`${CODE_BLOCK_PLACEHOLDER}(\\d+)${CODE_BLOCK_PLACEHOLDER}`, "g"), (_m, index: string) =>
    codeBlocks[Number(index)] ?? "",
  );
}

export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "")
    .replace(/<pre>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code: string) => `\n\`\`\`\n${code}\n\`\`\`\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<(del|s|strike)[^>]*>([\s\S]*?)<\/\1>/gi, "~~$2~~")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, quoted: string) =>
      `\n${quoted.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6])>/gi, "\n\n")
    .replace(/<\/(ul|ol|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeEntities(text).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Matrix clients prefix the plain-text body of a rich reply with quoted
 * fallback lines. They are noise once the message is a Linear comment.
 */
export function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith("> ")) {
    index++;
  }
  while (index < lines.length && lines[index]!.trim() === "") {
    index++;
  }

  return lines.slice(index).join("\n");
}
