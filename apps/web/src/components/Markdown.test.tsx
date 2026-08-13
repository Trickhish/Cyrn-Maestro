import { expect, test, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeHref } from "./Markdown";

/* Rendering what a model wrote.
 *
 * Two things are being pinned here. The first is that ordinary markdown comes
 * out as the elements it should. The second matters more: this text arrives
 * from an agent that may have just been reading a repository or a web page, on
 * a page that holds a session cookie — so nothing in it may ever become
 * executable markup, and no link may ever become a clickable script. */

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("blocks", () => {
  test("renders a heading", () => {
    expect(html("# Title")).toContain("<h1");
    expect(html("### Title")).toContain("<h3");
  });

  test("renders a fenced code block and keeps its contents literal", () => {
    const out = html("```js\nconst a = 1 < 2;\n```");
    expect(out).toContain("<pre");
    expect(out).toContain("const a = 1 &lt; 2;");
  });

  test("renders an unclosed fence rather than dropping it", () => {
    /* What a half-streamed answer looks like. */
    expect(html("```\nstill arriving")).toContain("still arriving");
  });

  test("renders bullet and numbered lists", () => {
    expect(html("- one\n- two")).toContain("<ul");
    expect(html("1. one\n2. two")).toContain("<ol");
  });

  test("renders a blockquote and a rule", () => {
    expect(html("> quoted")).toContain("<blockquote");
    expect(html("---")).toContain("<hr");
  });

  test("keeps paragraphs separate", () => {
    const out = html("one\n\ntwo");
    expect(out.match(/<p/g)).toHaveLength(2);
  });
});

describe("inline", () => {
  test("bold, italic, strikethrough and code", () => {
    expect(html("**b**")).toContain("<strong");
    expect(html("*i*")).toContain("<em");
    expect(html("~~s~~")).toContain("<s");
    expect(html("`c`")).toContain("<code");
  });

  test("code spans win over emphasis inside them", () => {
    const out = html("`**not bold**`");
    expect(out).not.toContain("<strong");
    expect(out).toContain("**not bold**");
  });

  test("renders a link", () => {
    const out = html("[text](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("text");
  });

  test("links a bare url", () => {
    expect(html("see https://example.com now")).toContain('href="https://example.com"');
  });

  test("leaves lone asterisks alone", () => {
    expect(html("2 * 3 * 4")).toContain("2 * 3 * 4");
  });

  test("does not italicise inside snake_case identifiers", () => {
    const out = html("call some_long_name here");
    expect(out).not.toContain("<em");
    expect(out).toContain("some_long_name");
  });

  test("still renders _emphasis_ that stands on its own", () => {
    expect(html("this is _important_ text")).toContain("<em");
  });
});

describe("untrusted input", () => {
  /* The whole reason this renders elements instead of an HTML string. */
  test("script tags are text, not markup", () => {
    const out = html('<script>alert("x")</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("inline event handlers are text", () => {
    const out = html('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  test.each([
    ["javascript:", "[click](javascript:alert(1))"],
    ["data:", "[click](data:text/html;base64,PHNjcmlwdD4=)"],
    ["vbscript:", "[click](vbscript:msgbox)"],
  ])("a %s link is not clickable", (_label, markdown) => {
    const out = html(markdown);
    expect(out).not.toContain("<a");
    /* The text still shows — refusing the link must not silently rewrite
       what the agent said. */
    expect(out).toContain("click");
  });

  test("case and whitespace do not smuggle a scheme past the check", () => {
    expect(html("[c](  JaVaScRiPt:alert(1))")).not.toContain("<a");
  });

  test("outbound links cannot reach back through window.opener", () => {
    expect(html("[t](https://example.com)")).toContain("noopener");
  });
});

describe("safeHref", () => {
  test.each(["https://x.com", "http://x.com", "mailto:a@b.com", "/local", "#anchor", "./rel"])(
    "allows %s",
    (href) => {
      expect(safeHref(href)).not.toBeNull();
    },
  );

  test.each([
    "javascript:alert(1)",
    " javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "//evil.com",
  ])("refuses %s", (href) => {
    expect(safeHref(href)).toBeNull();
  });
});
