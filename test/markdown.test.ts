import { describe, expect, it } from "vitest";
import { htmlToMarkdown, markdownToHtml, stripReplyFallback } from "../src/markdown.js";

describe("markdownToHtml", () => {
  it("escapes HTML before formatting", () => {
    expect(markdownToHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("formats bold, italic, links and line breaks", () => {
    expect(markdownToHtml("**bold** and *italic*")).toBe("<strong>bold</strong> and <em>italic</em>");
    expect(markdownToHtml("[Linear](https://linear.app)")).toBe('<a href="https://linear.app">Linear</a>');
    expect(markdownToHtml("one\ntwo")).toBe("one<br/>two");
  });

  it("leaves code untouched by inline formatting", () => {
    expect(markdownToHtml("`a *b* c`")).toBe("<code>a *b* c</code>");
    expect(markdownToHtml("```\nconst x = 1 < 2;\n```")).toBe("<pre><code>const x = 1 &lt; 2;</code></pre>");
  });
});

describe("htmlToMarkdown", () => {
  it("converts the formatting Matrix clients send", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toBe("**bold**");
    expect(htmlToMarkdown('<a href="https://linear.app">Linear</a>')).toBe("[Linear](https://linear.app)");
    expect(htmlToMarkdown("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
    expect(htmlToMarkdown("<code>x &lt; y</code>")).toBe("`x < y`");
  });

  it("drops the rich reply fallback block", () => {
    const html = '<mx-reply><blockquote>quoted</blockquote></mx-reply>Actual message';

    expect(htmlToMarkdown(html)).toBe("Actual message");
  });
});

describe("stripReplyFallback", () => {
  it("removes the quoted lines a plain-text reply carries", () => {
    const body = "> <@robin:matrix.test> the original\n\nMy answer";

    expect(stripReplyFallback(body)).toBe("My answer");
  });

  it("leaves an ordinary message alone", () => {
    expect(stripReplyFallback("Just a message")).toBe("Just a message");
  });
});
