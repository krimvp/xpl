import { describe, expect, it } from "vitest";
import { escapeHtml, renderInline, renderMarkdown } from "../src/markdown.js";

describe("renderMarkdown", () => {
  it("renders markdown", () => {
    const html = renderMarkdown("Some **bold** text and `code`.\n\n- one\n- two");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("shows raw HTML as text instead of passing it on", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\nplain <b>bold</b>',
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<b>/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("keeps http(s), mailto and in-page links, and neutralises the rest", () => {
    const html = renderMarkdown(
      "[a](https://example.com) [b](mailto:x@example.com) [c](#top) [d](javascript:alert(1)) [e](data:text/html;base64,AAAA) [f](JaVaScRiPt:alert(1))",
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:x@example.com"');
    expect(html).toContain('href="#top"');
    expect(html.match(/href="#"/g)).toHaveLength(3);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/data:text/i);
  });

  it("replaces images by their alt text", () => {
    const html = renderMarkdown("![diagram](https://example.com/x.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("diagram");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("renderInline (step titles)", () => {
  it("renders code and emphasis without a paragraph, and is sanitised like the rest", () => {
    expect(renderInline("Fix 1: drop `q=0` **first**")).toBe(
      "Fix 1: drop <code>q=0</code> <strong>first</strong>",
    );
    const html = renderInline('<img src=x onerror="alert(1)"> [a](javascript:alert(1))');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('href="#"');
  });
});
