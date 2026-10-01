/**
 * Markdown for summaries and details. The text comes from an explainer file (written by Claude or a
 * person), so it is never trusted: raw HTML is shown as text, images become their alt text, and links
 * only keep http(s), mailto and in-page targets.
 */
import { Marked, type Token, type Tokens } from "marked";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

const SAFE_HREF = /^(https?:|mailto:|#)/i;

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    image({ text }: Tokens.Image) {
      return escapeHtml(text);
    },
  },
  walkTokens(token: Token) {
    if (token.type === "link") {
      const link = token as Tokens.Link;
      if (!SAFE_HREF.test(link.href.trim())) link.href = "#";
    }
  },
});

/** Sanitised HTML for a markdown string. */
export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false });
}

/** Sanitised HTML for one line of markdown (a title): emphasis, code and links, no paragraph around it. */
export function renderInline(source: string): string {
  return marked.parseInline(source, { async: false });
}
