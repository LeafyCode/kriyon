import { afterEach, expect, test } from "vitest";
import { useChanges } from "../state/changes.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { installQaHook } from "./qaHook.ts";

afterEach(() => {
  (window as { __kriyon?: unknown }).__kriyon = undefined;
});

test("in dev builds the stores are reachable from the page", () => {
  installQaHook();

  const hook = (
    window as unknown as {
      __kriyon?: {
        useChanges: unknown;
        useSessions: unknown;
        useUi: unknown;
      };
    }
  ).__kriyon;
  expect(hook?.useSessions).toBe(useSessions);
  expect(hook?.useUi).toBe(useUi);
  expect(hook?.useChanges).toBe(useChanges);
});
