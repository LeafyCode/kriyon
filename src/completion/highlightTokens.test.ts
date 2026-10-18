import { expect, test } from "vitest";
import { tokenizeComposer } from "./highlightTokens.ts";

function reconstruct(segments: ReturnType<typeof tokenizeComposer>): string {
  return segments.map((s) => s.text).join("");
}

test("leading command with arguments", () => {
  const segs = tokenizeComposer("/compact free up ctx");
  expect(segs).toEqual([
    { kind: "command", text: "/compact" },
    { kind: "plain", text: " free up ctx" },
  ]);
  expect(reconstruct(segs)).toBe("/compact free up ctx");
});

test("command followed by a mention", () => {
  const segs = tokenizeComposer("/review @src/main.rs please");
  expect(segs).toEqual([
    { kind: "command", text: "/review" },
    { kind: "plain", text: " " },
    { kind: "mention", text: "@src/main.rs" },
    { kind: "plain", text: " please" },
  ]);
  expect(reconstruct(segs)).toBe("/review @src/main.rs please");
});

test("multiple mentions with no leading command", () => {
  const segs = tokenizeComposer("look at @a.ts and @b.ts too");
  expect(segs).toEqual([
    { kind: "plain", text: "look at " },
    { kind: "mention", text: "@a.ts" },
    { kind: "plain", text: " and " },
    { kind: "mention", text: "@b.ts" },
    { kind: "plain", text: " too" },
  ]);
  expect(reconstruct(segs)).toBe("look at @a.ts and @b.ts too");
});

test("@agent- mentions are tagged as agent, not mention", () => {
  const segs = tokenizeComposer("ping @agent-Explore now");
  expect(segs).toEqual([
    { kind: "plain", text: "ping " },
    { kind: "agent", text: "@agent-Explore" },
    { kind: "plain", text: " now" },
  ]);
});

test("an '@' preceded by a non-space character is not a mention", () => {
  const segs = tokenizeComposer("email me@x now");
  expect(segs).toEqual([{ kind: "plain", text: "email me@x now" }]);
});

test("a mention at the very start of the value is still a mention", () => {
  const segs = tokenizeComposer("@agent-Explore go");
  expect(segs).toEqual([
    { kind: "agent", text: "@agent-Explore" },
    { kind: "plain", text: " go" },
  ]);
});

test("a bare slash is plain text, not a command", () => {
  const segs = tokenizeComposer("/");
  expect(segs).toEqual([{ kind: "plain", text: "/" }]);
});

test("empty string yields no segments", () => {
  const segs = tokenizeComposer("");
  expect(segs).toEqual([]);
  expect(reconstruct(segs)).toBe("");
});

test("segments always reconstruct the original value", () => {
  const value = "/compact see @src/main.rs and @agent-Explore, cc me@x";
  const segs = tokenizeComposer(value);
  expect(reconstruct(segs)).toBe(value);
});
