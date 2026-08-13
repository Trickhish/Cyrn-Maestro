import { Fragment, type ReactNode } from "react";

/* A small markdown renderer for agent output.
 *
 * Models answer in markdown whether or not anyone asked them to, so a chat that
 * shows it raw is full of stray asterisks and unrendered fences. This covers
 * what actually turns up in those answers — headings, lists, code, emphasis,
 * links, quotes, tables of nothing more exotic than text — and deliberately not
 * the rest of the specification. Reference links, footnotes and inline HTML are
 * not things a coding agent writes at the end of a task.
 *
 * The load-bearing decision: this produces React elements, never an HTML
 * string, and there is no dangerouslySetInnerHTML anywhere in it. The text
 * being rendered was written by a model that may have been reading a
 * repository, an issue tracker or a web page a moment earlier, so it is
 * untrusted input arriving on a page that holds a session cookie. Building
 * elements means a `<script>` in the text is text; building HTML would mean
 * every renderer bug is an XSS. Link targets are checked for the same reason —
 * see `safeHref`. */

interface MarkdownProps {
  text: string;
  /* Renders the runs of ordinary text between markdown tokens. The Conductor
     uses it to turn a bare task id into a link to that task, which markdown
     itself has no syntax for. Defaults to the text unchanged. */
  plain?: (text: string, key: string) => ReactNode;
  className?: string;
}

export function Markdown({ text, plain, className }: MarkdownProps) {
  return <div className={className}>{blocks(text, plain)}</div>;
}

/* ----------------------------------------------------------------- blocks */

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)(.*)$/;

const HEADING_SIZES = [
  "text-[17px] font-semibold mt-1",
  "text-[15.5px] font-semibold mt-1",
  "text-[14.5px] font-semibold",
  "text-[14px] font-semibold",
  "text-[13.5px] font-semibold",
  "text-[13px] font-semibold text-tertiary",
];

function blocks(text: string, plain?: MarkdownProps["plain"]): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;

  const key = () => `b${out.length}`;

  while (i < lines.length) {
    const line = lines[i];

    /* Blank lines only separate blocks; they are not content of their own. */
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].trim();
      const body: string[] = [];
      i++;
      /* An unclosed fence runs to the end, which is what a half-streamed
         answer looks like — better than refusing to render the rest. */
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <pre
          key={key()}
          className="my-1.5 px-3 py-2 bg-inset border rule rounded-md font-mono text-[12px] leading-[1.6] text-tertiary overflow-x-auto scroll-quiet"
        >
          {language && (
            <span className="block text-[10px] uppercase tracking-[0.1em] text-faint mb-1">
              {language}
            </span>
          )}
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={key()} className="my-2 border-0 border-t rule" />);
      i++;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level, 6)}` as "h1";
      out.push(
        <Tag key={key()} className={HEADING_SIZES[level - 1]}>
          {inline(heading[2], plain)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].match(QUOTE)![1]);
        i++;
      }
      out.push(
        <blockquote key={key()} className="border-l-2 rule pl-3 text-tertiary">
          {blocks(body.join("\n"), plain)}
        </blockquote>,
      );
      continue;
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[] = [];
      /* A list ends at the first line that is not an item of the same kind.
         Continuation lines indented under an item join it, so a wrapped
         sentence does not become its own paragraph. */
      while (i < lines.length) {
        const match = lines[i].match(ordered ? ORDERED : UNORDERED);
        if (match) {
          items.push(ordered ? match[2] : match[1]);
          i++;
        } else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        } else {
          break;
        }
      }

      const List = ordered ? "ol" : "ul";
      out.push(
        <List
          key={key()}
          className={`flex flex-col gap-0.5 pl-[22px] ${ordered ? "list-decimal" : "list-disc"} marker:text-faint`}
        >
          {items.map((item, n) => (
            <li key={n}>{inline(item, plain)}</li>
          ))}
        </List>,
      );
      continue;
    }

    /* Anything else is a paragraph, running until a blank line or the start of
       another block. Single newlines inside it are kept as line breaks, which
       is what people mean when they write them in a chat. */
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !UNORDERED.test(lines[i]) &&
      !ORDERED.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }

    out.push(
      <p key={key()} className="whitespace-pre-wrap">
        {inline(paragraph.join("\n"), plain)}
      </p>,
    );
  }

  return out;
}

/* ----------------------------------------------------------------- inline */

/* Ordered deliberately: code first, so backticks win over everything inside
   them, and the two-character markers before their one-character versions so
   `**bold**` is not read as an empty italic.
 *
 * Every emphasis run requires its content to begin and end with a non-space.
 * Without that, "2 * 3 * 4" italicises the middle and prose about multiplication
 * or globs comes out mangled — the delimiter has to be attached to the word it
 * emphasises, which is the useful half of CommonMark's flanking rule.
 *
 * The underscore forms additionally refuse to fire mid-word, because agent
 * answers are full of snake_case identifiers and turning the middle of
 * `some_long_name` into italics is worse than never rendering `_this_` at all. */
const WORD = "[A-Za-z0-9]";
const INLINE_SOURCE = [
  "(`+)([\\s\\S]+?)\\1", // code
  "!?\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)", // link
  "\\*\\*(\\S|\\S[\\s\\S]*?\\S)\\*\\*", // bold
  `(?<!${WORD})__(\\S|\\S[\\s\\S]*?\\S)__(?!${WORD})`, // bold
  "~~(\\S|\\S[\\s\\S]*?\\S)~~", // strike
  "\\*(\\S|\\S[^*\\n]*?\\S)\\*", // italic
  `(?<!${WORD})_(\\S|\\S[^_\\n]*?\\S)_(?!${WORD})`, // italic
  "(https?://[^\\s<>()]+)", // bare url
].join("|");

