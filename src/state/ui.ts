import { create } from "zustand";

/** Prefill for the Prompt editor: no id = creating a new Saved prompt. */
export interface PromptEditorSeed {
  body: string;
  id?: string;
  tags: string[];
  title: string;
}

/**
 * Ephemeral UI state that several disconnected components share — currently
 * the command palette and the ⌘⇧K Needs-you overlay open/close.
 *
 * (Launching `claude` is no longer tracked here: a session launches/resumes the
 * first time it is viewed, driven by the active-session effect in `App`, not by
 * a per-mount flag — see {@link launchClaudeOnce}.)
 */
interface UiState {
  /** The About panel (opened from the ⓘ button or the macOS app menu). */
  aboutOpen: boolean;
  closeAbout: () => void;
  closeNeedsYou: () => void;
  closePalette: () => void;
  closePromptEditor: () => void;
  closePromptPicker: () => void;
  closeSpawn: () => void;
  /** The ⌘⇧K Needs-you overlay. */
  needsYouOpen: boolean;
  openAbout: () => void;
  openNeedsYou: () => void;
  openPalette: () => void;
  /**
   * Open the prompt editor with the given seed data.
   * Closes palette, needs-you, spawn, and picker.
   */
  openPromptEditor: (seed: PromptEditorSeed) => void;
  /**
   * Open the prompt picker.
   * Closes palette, needs-you, spawn, and editor.
   */
  openPromptPicker: () => void;
  /**
   * Open the spawn dialog anchored to exactly one thing: a follow-up of
   * `predecessorId`, or a fresh session in `projectId` (the sidebar's
   * per-project worktree button). There is no third option: with neither, the
   * dialog has nothing to start from and draws nothing. `opts.worktree`
   * pre-enables the "Run in a fresh worktree" toggle; `opts.seed` replaces
   * the built [Handoff prompt] (the [Handoff card]'s "Read <path>…").
   */
  openSpawn: (
    anchor: { predecessorId: string } | { projectId: string },
    opts?: { seed?: string; worktree?: boolean }
  ) => void;
  paletteOpen: boolean;
  /** Prefill data for the prompt editor when open; null = editor closed. */
  promptEditorSeed: PromptEditorSeed | null;
  /** Whether the prompt picker overlay is open. */
  promptPickerOpen: boolean;
  /** The [Spawn dialog] composing a follow-up/worktree session. */
  spawnOpen: boolean;
  /** The session the spawn dialog is following up from, if any. */
  spawnPredecessorId: string | null;
  /** The project a predecessor-less spawn is anchored to, if any. */
  spawnProjectId: string | null;
  /** A prompt that replaces the built [Handoff prompt], if any. */
  spawnSeed: string | null;
  /** Whether the spawn dialog's worktree toggle should start enabled. */
  spawnWorktreeDefault: boolean;
  togglePalette: () => void;
}

/** The mutually-exclusive overlays in the ⌘K family. */
type OverlayId =
  | "palette"
  | "needsYou"
  | "promptPicker"
  | "promptEditor"
  | "spawn";

/**
 * The open/close state for showing exactly one overlay (or none). Opening any
 * overlay closes every other — collapsing what used to be an N×N matrix of
 * per-action flag lists into one place. `promptEditorSeed` is cleared here and
 * re-set by the caller only when opening the editor.
 */
function showOnly(overlay: OverlayId | null): {
  needsYouOpen: boolean;
  paletteOpen: boolean;
  promptEditorSeed: PromptEditorSeed | null;
  promptPickerOpen: boolean;
  spawnOpen: boolean;
} {
  return {
    needsYouOpen: overlay === "needsYou",
    paletteOpen: overlay === "palette",
    promptEditorSeed: null,
    promptPickerOpen: overlay === "promptPicker",
    spawnOpen: overlay === "spawn",
  };
}

export const useUi = create<UiState>((set) => ({
  aboutOpen: false,
  openAbout: () => set({ aboutOpen: true }),
  closeAbout: () => set({ aboutOpen: false }),
  needsYouOpen: false,
  paletteOpen: false,
  promptEditorSeed: null,
  promptPickerOpen: false,
  spawnOpen: false,
  spawnPredecessorId: null,
  spawnProjectId: null,
  spawnSeed: null,
  spawnWorktreeDefault: false,
  openPalette: () => set(showOnly("palette")),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () =>
    set((state) =>
      state.paletteOpen ? { paletteOpen: false } : showOnly("palette")
    ),
  openNeedsYou: () => set(showOnly("needsYou")),
  closeNeedsYou: () => set({ needsYouOpen: false }),
  openPromptPicker: () => set(showOnly("promptPicker")),
  closePromptPicker: () => set({ promptPickerOpen: false }),
  openPromptEditor: (seed) =>
    set({ ...showOnly("promptEditor"), promptEditorSeed: seed }),
  closePromptEditor: () => set({ promptEditorSeed: null }),
  openSpawn: (anchor, opts) =>
    set({
      ...showOnly("spawn"),
      spawnPredecessorId:
        "predecessorId" in anchor ? anchor.predecessorId : null,
      spawnProjectId: "projectId" in anchor ? anchor.projectId : null,
      spawnSeed: opts?.seed ?? null,
      spawnWorktreeDefault: opts?.worktree ?? false,
    }),
  closeSpawn: () => set({ spawnOpen: false }),
}));
