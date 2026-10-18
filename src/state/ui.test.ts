import { beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { useUi } from "./ui.ts";

beforeEach(() => {
  useUi.setState({
    needsYouOpen: false,
    paletteOpen: false,
    promptEditorSeed: null,
    promptPickerOpen: false,
    spawnOpen: false,
  });
});

test("opening the needs-you overlay closes the palette", () => {
  useUi.getState().openPalette();
  useUi.getState().openNeedsYou();
  expect(useUi.getState().needsYouOpen).toBe(true);
  expect(useUi.getState().paletteOpen).toBe(false);
});

test("opening the palette closes the needs-you overlay", () => {
  useUi.getState().openNeedsYou();
  useUi.getState().openPalette();
  expect(useUi.getState().paletteOpen).toBe(true);
  expect(useUi.getState().needsYouOpen).toBe(false);
});

test("toggling the palette open closes the needs-you overlay", () => {
  useUi.getState().openNeedsYou();
  useUi.getState().togglePalette();
  expect(useUi.getState().paletteOpen).toBe(true);
  expect(useUi.getState().needsYouOpen).toBe(false);
});

test("opening the spawn dialog closes the palette and needs-you overlay", () => {
  useUi.getState().openPalette();
  useUi.getState().openSpawn({ predecessorId: "s1" });
  expect(useUi.getState().spawnOpen).toBe(true);
  expect(useUi.getState().paletteOpen).toBe(false);
  expect(useUi.getState().needsYouOpen).toBe(false);
});

// The dialog draws nothing without a session or a project to start from, so
// asking for one with neither must not compile. That state is how the tray's
// New session button came to open an invisible dialog.
test("the spawn dialog always opens anchored to a session or a project", () => {
  useUi.getState().openSpawn({ projectId: "p1" }, { worktree: true });
  expect(useUi.getState().spawnProjectId).toBe("p1");
  expect(useUi.getState().spawnPredecessorId).toBeNull();
  expect(useUi.getState().spawnWorktreeDefault).toBe(true);

  useUi.getState().openSpawn({ predecessorId: "s1" });
  expect(useUi.getState().spawnPredecessorId).toBe("s1");
  expect(useUi.getState().spawnProjectId).toBeNull();
  expect(useUi.getState().spawnWorktreeDefault).toBe(false);

  expectTypeOf(useUi.getState().openSpawn).parameter(0).not.toBeNullable();
});

test("opening the palette closes the spawn dialog", () => {
  useUi.getState().openSpawn({ predecessorId: "s1" });
  useUi.getState().openPalette();
  expect(useUi.getState().paletteOpen).toBe(true);
  expect(useUi.getState().spawnOpen).toBe(false);
});

test("opening the needs-you overlay closes the spawn dialog", () => {
  useUi.getState().openSpawn({ predecessorId: "s1" });
  useUi.getState().openNeedsYou();
  expect(useUi.getState().needsYouOpen).toBe(true);
  expect(useUi.getState().spawnOpen).toBe(false);
});

describe("prompt picker exclusivity", () => {
  test("openPromptPicker closes palette, spawn, and needs-you", () => {
    useUi.getState().openPalette();
    useUi.getState().openPromptPicker();
    const state = useUi.getState();
    expect(state.promptPickerOpen).toBe(true);
    expect(state.paletteOpen).toBe(false);
    expect(state.needsYouOpen).toBe(false);
    expect(state.spawnOpen).toBe(false);
  });

  test("opening any other surface closes the picker and editor", () => {
    useUi.getState().openPromptPicker();
    useUi.getState().openPalette();
    expect(useUi.getState().promptPickerOpen).toBe(false);
    useUi.getState().openPromptEditor({ body: "b", tags: [], title: "t" });
    useUi.getState().openNeedsYou();
    expect(useUi.getState().promptEditorSeed).toBeNull();
  });

  test("editor seed round-trips through open/close", () => {
    useUi
      .getState()
      .openPromptEditor({ body: "b", id: "p1", tags: ["x"], title: "t" });
    expect(useUi.getState().promptEditorSeed?.id).toBe("p1");
    useUi.getState().closePromptEditor();
    expect(useUi.getState().promptEditorSeed).toBeNull();
  });

  test("openSpawn closes picker", () => {
    useUi.getState().openPromptPicker();
    useUi.getState().openSpawn({ predecessorId: "s1" });
    const state = useUi.getState();
    expect(state.spawnOpen).toBe(true);
    expect(state.promptPickerOpen).toBe(false);
  });

  test("openSpawn closes editor", () => {
    useUi.getState().openPromptEditor({ body: "b", tags: [], title: "t" });
    useUi.getState().openSpawn({ predecessorId: "s1" });
    const state = useUi.getState();
    expect(state.spawnOpen).toBe(true);
    expect(state.promptEditorSeed).toBeNull();
  });

  test("openPromptEditor closes picker", () => {
    useUi.getState().openPromptPicker();
    useUi.getState().openPromptEditor({ body: "b", tags: [], title: "t" });
    const state = useUi.getState();
    expect(state.promptEditorSeed).not.toBeNull();
    expect(state.promptPickerOpen).toBe(false);
  });

  test("openPromptPicker closes editor", () => {
    useUi.getState().openPromptEditor({ body: "b", tags: [], title: "t" });
    useUi.getState().openPromptPicker();
    const state = useUi.getState();
    expect(state.promptPickerOpen).toBe(true);
    expect(state.promptEditorSeed).toBeNull();
  });

  test("togglePalette opening closes picker", () => {
    useUi.getState().openPromptPicker();
    useUi.getState().togglePalette();
    const state = useUi.getState();
    expect(state.paletteOpen).toBe(true);
    expect(state.promptPickerOpen).toBe(false);
  });
});

test("a seeded spawn carries its seed; a plain spawn clears it", () => {
  useUi.getState().openSpawn({ predecessorId: "s1" }, { seed: "Read x" });
  expect(useUi.getState().spawnSeed).toBe("Read x");
  useUi.getState().openSpawn({ predecessorId: "s1" });
  expect(useUi.getState().spawnSeed).toBeNull();
});
