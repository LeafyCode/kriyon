import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { usePromptLibrary } from "../state/promptLibrary.ts";
import { useUi } from "../state/ui.ts";
import type { SavedPrompt } from "../types.ts";
import { usePromptRowActions } from "./usePromptRowActions.ts";

function prompt(id: string): SavedPrompt {
  return {
    body: "b",
    createdMs: 1,
    favourite: false,
    id,
    lastUsedMs: null,
    tags: ["x"],
    title: `t-${id}`,
    updatedMs: 1,
    useCount: 0,
  };
}

beforeEach(() => {
  usePromptLibrary.setState({ prompts: [prompt("p1")] });
  useUi.setState({ promptEditorSeed: null });
});

test("deleteRow arms on the first call and removes on the second", () => {
  const { result } = renderHook(() => usePromptRowActions());

  act(() => result.current.deleteRow(prompt("p1")));
  expect(result.current.deleteArmedId).toBe("p1");
  expect(usePromptLibrary.getState().prompts).toHaveLength(1);

  act(() => result.current.deleteRow(prompt("p1")));
  expect(result.current.deleteArmedId).toBeNull();
  expect(usePromptLibrary.getState().prompts).toHaveLength(0);
});

test("disarmDelete clears a pending armed row", () => {
  const { result } = renderHook(() => usePromptRowActions());
  act(() => result.current.deleteRow(prompt("p1")));
  expect(result.current.deleteArmedId).toBe("p1");
  act(() => result.current.disarmDelete());
  expect(result.current.deleteArmedId).toBeNull();
});

test("editRow opens the editor seeded with the prompt", () => {
  const { result } = renderHook(() => usePromptRowActions());
  act(() => result.current.editRow(prompt("p1")));
  expect(useUi.getState().promptEditorSeed).toMatchObject({
    body: "b",
    id: "p1",
    tags: ["x"],
    title: "t-p1",
  });
});

test("favouriteRow toggles the prompt's favourite flag", () => {
  const { result } = renderHook(() => usePromptRowActions());
  act(() => result.current.favouriteRow(prompt("p1")));
  expect(usePromptLibrary.getState().prompts[0]?.favourite).toBe(true);
});
