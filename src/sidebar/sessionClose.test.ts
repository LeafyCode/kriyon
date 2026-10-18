import { expect, test } from "vitest";
import { closeConfirmFor, unsentWorkFor } from "./sessionClose.ts";

test("clean session (no draft, no dirty file, no stashed drafts) has no unsent work", () => {
  expect(
    unsentWorkFor({ dirtyFile: null, draft: undefined, fileDrafts: undefined })
  ).toBeNull();
});

test("a blank/whitespace-only draft does not count as unsent work", () => {
  expect(
    unsentWorkFor({ dirtyFile: null, draft: "   ", fileDrafts: undefined })
  ).toBeNull();
});

test("a non-empty composer draft alone reports 'draft'", () => {
  expect(
    unsentWorkFor({ dirtyFile: null, draft: "finish this", fileDrafts: {} })
  ).toBe("draft");
});

test("a live dirty file alone reports 'files'", () => {
  expect(
    unsentWorkFor({ dirtyFile: "src/a.ts", draft: undefined, fileDrafts: {} })
  ).toBe("files");
});

test("a stashed file draft with no live dirty file still reports 'files'", () => {
  expect(
    unsentWorkFor({
      dirtyFile: null,
      draft: undefined,
      fileDrafts: { "src/a.ts": {} },
    })
  ).toBe("files");
});

test("draft and unsaved files together report 'both'", () => {
  expect(
    unsentWorkFor({
      dirtyFile: "src/a.ts",
      draft: "finish this",
      fileDrafts: {},
    })
  ).toBe("both");
});

// The close confirm also covers what closing *stops*: closing ends the session's
// whole process tree, so a turn in flight or a dev server Claude left running is
// lost with it. See `stopCostFor`.
const QUIET = { commands: [], engagement: "quiet" as const };

test("a quiet, clean session needs no confirm at all", () => {
  expect(closeConfirmFor(null, QUIET)).toBeNull();
});

test("a session mid-task asks, and the button says it stops something", () => {
  const confirm = closeConfirmFor(null, {
    commands: [],
    engagement: "running" as const,
  });
  expect(confirm?.body).toContain("Claude is still working");
  expect(confirm?.confirmLabel).toBe("Stop and close");
});

test("running background commands are listed, not spliced into the sentence", () => {
  const confirm = closeConfirmFor(null, {
    commands: ["pnpm dev", "cargo watch"],
    engagement: "quiet" as const,
  });
  expect(confirm?.body).toContain("2 running commands:");
  expect(confirm?.body).not.toContain("pnpm dev");
  expect(confirm?.details).toEqual(["pnpm dev", "cargo watch"]);
  expect(confirm?.confirmLabel).toBe("Stop and close");
});

test("a single command is singular, and a long list is capped", () => {
  const one = closeConfirmFor(null, {
    commands: ["pnpm dev"],
    engagement: "quiet" as const,
  });
  expect(one?.body).toContain("1 running command:");
  expect(one?.details).toEqual(["pnpm dev"]);

  const many = closeConfirmFor(null, {
    commands: ["a", "b", "c", "d", "e"],
    engagement: "quiet" as const,
  });
  expect(many?.details).toEqual(["a", "b", "c", "and 2 more"]);
});

test("a session still starting up asks before it is closed", () => {
  const confirm = closeConfirmFor(null, {
    commands: [],
    engagement: "starting" as const,
  });
  expect(confirm?.body).toContain("Claude is still starting up");
  expect(confirm?.confirmLabel).toBe("Stop and close");
});

test("unsent work alone keeps the plain close wording", () => {
  const confirm = closeConfirmFor("draft", QUIET);
  expect(confirm?.body).toContain("unsent message");
  expect(confirm?.confirmLabel).toBe("Close session");
});

test("everything at once is all said, in one dialog", () => {
  const confirm = closeConfirmFor("both", {
    commands: ["pnpm dev"],
    engagement: "running" as const,
  });
  expect(confirm?.body).toContain("Claude is still working");
  expect(confirm?.body).toContain("1 running command:");
  expect(confirm?.details).toEqual(["pnpm dev"]);
  expect(confirm?.body).toContain("unsent message and unsaved file edits");
  expect(confirm?.confirmLabel).toBe("Stop and close");
});
