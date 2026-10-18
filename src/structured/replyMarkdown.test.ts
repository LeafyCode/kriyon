import { expect, test } from "vitest";
import { parseInline, parseReply } from "./replyMarkdown.ts";

test("a fenced block is code, kept verbatim, not prose with stray backticks", () => {
  const blocks = parseReply(
    "The closest line was:\n\n```\nadded 1 package\n  in 804ms\n```\n\nDone."
  );
  expect(blocks).toEqual([
    { inline: [{ kind: "text", text: "The closest line was:" }], kind: "para" },
    { kind: "code", text: "added 1 package\n  in 804ms" },
    { inline: [{ kind: "text", text: "Done." }], kind: "para" },
  ]);
});

test("an unclosed fence still reads as code to the end", () => {
  expect(parseReply("```sh\nls -la")).toEqual([
    { kind: "code", text: "ls -la" },
  ]);
});

test("inline code and bold lose their markers", () => {
  expect(parseInline("**curl -sI:** failed, run `! curl` yourself")).toEqual([
    { children: [{ kind: "text", text: "curl -sI:" }], kind: "bold" },
    { kind: "text", text: " failed, run " },
    { kind: "code", text: "! curl" },
    { kind: "text", text: " yourself" },
  ]);
});

test("code inside bold or italic keeps its code, without stray backticks", () => {
  expect(parseInline("**`npm init -y`:** worked, *see `ls`*")).toEqual([
    {
      children: [
        { kind: "code", text: "npm init -y" },
        { kind: "text", text: ":" },
      ],
      kind: "bold",
    },
    { kind: "text", text: " worked, " },
    {
      children: [
        { kind: "text", text: "see " },
        { kind: "code", text: "ls" },
      ],
      kind: "italic",
    },
  ]);
});

test("a bold marker inside code stays code", () => {
  expect(parseInline("run `a ** b ** c` now")).toEqual([
    { kind: "text", text: "run " },
    { kind: "code", text: "a ** b ** c" },
    { kind: "text", text: " now" },
  ]);
});

test("an unmatched marker stays as typed", () => {
  expect(parseInline("2 ** 3 and a ` tick")).toEqual([
    { kind: "text", text: "2 ** 3 and a ` tick" },
  ]);
});

test("bullet and numbered lists group their items", () => {
  expect(parseReply("- one `a`\n- two\n\n1. first\n2. second")).toEqual([
    {
      items: [
        [
          { kind: "text", text: "one " },
          { kind: "code", text: "a" },
        ],
        [{ kind: "text", text: "two" }],
      ],
      kind: "list",
      ordered: false,
    },
    {
      items: [
        [{ kind: "text", text: "first" }],
        [{ kind: "text", text: "second" }],
      ],
      kind: "list",
      ordered: true,
    },
  ]);
});

test("headings and soft-wrapped paragraphs", () => {
  expect(parseReply("## Result\nline one\nline two")).toEqual([
    { inline: [{ kind: "text", text: "Result" }], kind: "heading" },
    { inline: [{ kind: "text", text: "line one\nline two" }], kind: "para" },
  ]);
});

test("a markdown link keeps its label and target", () => {
  expect(parseInline("see [the docs](https://x.dev) now")).toEqual([
    { kind: "text", text: "see " },
    {
      children: [{ kind: "text", text: "the docs" }],
      kind: "link",
      target: "https://x.dev",
    },
    { kind: "text", text: " now" },
  ]);
});

test("bare URLs and paths in prose become links", () => {
  expect(parseInline("open https://x.dev or src/a.ts:4.")).toEqual([
    { kind: "text", text: "open " },
    {
      children: [{ kind: "text", text: "https://x.dev" }],
      kind: "link",
      target: "https://x.dev",
    },
    { kind: "text", text: " or " },
    {
      children: [{ kind: "text", text: "src/a.ts:4" }],
      kind: "link",
      target: "src/a.ts:4",
    },
    { kind: "text", text: "." },
  ]);
});

test("a code span that is a path or URL is a link around the code", () => {
  expect(parseInline("edit `src/a.ts:4`, see `https://x.dev`")).toEqual([
    { kind: "text", text: "edit " },
    {
      children: [{ kind: "code", text: "src/a.ts:4" }],
      kind: "link",
      target: "src/a.ts:4",
    },
    { kind: "text", text: ", see " },
    {
      children: [{ kind: "code", text: "https://x.dev" }],
      kind: "link",
      target: "https://x.dev",
    },
  ]);
});

test("code that only looks like a file name stays code", () => {
  // A bare `name.ext` is as often an identifier as a file, and a click on one
  // would only fail; the terminal's strict rule (a `/` and an extension) holds.
  for (const code of ["console.log", "Next.js", "process.env", "origin/main"]) {
    expect(parseInline(`\`${code}\``)).toEqual([{ kind: "code", text: code }]);
  }
  expect(parseInline("`see src/a.ts`")).toEqual([
    { kind: "code", text: "see src/a.ts" },
  ]);
});

test("a markdown link's target may hold balanced parentheses", () => {
  expect(parseInline("[Rust](https://x.dev/wiki/Rust_(lang))")).toEqual([
    {
      children: [{ kind: "text", text: "Rust" }],
      kind: "link",
      target: "https://x.dev/wiki/Rust_(lang)",
    },
  ]);
});

test("a link's label is not linked again inside it", () => {
  expect(parseInline("[`src/a.ts`](src/a.ts#L2)")).toEqual([
    {
      children: [{ kind: "code", text: "src/a.ts" }],
      kind: "link",
      target: "src/a.ts#L2",
    },
  ]);
});