function inline(text: string, plain?: MarkdownProps["plain"]): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  /* Built per call, not shared. This function recurses into what it matched —
     the contents of a bold run are parsed for emphasis and links of their own —
     and a `g` regex carries `lastIndex` as mutable state on the object itself.
     One shared instance means the inner call rewinds the outer loop's position,
     which does not merely misparse: it re-matches the same token forever. */
  const pattern = new RegExp(INLINE_SOURCE, "g");

  const pushPlain = (value: string) => {
    if (!value) return;
    out.push(
      plain ? (
        <Fragment key={`p${out.length}`}>{plain(value, `p${out.length}`)}</Fragment>
      ) : (
        <Fragment key={`p${out.length}`}>{value}</Fragment>
      ),
    );
  };

  while ((match = pattern.exec(text))) {
    pushPlain(text.slice(last, match.index));
    last = match.index + match[0].length;
    const key = `i${out.length}`;

    const [, , code, linkText, linkHref, bold1, bold2, strike, italic1, italic2, bareUrl] = match;

    if (code !== undefined) {
      out.push(
        <code key={key} className="font-mono text-[12.5px] bg-inset rounded px-1 py-px">
          {code}
        </code>,
      );
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      /* A link we will not follow still shows its text — dropping it would
         silently rewrite what the agent said. */
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent-hi hover:underline"
          >
            {inline(linkText || linkHref, plain)}
          </a>
        ) : (
          <Fragment key={key}>{linkText || linkHref}</Fragment>
        ),
      );
    } else if (bold1 !== undefined || bold2 !== undefined) {
      out.push(
        <strong key={key} className="font-semibold text-primary">
          {inline(bold1 ?? bold2, plain)}
        </strong>,
      );
    } else if (strike !== undefined) {
      out.push(
        <s key={key} className="text-faint">
          {inline(strike, plain)}
        </s>,
      );
    } else if (italic1 !== undefined || italic2 !== undefined) {
      out.push(<em key={key}>{inline(italic1 ?? italic2, plain)}</em>);
    } else if (bareUrl !== undefined) {
      const href = safeHref(bareUrl);
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent-hi hover:underline"
          >
            {bareUrl}
          </a>
        ) : (
          <Fragment key={key}>{bareUrl}</Fragment>
        ),
      );
    }
  }

  pushPlain(text.slice(last));
  return out;
}

/* Which link targets are allowed to become clickable.
 *
 * The text here is written by a model, so `javascript:` and `data:` URLs are
 * the obvious way an answer could try to run something when a user clicks a
 * plausible-looking link. Allow the schemes that mean "a document somewhere"
 * and nothing else; everything rejected still renders as plain text, so no
 * information is lost, it just is not clickable. */
export function safeHref(href: string): string | null {
  const value = href.trim();

  /* Relative and anchor links stay inside this app. A protocol-relative //host
     is not one of those, so it is excluded here and handled by the scheme
     check below. */
  if (/^[./#?]/.test(value) && !value.startsWith("//")) return value;

  return /^(https?|mailto):/i.test(value) ? value : null;
}
