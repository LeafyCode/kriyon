import { beforeEach, expect, test } from "vitest";
import { useSentPrompts } from "./sentPrompts.ts";

beforeEach(() => useSentPrompts.setState({ sent: {} }));

test("remembers the last prompt sent per session until it is cleared", () => {
  useSentPrompts.getState().note("s1", {
    at: 1000,
    attachments: [],
    draft: "fix it",
    text: "  fix it  ",
  });
  expect(useSentPrompts.getState().sent.s1).toEqual({
    at: 1000,
    attachments: [],
    draft: "fix it",
    text: "fix it",
  });
  useSentPrompts.getState().clear("s1");
  expect(useSentPrompts.getState().sent.s1).toBeUndefined();
});
