import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  diffSessionChanges: vi.fn(),
  diffWorkingTree: vi.fn(),
  discardFileChanges: vi.fn().mockResolvedValue(undefined),
  openInEditor: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  readBaseline: vi.fn().mockResolvedValue({ content: null, state: "tracked" }),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
// Only the save trigger is stubbed; the rest of the coordinator stays real so
// the viewer's `useRevalidateOn` revalidation still runs (see
// `useFileEditorSession.test.ts` for the same arrangement).
vi.mock("../state/changesRefresh.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestRefresh: vi.fn(),
}));
vi.mock("./highlighter.ts", () => ({
  highlightLines: vi.fn().mockReturnValue(new Promise(() => undefined)),
  // Synchronous cache peek; `undefined` keeps these tests on the async path.
  peekHighlight: vi.fn(),
  langForPath: () => "text",
}));
// `CodeEditor` is Task 16's own, already independently tested unit (against
// real CodeMirror mocks — see `CodeEditor.test.tsx`). Re-driving real
// CodeMirror through jsdom here would only re-test that wiring a second
// time while adding nothing to FileViewer's own contract (save/dirty/
// conflict/guard). This fake is a genuinely controlled `<textarea>` wired to
// whatever `value`/`onChange` FileViewer actually passes — not a canned
// response — so every assertion below still exercises FileViewer's real
// state, not the mock's.
vi.mock("./CodeEditor.tsx", () => ({
  CodeEditor: ({
    baseline,
    onChange,
    value,
  }: {
    baseline?: string;
    onChange: (next: string) => void;
    value: string;
  }) => (
    <textarea
      data-baseline={baseline}
      onChange={(e) => onChange(e.target.value)}
      value={value}
    />
  ),
}));

import {
  discardFileChanges,
  openInEditor,
  openPath,
  readBaseline,
  readFile,
  writeFile,
} from "../ipc/bridge.ts";
import { useChanges } from "../state/changes.ts";
import { requestRefresh } from "../state/changesRefresh.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileContent, FileDiff } from "../types.ts";
import { Toast } from "../ui/Toast.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { highlightLines } from "./highlighter.ts";
import { MAX_HIGHLIGHT_LINES } from "./ReadOnlyFileView.tsx";
import type { FileViewerNotice } from "./useFileEditorSession.ts";

const mockedReadFile = vi.mocked(readFile);
const mockedReadBaseline = vi.mocked(readBaseline);
const mockedWriteFile = vi.mocked(writeFile);
const mockedOpenPath = vi.mocked(openPath);
const mockedOpenInEditor = vi.mocked(openInEditor);
const mockedHighlightLines = vi.mocked(highlightLines);
const mockedRequestRefresh = vi.mocked(requestRefresh);
const mockedDiscardFileChanges = vi.mocked(discardFileChanges);

/** The wire shape Rust's `tagged_failure` actually produces for these two
 * [Command failure kind]s (see `file_cmd.rs`) — mirrors the same constants
 * in `useFileEditorSession.test.ts`. */
const TAGGED_CONFLICT_ERROR =
  "kind:save-conflict: file changed on disk since it was opened";
const TAGGED_MISSING_FILE_ERROR = "kind:file-missing: path does not exist";

// Hoisted per Biome's `useTopLevelRegex` (mirrors `CodeEditor.test.tsx`'s
// `CONST_X_1_RE`).
const SAVE_BUTTON_RE = /save/i;
// Matches the Save button by name in either its "Save" or "Saving…" state —
// `SAVE_BUTTON_RE` alone doesn't match "Saving…" (no literal "save"
// substring), so this is needed wherever a test must find the button while
// a save may already be in flight.
const SAVE_OR_SAVING_BUTTON_RE = /sav(e|ing)/i;
const RELOAD_BUTTON_RE = /reload/i;
const DISCARD_EDITS_RE = /discard edits/i;
const DISCARD_FILE_RE = /discard file changes/i;
// The confirm modal's destructive button, deliberately worded so it can't
// also match the header's own two discard buttons.
const CONFIRM_DISCARD_RE = /^discard changes$/i;
const CONFIRM_CANCEL_RE = /^cancel$/i;
const CANNOT_BE_UNDONE_RE = /cannot be undone/i;
const DISCARD_A_TS_TITLE_RE = /discard changes to a\.ts\?/i;
const DISCARD_FAILED_RE = /git checkout failed/i;
const DISCARD_CLOSE_RE = /discard.*close/i;
const CANCEL_RE = /cancel/i;
const DISCARD_SWITCH_RE = /discard.*switch/i;
const KEEP_EDITING_RE = /keep editing/i;
const CHANGED_ON_DISK_RE = /changed on disk/i;
const TOO_LARGE_RE = /too large to edit safely/i;
const BINARY_RE = /binary/i;
const CLOSE_BUTTON_RE = /close/i;
const UNSAVED_EDITS_KEPT_RE = /unsaved edits are kept/i;

function content(overrides: Partial<FileContent> = {}): FileContent {
  return {
    binary: false,
    content: "a\nb\nc",
    lossy: false,
    mtime: 1_700_000_000_000,
    size: 5,
    truncated: false,
    ...overrides,
  };
}

/** Renders `<FileViewer>` with sane defaults, only requiring the fields a
 * test actually cares about — mirrors the brief's `renderViewer` helper. */
function renderViewer(
  props: Partial<Parameters<typeof FileViewer>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" {...props} />
  );
}

/** Simulates typing a full replacement into the mocked `CodeEditor`
 * `<textarea>` — a plain `fireEvent.change`, since `@testing-library/
 * user-event` isn't a repo dependency (see `PromptBar.test.tsx`/
 * `CodeEditor.test.tsx`'s own `typeInto` for the same convention). */
function typeInto(el: HTMLElement, text: string): void {
  fireEvent.change(el, { target: { value: text } });
}

/** Every banner the file-editing session can raise, keyed by the test id it
 * renders under — {@link shownBanners} reports them in DOM order, so the
 * precedence matrix pins both *which* banners are up and which sits above
 * which. Content notices (binary/truncated/lossy) are deliberately absent:
 * they describe the file, not the session, and never contend with these. */
const BANNER_KIND_BY_TESTID: Record<string, FileViewerNotice["kind"]> = {
  "file-viewer-close-guard": "closeGuard",
  "file-viewer-missing-notice": "missingOnDisk",
  "file-viewer-save-error": "saveError",
  "file-viewer-stale-notice": "staleOnDisk",
  "file-viewer-switch-guard": "switchGuard",
};

/** The session banners currently on screen, in DOM order. */
function shownBanners(): FileViewerNotice["kind"][] {
  const shown: FileViewerNotice["kind"][] = [];
  const root = screen.getByTestId("file-viewer");
  for (const el of Array.from(root.querySelectorAll("[data-testid]"))) {
    const kind = BANNER_KIND_BY_TESTID[el.getAttribute("data-testid") ?? ""];
    if (kind) {
      shown.push(kind);
    }
  }
  return shown;
}

/** Land a refresh for `sessionId`, the signal an open file revalidates on —
 * mirrors `useFileEditorSession.test.ts`'s own `landRefresh`. */
function landRefresh(sessionId: string, fetchedAt: number): void {
  act(() => {
    useChanges.setState((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: {
          baselineLabel: "",
          collapsed: {},
          diff: null,
          fetchedAt,
          hunkHashes: {},
          status: "ready",
          totals: null,
          viewed: {},
        },
      },
    }));
  });
}

describe("FileViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedOpenPath.mockResolvedValue(undefined);
    // `fileDrafts` as well as `selectedFile`: unmounting a dirty viewer stashes
    // its draft (so a warm-pane eviction can't eat it), and the store outlives
    // the test, so one test's unsaved edit would seed the next one's file.
    // `bySession` too: the revalidation effect keys off `fetchedAt`, so a
    // value left behind by `landRefresh` in one test would make an identical
    // one in the next look like "no refresh landed".
    useChanges.setState({ bySession: {}, fileDrafts: {}, ui: {} });
    // @tanstack/react-virtual measures via offsetHeight/offsetWidth in jsdom,
    // not getBoundingClientRect (see DiffFeed.test.tsx) — jsdom never
    // computes layout, so both default to 0 and the virtualizer would render
    // nothing without a stub.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 600,
    });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
  });

  it("renders an editable buffer seeded from the loaded content", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "a\nb\nc" }));

    renderViewer();

    const textbox = await screen.findByRole("textbox");
    expect(textbox).toHaveValue("a\nb\nc");
    expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument();
  });

  it("passes the fetched git baseline through to the editor", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "a\nb\nc" }));
    mockedReadBaseline.mockResolvedValue({ content: "a\nb", state: "tracked" });

    renderViewer();

    const textbox = await screen.findByRole("textbox");
    await waitFor(() => {
      expect(textbox).toHaveAttribute("data-baseline", "a\nb");
    });
  });

  it("saves edits and clears the dirty state", async () => {
    mockedReadFile.mockResolvedValue({
      binary: false,
      content: "old",
      lossy: false,
      mtime: 111,
      size: 3,
      truncated: false,
    });
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

    renderViewer({ cwd: "/repo", path: "a.ts" });

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "new");
    expect(screen.getByTestId("dirty-indicator")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    await waitFor(() => {
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        expect.any(String),
        111,
        3
      );
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/repo",
      "a.ts",
      "new",
      111,
      3
    );
    await waitFor(() => {
      expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument();
    });
  });

  it("refreshes the session's Changes view after a successful save (I2)", async () => {
    mockedReadFile.mockResolvedValue({
      binary: false,
      content: "old",
      lossy: false,
      mtime: 111,
      size: 3,
      truncated: false,
    });
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

    renderViewer({ cwd: "/repo", path: "a.ts", sessionId: "s1" });

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "new");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    await waitFor(() => {
      expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "saved");
    });
  });

  it("does not attempt a refresh after save when no sessionId was given", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "old" }));
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

    // `renderViewer`'s default props omit `sessionId` entirely.
    renderViewer();

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "new");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    await waitFor(() =>
      expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument()
    );
    expect(mockedRequestRefresh).not.toHaveBeenCalled();
  });

  it("does not refresh the Changes view when a save fails", async () => {
    mockedReadFile.mockResolvedValue(content());
    mockedWriteFile.mockRejectedValue(new Error("permission denied"));

    renderViewer({ sessionId: "s1" });

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "x");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    await waitFor(() => {
      expect(screen.getByTestId("file-viewer-save-error")).toBeInTheDocument();
    });
    expect(mockedRequestRefresh).not.toHaveBeenCalled();
  });

  it("keeps keystrokes typed during an in-flight save — dirty stays true if the user kept typing", async () => {
    mockedReadFile.mockResolvedValue(content());
    let resolveWrite: (result: { len: number; mtime: number }) => void = () =>
      undefined;
    mockedWriteFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        })
    );

    renderViewer();

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "saved-snapshot");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    // The Save *button* disables while saving, but the editor itself is not
    // read-only — keep typing while the write is still in flight.
    typeInto(textbox, "saved-snapshot-plus-more-typing");

    await act(async () => {
      resolveWrite({ len: 9, mtime: 999 });
      await Promise.resolve();
    });

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    // The write went out with the snapshot captured at click time, not
    // whatever was typed afterwards.
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/repo",
      "a.ts",
      "saved-snapshot",
      1_700_000_000_000,
      5
    );
    // The response must not clobber what the user typed afterwards.
    expect(screen.getByRole("textbox")).toHaveValue(
      "saved-snapshot-plus-more-typing"
    );
    expect(screen.getByTestId("dirty-indicator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SAVE_BUTTON_RE })).toBeEnabled();
  });

  it("saving over a stale signature adopts the new (mtime, len) for the next save", async () => {
    mockedReadFile.mockResolvedValue(content());
    mockedWriteFile.mockResolvedValue({ len: 9, mtime: 999 });
    renderViewer();

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "one");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
    await waitFor(() =>
      expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument()
    );

    typeInto(textbox, "two");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    await waitFor(() => {
      expect(mockedWriteFile).toHaveBeenLastCalledWith(
        "/repo",
        "a.ts",
        "two",
        999,
        9
      );
    });
  });

  it("shows a reload banner when the file changed on disk, and Reload reseeds the editor", async () => {
    mockedReadFile.mockResolvedValueOnce(content({ content: "old" }));
    mockedWriteFile.mockRejectedValue(new Error(TAGGED_CONFLICT_ERROR));

    renderViewer();

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "x");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    expect(await screen.findByText(CHANGED_ON_DISK_RE)).toBeInTheDocument();
    const reloadButton = screen.getByRole("button", { name: RELOAD_BUTTON_RE });
    expect(reloadButton).toBeInTheDocument();

    mockedReadFile.mockResolvedValueOnce(
      content({ content: "fresh-from-disk" })
    );
    fireEvent.click(reloadButton);

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("fresh-from-disk");
    });
    expect(screen.queryByText(CHANGED_ON_DISK_RE)).not.toBeInTheDocument();
    expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument();
  });

  it("shows a plain error banner (no Reload) for a non-conflict save failure", async () => {
    mockedReadFile.mockResolvedValue(content());
    mockedWriteFile.mockRejectedValue(
      new Error("file is too large to edit safely")
    );
    renderViewer();

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "x");
    fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

    expect(await screen.findByText(TOO_LARGE_RE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RELOAD_BUTTON_RE })
    ).not.toBeInTheDocument();
  });

  it("reverts the draft back to the loaded content without touching disk", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "original" }));
    renderViewer();

    const textbox = await screen.findByRole("textbox");
    typeInto(textbox, "changed");
    expect(screen.getByTestId("dirty-indicator")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: DISCARD_EDITS_RE }));

    expect(screen.getByRole("textbox")).toHaveValue("original");
    expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("shows the discard-edits button as unavailable while the draft is clean", async () => {
    // It was named "Revert" — which reads as a git operation next to a file
    // that has a git gutter — and it carried the plain enabled styling in
    // both states, so a clean buffer offered a button that looked pressable
    // and did nothing. Same faint-ink/0.6 treatment Save already has.
    mockedReadFile.mockResolvedValue(content({ content: "original" }));
    renderViewer();

    const button = await screen.findByRole("button", {
      name: DISCARD_EDITS_RE,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveStyle({
      color: tokens.color.ink.faint,
      cursor: "default",
      opacity: "0.6",
    });

    typeInto(screen.getByRole("textbox"), "changed");

    expect(button).toBeEnabled();
    expect(button).toHaveStyle({ cursor: "pointer", opacity: "1" });
  });

  /**
   * The header's *other* discard: back to HEAD, not back to the last read.
   *
   * Its gate is the gutter's own signal, reused rather than re-derived — the
   * hook's `baseline` is the HEAD blob (`undefined` for an untracked file, a
   * non-repo cwd, or a blob too large/binary to show), and `edit.baseline` is
   * what is on disk. Both are already LF-normalized and already in memory, so
   * "does this file differ from HEAD" is a string compare, not a git spawn.
   */
  describe("discarding a file's git changes", () => {
    it("offers nothing for an untracked file — there is no committed version to restore", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "brand new" }));
      mockedReadBaseline.mockResolvedValue({ state: "untracked" });

      renderViewer();
      await screen.findByRole("textbox");

      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: DISCARD_FILE_RE })
        ).not.toBeInTheDocument();
      });
    });

    it("offers nothing for a tracked file too large to read faithfully — nothing to compare against", async () => {
      // A >1 MB file reads truncated (no `edit` buffer) while its HEAD blob
      // can still be small enough to fetch, so `baseline` alone would render
      // the button — permanently disabled, since the comparison it gates on
      // can never be made. An action that can never fire is worse than one
      // that isn't offered.
      mockedReadFile.mockResolvedValue(
        content({ content: "a\nb", truncated: true })
      );
      mockedReadBaseline.mockResolvedValue({
        content: "committed",
        state: "tracked",
      });

      renderViewer();
      expect(await screen.findByText(TOO_LARGE_RE)).toBeInTheDocument();

      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: DISCARD_FILE_RE })
        ).not.toBeInTheDocument();
      });
    });

    it("offers it, enabled, for a tracked file whose disk content differs from HEAD", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "changed" }));
      mockedReadBaseline.mockResolvedValue({
        content: "committed",
        state: "tracked",
      });

      renderViewer();
      await screen.findByRole("textbox");

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: DISCARD_FILE_RE })
        ).toBeEnabled();
      });
    });

    it("offers it disabled for a tracked file that already matches HEAD", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "same" }));
      mockedReadBaseline.mockResolvedValue({
        content: "same",
        state: "tracked",
      });

      renderViewer();
      await screen.findByRole("textbox");

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: DISCARD_FILE_RE })
        ).toBeDisabled();
      });
    });

    it("confirms first, then restores from HEAD and refreshes the Changes view", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "changed" }));
      mockedReadBaseline.mockResolvedValue({
        content: "committed",
        state: "tracked",
      });

      renderViewer({ cwd: "/repo", path: "src/a.ts", sessionId: "s1" });
      await screen.findByRole("textbox");
      const button = await screen.findByRole("button", {
        name: DISCARD_FILE_RE,
      });
      await waitFor(() => expect(button).toBeEnabled());

      fireEvent.click(button);

      // Destructive and unrecoverable — nothing may reach the backend until
      // the user has said yes.
      expect(mockedDiscardFileChanges).not.toHaveBeenCalled();
      expect(screen.getByText(CANNOT_BE_UNDONE_RE)).toBeInTheDocument();
      expect(screen.getByText(DISCARD_A_TS_TITLE_RE)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: CONFIRM_DISCARD_RE }));

      await waitFor(() => {
        expect(mockedDiscardFileChanges).toHaveBeenCalledWith(
          "/repo",
          "src/a.ts"
        );
      });
      // The clean-buffer revalidation is what adopts the restored content, so
      // the discard's job ends at asking for a refresh.
      await waitFor(() => {
        expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "manual");
      });
    });

    /** A destructive action that fails quietly is worse than one that fails
     * loudly: the file is still modified while the user believes it was
     * restored. The failure branch is the one that most needs a test, and it
     * had none. */
    it("surfaces a failed discard instead of letting it pass for success", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "changed" }));
      mockedReadBaseline.mockResolvedValue({
        content: "committed",
        state: "tracked",
      });
      mockedDiscardFileChanges.mockRejectedValueOnce("git checkout failed");

      renderViewer({ cwd: "/repo", path: "src/a.ts", sessionId: "s1" });
      // The real toast surface, not a spy on `showToast`: what matters is
      // that the failure reaches the screen.
      render(<Toast />);
      await screen.findByRole("textbox");
      const button = await screen.findByRole("button", {
        name: DISCARD_FILE_RE,
      });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      fireEvent.click(screen.getByRole("button", { name: CONFIRM_DISCARD_RE }));

      expect(await screen.findByText(DISCARD_FAILED_RE)).toBeInTheDocument();
      // Nothing was restored, so nothing may claim the view is now stale.
      expect(mockedRequestRefresh).not.toHaveBeenCalledWith("s1", "manual");
    });

    it("does nothing when the confirm is cancelled", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "changed" }));
      mockedReadBaseline.mockResolvedValue({
        content: "committed",
        state: "tracked",
      });

      renderViewer();
      await screen.findByRole("textbox");
      const button = await screen.findByRole("button", {
        name: DISCARD_FILE_RE,
      });
      await waitFor(() => expect(button).toBeEnabled());

      fireEvent.click(button);
      fireEvent.click(screen.getByRole("button", { name: CONFIRM_CANCEL_RE }));

      expect(mockedDiscardFileChanges).not.toHaveBeenCalled();
      expect(screen.queryByText(CANNOT_BE_UNDONE_RE)).not.toBeInTheDocument();
    });
  });

  it("stays read-only for a binary file — no editor, no Save button", async () => {
    mockedReadFile.mockResolvedValue(
      content({ binary: true, content: "", size: 10, truncated: false })
    );

    renderViewer({ path: "img.png" });

    expect(await screen.findByText(BINARY_RE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SAVE_BUTTON_RE })).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("stays read-only for a truncated file — no editor, no Save button", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "a\nb", truncated: true })
    );

    renderViewer({ path: "big.ts" });

    await waitFor(() => {
      expect(
        screen.getByTestId("file-viewer-truncated-notice")
      ).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("file-viewer-line")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: SAVE_BUTTON_RE })).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("stays read-only for a lossy (non-UTF-8) file — no editor, still viewable", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "Hi�", lossy: true }));

    renderViewer({ path: "latin1.txt" });

    await waitFor(() => {
      expect(
        screen.getByTestId("file-viewer-lossy-notice")
      ).toBeInTheDocument();
    });
    expect(screen.getAllByTestId("file-viewer-line").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: SAVE_BUTTON_RE })).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("marks changed lines in the gutter on the read-only truncated path", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "a\nb", truncated: true })
    );
    const fileDiff: FileDiff = {
      binary: false,
      hunks: [
        {
          header: "@@ -1,2 +1,2 @@",
          lines: [
            { kind: "context", text: "a" },
            { kind: "added", text: "b" },
          ],
        },
      ],
      oldPath: null,
      path: "big.ts",
      status: "modified",
    };

    renderViewer({ fileDiff, path: "big.ts" });

    await waitFor(() => {
      expect(screen.getAllByTestId("file-viewer-line")).toHaveLength(2);
    });
    const rows = screen.getAllByTestId("file-viewer-line");
    expect(rows[0]).not.toHaveAttribute("data-changed", "true");
    expect(rows[1]).toHaveAttribute("data-changed", "true");
  });

  it("highlights a truncated file's whole content, not just a visible slice", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "a\nb\nc", truncated: true })
    );

    renderViewer({ path: "big.ts" });

    await waitFor(() => {
      expect(mockedHighlightLines).toHaveBeenCalledWith("a\nb\nc", "text");
    });
  });

  it("skips highlighting and renders plain text past MAX_HIGHLIGHT_LINES on the truncated path", async () => {
    const bigContent = Array.from(
      { length: MAX_HIGHLIGHT_LINES + 1 },
      (_, i) => `line ${i}`
    ).join("\n");
    mockedReadFile.mockResolvedValue(
      content({ content: bigContent, truncated: true })
    );

    renderViewer({ path: "big.ts" });

    expect(await screen.findByText("line 0")).toBeInTheDocument();
    expect(mockedHighlightLines).not.toHaveBeenCalled();
  });

  it("surfaces a read failure without throwing", async () => {
    mockedReadFile.mockRejectedValue(new Error("permission denied"));

    renderViewer();

    await waitFor(() => {
      expect(screen.getByTestId("file-viewer-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("file-viewer-error")).toHaveTextContent(
      "permission denied"
    );
  });

  it("opens a text file in the OS text editor, not the type-default app", async () => {
    mockedReadFile.mockResolvedValue(content());

    renderViewer();
    await screen.findByRole("textbox");

    // The label reads "Open in editor" and must route through `openInEditor`
    // (macOS `open -t`), so an `.html`/`.svg` lands in a text editor instead
    // of a browser — never `openPath`, which uses the type-default app.
    fireEvent.click(screen.getByText("Open in editor"));

    await waitFor(() => {
      expect(mockedOpenInEditor).toHaveBeenCalledWith("/repo", "a.ts");
    });
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  it("opens a binary file in its type-default app, labelled Open", async () => {
    mockedReadFile.mockResolvedValue(
      content({ binary: true, content: "", size: 10, truncated: false })
    );

    renderViewer();
    await screen.findByTestId("file-viewer-binary-notice");

    // A binary has no editable view — a text editor would show gibberish, so
    // the button falls back to the type-default app (a PDF in Preview, an
    // image in the viewer) and is labelled "Open", not "Open in editor".
    expect(screen.queryByText("Open in editor")).toBeNull();
    fireEvent.click(screen.getByText("Open"));

    await waitFor(() => {
      expect(mockedOpenPath).toHaveBeenCalledWith("/repo", "a.ts");
    });
    expect(mockedOpenInEditor).not.toHaveBeenCalled();
  });

  it("attaches a rejection handler to the open promise, so a file gone by click time can't surface as an unhandled rejection", async () => {
    mockedReadFile.mockResolvedValue(content());
    renderViewer();
    await screen.findByRole("textbox");

    // Constructed right before the click (not up front): Node flags a
    // rejected promise as "unhandled" if nothing attaches a `.catch` within
    // the same turn, then separately warns "handled asynchronously" once one
    // finally does — constructing this any earlier than the click that's
    // about to attach the real handler synchronously would trip that first
    // warning purely from the `await findByRole` above, unrelated to what
    // this test actually checks. A real (already-)rejected promise, not a
    // mock resolved/rejected value: spying on its own `.catch` proves the
    // component actually calls it, rather than just proving the click
    // handler ran.
    const rejected = Promise.reject(new Error("no such file"));
    const catchSpy = vi.spyOn(rejected, "catch");
    mockedOpenInEditor.mockReturnValue(rejected);

    fireEvent.click(screen.getByText("Open in editor"));

    await waitFor(() => {
      expect(catchSpy).toHaveBeenCalled();
    });
  });

  describe("dirty guard", () => {
    it("closes immediately when there are no unsaved edits", async () => {
      mockedReadFile.mockResolvedValue(content());
      const onClose = vi.fn();
      renderViewer({ onClose });
      await screen.findByRole("textbox");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTestId("file-viewer-close-guard")
      ).not.toBeInTheDocument();
    });

    it("holds a close behind a discard-confirmation banner when dirty", async () => {
      mockedReadFile.mockResolvedValue(content());
      const onClose = vi.fn();
      renderViewer({ onClose });

      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(onClose).not.toHaveBeenCalled();
      // The wording, not just the banner's presence: it names the file whose
      // draft is about to be thrown away, and that path reaches the banner
      // through the notice the hook builds rather than straight off `target`.
      expect(screen.getByTestId("file-viewer-close-guard")).toHaveTextContent(
        "Unsaved changes to a.ts. Discard them and close?"
      );

      fireEvent.click(screen.getByRole("button", { name: DISCARD_CLOSE_RE }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("cancelling the close-guard banner keeps the draft and never calls onClose", async () => {
      mockedReadFile.mockResolvedValue(content());
      const onClose = vi.fn();
      renderViewer({ onClose });

      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.click(screen.getByRole("button", { name: CANCEL_RE }));

      expect(onClose).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("file-viewer-close-guard")
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("edited");
    });

    it("holds a file switch behind a confirmation banner when the current file is dirty, and does not fetch the new path until confirmed", async () => {
      mockedReadFile.mockResolvedValueOnce(content({ content: "old-a" }));
      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited-a");

      mockedReadFile.mockResolvedValueOnce(content({ content: "fresh-b" }));
      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );

      expect(
        await screen.findByTestId("file-viewer-switch-guard")
      ).toBeInTheDocument();
      // Both paths, in the right roles: the one being left and the one being
      // switched to travel separately (`from`/`to`) through the notice the
      // hook builds, so swapping them would otherwise ship silently.
      expect(screen.getByTestId("file-viewer-switch-guard")).toHaveTextContent(
        "Unsaved changes to a.ts. Discard them and switch to b.ts?"
      );
      // The banner is up — the new path must not have been fetched yet, and
      // the old draft must still be showing (not silently discarded).
      expect(mockedReadFile).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("textbox")).toHaveValue("edited-a");

      fireEvent.click(screen.getByRole("button", { name: DISCARD_SWITCH_RE }));

      await waitFor(() => expect(mockedReadFile).toHaveBeenCalledTimes(2));
      expect(mockedReadFile).toHaveBeenLastCalledWith("/repo", "b.ts");
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("fresh-b");
      });
    });

    it("keeping editing on the switch-guard banner re-asserts the store selection back to the file being edited", async () => {
      useChanges.setState({ ui: { s1: { selectedFile: "a.ts" } } });
      mockedReadFile.mockResolvedValueOnce(content({ content: "old-a" }));
      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited-a");

      // Simulate what a file-tree click already did to the store before
      // this component re-rendered with the new `path` prop.
      useChanges.getState().selectFile("s1", "b.ts");
      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );
      await screen.findByTestId("file-viewer-switch-guard");

      fireEvent.click(screen.getByRole("button", { name: KEEP_EDITING_RE }));

      expect(
        screen.queryByTestId("file-viewer-switch-guard")
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("edited-a");
      expect(mockedReadFile).toHaveBeenCalledTimes(1);
      expect(useChanges.getState().ui.s1?.selectedFile).toBe("a.ts");
    });

    it("a stale save response — resolving after a discard-and-switch — does not seed the newly switched-to file with the old file's content", async () => {
      mockedReadFile.mockResolvedValueOnce(content({ content: "old-a" }));
      let resolveWrite: (result: { len: number; mtime: number }) => void = () =>
        undefined;
      mockedWriteFile.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWrite = resolve;
          })
      );

      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited-a");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

      // Switch away to b.ts while a.ts's write is still in flight.
      mockedReadFile.mockResolvedValueOnce(content({ content: "fresh-b" }));
      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );
      fireEvent.click(
        await screen.findByRole("button", { name: DISCARD_SWITCH_RE })
      );
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("fresh-b");
      });

      // a.ts's write resolves only now, after the switch already completed.
      await act(async () => {
        resolveWrite({ len: 6, mtime: 321 });
        await Promise.resolve();
      });

      // b.ts's own content/path must not be clobbered by a.ts's late
      // response landing under a `target` that has since moved.
      expect(screen.getByTestId("file-viewer-path")).toHaveTextContent("b.ts");
      expect(screen.getByRole("textbox")).toHaveValue("fresh-b");
      expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument();
    });

    it("clears the stuck saving flag after a discard-and-switch mid-save, so Save works again on the newly switched-to file", async () => {
      mockedReadFile.mockResolvedValueOnce(content({ content: "old-a" }));
      let resolveWrite: (result: { len: number; mtime: number }) => void = () =>
        undefined;
      mockedWriteFile.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWrite = resolve;
          })
      );

      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited-a");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      expect(
        screen.getByRole("button", { name: SAVE_OR_SAVING_BUTTON_RE })
      ).toHaveTextContent("Saving…");

      // Switch away to b.ts while a.ts's write is still in flight.
      mockedReadFile.mockResolvedValueOnce(content({ content: "fresh-b" }));
      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );
      fireEvent.click(
        await screen.findByRole("button", { name: DISCARD_SWITCH_RE })
      );
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("fresh-b");
      });

      // b.ts just loaded fresh — the Save button must not be permanently
      // stuck showing "Saving…"/disabled from a.ts's still-in-flight write.
      // Typing should make it dirty and Save should work normally.
      typeInto(screen.getByRole("textbox"), "edited-b");
      const saveButton = screen.getByRole("button", {
        name: SAVE_OR_SAVING_BUTTON_RE,
      });
      expect(saveButton).toHaveTextContent("Save");
      expect(saveButton).not.toHaveTextContent("Saving…");
      expect(saveButton).toBeEnabled();

      // a.ts's write resolving late must not resurrect the stuck flag.
      await act(async () => {
        resolveWrite({ len: 6, mtime: 321 });
        await Promise.resolve();
      });
      expect(
        screen.getByRole("button", { name: SAVE_OR_SAVING_BUTTON_RE })
      ).toBeEnabled();
    });

    it("a stale reload response — resolving after switching to another file — does not seed the newly switched-to file with the old file's content", async () => {
      mockedReadFile.mockResolvedValueOnce(content({ content: "old-a" }));
      mockedWriteFile.mockRejectedValue(new Error(TAGGED_CONFLICT_ERROR));

      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited-a");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

      const reloadButton = await screen.findByRole("button", {
        name: RELOAD_BUTTON_RE,
      });
      let resolveReload: (loaded: FileContent) => void = () => undefined;
      mockedReadFile.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReload = resolve;
          })
      );
      fireEvent.click(reloadButton);

      // Switch away to b.ts while a.ts's reload is still in flight — the
      // failed save left the draft untouched, so it's still dirty and the
      // switch-guard still fires.
      mockedReadFile.mockResolvedValueOnce(content({ content: "fresh-b" }));
      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );
      fireEvent.click(
        await screen.findByRole("button", { name: DISCARD_SWITCH_RE })
      );
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("fresh-b");
      });

      // a.ts's reload resolves only now, after the switch already completed.
      await act(async () => {
        resolveReload(content({ content: "reloaded-a-too-late" }));
        await Promise.resolve();
      });

      expect(screen.getByTestId("file-viewer-path")).toHaveTextContent("b.ts");
      expect(screen.getByRole("textbox")).toHaveValue("fresh-b");
    });

    it("StrictMode-safe: the switch-guard still resolves to exactly one pending target after a double-invoked updater", async () => {
      mockedReadFile.mockResolvedValueOnce(content({ content: "old-a" }));
      const { rerender } = render(
        <StrictMode>
          <FileViewer
            cwd="/repo"
            onClose={vi.fn()}
            path="a.ts"
            sessionId="s1"
          />
        </StrictMode>
      );
      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited-a");

      mockedReadFile.mockResolvedValueOnce(content({ content: "fresh-b" }));
      rerender(
        <StrictMode>
          <FileViewer
            cwd="/repo"
            onClose={vi.fn()}
            path="b.ts"
            sessionId="s1"
          />
        </StrictMode>
      );

      expect(
        await screen.findByTestId("file-viewer-switch-guard")
      ).toBeInTheDocument();
      expect(screen.getAllByTestId("file-viewer-switch-guard")).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: DISCARD_SWITCH_RE }));
      await waitFor(() => {
        expect(screen.getByRole("textbox")).toHaveValue("fresh-b");
      });
    });

    it("shows a missing-on-disk banner when revalidation can no longer read the file, and Close routes through the dirty guard", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "hello" }));
      const onClose = vi.fn();
      renderViewer({ onClose, sessionId: "s1" });

      await screen.findByRole("textbox");
      landRefresh("s1", 1);

      mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      landRefresh("s1", 2);

      const notice = await screen.findByTestId("file-viewer-missing-notice");
      expect(notice).toBeInTheDocument();

      // A clean buffer: Close routes straight through to onClose, same as
      // the plain × path — the missing-file banner adds no guard of its own,
      // it reuses the existing dirty guard.
      fireEvent.click(
        within(notice).getByRole("button", { name: CLOSE_BUTTON_RE })
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps a dirty draft's unsaved-edits message on the missing-on-disk banner and holds Close behind the discard guard", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "hello" }));
      const onClose = vi.fn();
      renderViewer({ onClose, sessionId: "s1" });

      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited");
      landRefresh("s1", 1);

      mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      landRefresh("s1", 2);

      const notice = await screen.findByTestId("file-viewer-missing-notice");
      expect(notice).toHaveTextContent(UNSAVED_EDITS_KEPT_RE);

      // Dirty, so Close goes through the existing discard-confirm banner
      // rather than closing immediately.
      fireEvent.click(
        within(notice).getByRole("button", { name: CLOSE_BUTTON_RE })
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("file-viewer-close-guard")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: DISCARD_CLOSE_RE }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clears the close-confirmation banner once the file stops being dirty (e.g. after Discard edits), instead of leaving it stuck with nothing unsaved", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "original" }));
      const onClose = vi.fn();
      renderViewer({ onClose });

      const textbox = await screen.findByRole("textbox");
      typeInto(textbox, "edited");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByTestId("file-viewer-close-guard")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: DISCARD_EDITS_RE }));

      expect(
        screen.queryByTestId("file-viewer-close-guard")
      ).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  /**
   * The banner matrix, pinned pair by pair.
   *
   * The editing session can raise five banners, and exactly ONE pair of them
   * is mutually exclusive: the close guard outranks the switch guard, because
   * both live in `GuardBanners` and it returns the first that applies. Every
   * other pair genuinely *stacks* — the save-error, stale-on-disk and
   * missing-on-disk banners are independent conditionals rendered in that
   * order — so there is no total precedence order to encode, only one
   * exclusive slot above three independent ones.
   *
   * Two pairs are exclusive along a *particular route* rather than by
   * rendering: a save or a reload that fails `file-missing` clears what it
   * supersedes (`saveError`, and `staleOnDisk` for reload), while a
   * revalidation that fails the same way clears nothing. That asymmetry is
   * behaviour, not accident (see `useFileEditorSession`'s `save`/`reload`
   * `.catch` comments), so it is pinned here too.
   *
   * These are characterization tests: they describe what ships today, so any
   * reshaping of this state into one derived notice has to reproduce it
   * exactly.
   */
  describe("banner shape", () => {
    beforeEach(() => {
      mockedReadFile.mockReset();
      mockedWriteFile.mockReset();
    });

    /**
     * The seven advisory strips in this view (six here, plus `BudgetNotice`)
     * used to be seven hand-rolled style objects, so "unsaved edits" and
     * "that save failed" looked like unrelated kinds of statement. They share
     * one recipe now — see `changes/banner.ts` — and this pins the two tones
     * against the tokens rather than against literal colours, so the next
     * palette move is free.
     */
    it("draws a guard banner in the warn tone and a failure in the error tone", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old" }));
      mockedWriteFile.mockRejectedValue(new Error("permission denied"));
      renderViewer();
      typeInto(await screen.findByRole("textbox"), "edited");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));

      const failure = await screen.findByTestId("file-viewer-save-error");
      expect(failure).toHaveStyle({
        background: tokens.color.status.errorWash,
        color: tokens.color.del,
        minHeight: "34px",
      });

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByTestId("file-viewer-close-guard")).toHaveStyle({
        background: tokens.color.status.waitingWash,
        color: tokens.color.status.waitingInk,
        minHeight: "34px",
      });
    });
  });

  describe("banner precedence and stacking", () => {
    beforeEach(() => {
      // The outer `vi.clearAllMocks()` clears call history but NOT a queued
      // `…Once` implementation, and a switch held behind the guard below
      // never fetches its target — so a leftover queue entry from any earlier
      // test would be handed to the wrong call. Every test here arms `readFile`
      // outright instead.
      mockedReadFile.mockReset();
      mockedWriteFile.mockReset();
    });

    it("shows only the close guard when a switch is pending underneath it", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old-a" }));
      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      typeInto(await screen.findByRole("textbox"), "edited-a");
      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      // The guard holds the switch, so `b.ts` is never fetched — nothing to
      // arm for it (the same is true of every switch-guard test below).
      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );

      expect(shownBanners()).toEqual(["closeGuard"]);

      // Cancelling the close reveals the switch guard that was pending all
      // along — proof the two really were simultaneously true, rather than
      // the switch never having armed.
      fireEvent.click(screen.getByRole("button", { name: CANCEL_RE }));
      expect(shownBanners()).toEqual(["switchGuard"]);
    });

    it("stacks the close guard above a save error", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old" }));
      mockedWriteFile.mockRejectedValue(new Error("permission denied"));
      renderViewer();
      typeInto(await screen.findByRole("textbox"), "edited");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      await screen.findByTestId("file-viewer-save-error");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(shownBanners()).toEqual(["closeGuard", "saveError"]);
    });

    it("stacks the close guard above the stale-on-disk banner", async () => {
      mockedReadFile.mockResolvedValue(
        content({ content: "old", mtime: 111, size: 3 })
      );
      renderViewer({ sessionId: "s1" });
      typeInto(await screen.findByRole("textbox"), "edited");

      mockedReadFile.mockResolvedValue(
        content({ content: "theirs", mtime: 222, size: 6 })
      );
      landRefresh("s1", 1000);
      await screen.findByTestId("file-viewer-stale-notice");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(shownBanners()).toEqual(["closeGuard", "staleOnDisk"]);
    });

    it("stacks the close guard above the missing-on-disk banner", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old" }));
      renderViewer({ sessionId: "s1" });
      typeInto(await screen.findByRole("textbox"), "edited");

      mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      landRefresh("s1", 1000);
      const notice = await screen.findByTestId("file-viewer-missing-notice");

      // The banner's own Close, which routes through the same dirty guard the
      // header × does — the header button shares its accessible name, so this
      // is also the unambiguous one to click once both are on screen.
      fireEvent.click(
        within(notice).getByRole("button", { name: CLOSE_BUTTON_RE })
      );

      expect(shownBanners()).toEqual(["closeGuard", "missingOnDisk"]);
    });

    it("stacks the switch guard above a save error", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old-a" }));
      mockedWriteFile.mockRejectedValue(new Error("permission denied"));
      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      typeInto(await screen.findByRole("textbox"), "edited-a");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      await screen.findByTestId("file-viewer-save-error");

      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );
      await screen.findByTestId("file-viewer-switch-guard");

      expect(shownBanners()).toEqual(["switchGuard", "saveError"]);
    });

    it("stacks the switch guard above the stale-on-disk banner", async () => {
      mockedReadFile.mockResolvedValue(
        content({ content: "old-a", mtime: 111, size: 3 })
      );
      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      typeInto(await screen.findByRole("textbox"), "edited-a");

      mockedReadFile.mockResolvedValue(
        content({ content: "theirs", mtime: 222, size: 6 })
      );
      landRefresh("s1", 1000);
      await screen.findByTestId("file-viewer-stale-notice");

      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );
      await screen.findByTestId("file-viewer-switch-guard");

      expect(shownBanners()).toEqual(["switchGuard", "staleOnDisk"]);
    });

    it("stacks the switch guard above the missing-on-disk banner", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old-a" }));
      const { rerender } = render(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="a.ts" sessionId="s1" />
      );
      typeInto(await screen.findByRole("textbox"), "edited-a");

      mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      landRefresh("s1", 1000);
      await screen.findByTestId("file-viewer-missing-notice");

      rerender(
        <FileViewer cwd="/repo" onClose={vi.fn()} path="b.ts" sessionId="s1" />
      );
      await screen.findByTestId("file-viewer-switch-guard");

      expect(shownBanners()).toEqual(["switchGuard", "missingOnDisk"]);
    });

    it("stacks a save error above the stale-on-disk banner — two Reload buttons", async () => {
      mockedReadFile.mockResolvedValue(
        content({ content: "old", mtime: 111, size: 3 })
      );
      mockedWriteFile.mockRejectedValue(new Error(TAGGED_CONFLICT_ERROR));
      renderViewer({ sessionId: "s1" });
      typeInto(await screen.findByRole("textbox"), "edited");

      mockedReadFile.mockResolvedValue(
        content({ content: "theirs", mtime: 222, size: 6 })
      );
      landRefresh("s1", 1000);
      await screen.findByTestId("file-viewer-stale-notice");

      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      await screen.findByTestId("file-viewer-save-error");

      expect(shownBanners()).toEqual(["saveError", "staleOnDisk"]);
      // Today both banners carry their own Reload. Not a design decision —
      // just what two independent conditionals produce.
      expect(
        screen.getAllByRole("button", { name: RELOAD_BUTTON_RE })
      ).toHaveLength(2);
    });

    it("leaves a save error standing when a later revalidation finds the file gone", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old" }));
      mockedWriteFile.mockRejectedValue(new Error("permission denied"));
      renderViewer({ sessionId: "s1" });
      typeInto(await screen.findByRole("textbox"), "edited");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      await screen.findByTestId("file-viewer-save-error");

      mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      landRefresh("s1", 1000);
      await screen.findByTestId("file-viewer-missing-notice");

      expect(shownBanners()).toEqual(["saveError", "missingOnDisk"]);
    });

    it("replaces a save error when the *save* is what finds the file gone", async () => {
      mockedReadFile.mockResolvedValue(content({ content: "old" }));
      mockedWriteFile.mockRejectedValueOnce(new Error("permission denied"));
      mockedWriteFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      renderViewer();
      typeInto(await screen.findByRole("textbox"), "edited");
      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      await screen.findByTestId("file-viewer-save-error");

      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      await screen.findByTestId("file-viewer-missing-notice");

      expect(shownBanners()).toEqual(["missingOnDisk"]);
    });

    it("leaves the stale-on-disk banner standing when a save finds the file gone", async () => {
      mockedReadFile.mockResolvedValue(
        content({ content: "old", mtime: 111, size: 3 })
      );
      mockedWriteFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      renderViewer({ sessionId: "s1" });
      typeInto(await screen.findByRole("textbox"), "edited");

      mockedReadFile.mockResolvedValue(
        content({ content: "theirs", mtime: 222, size: 6 })
      );
      landRefresh("s1", 1000);
      await screen.findByTestId("file-viewer-stale-notice");

      fireEvent.click(screen.getByRole("button", { name: SAVE_BUTTON_RE }));
      await screen.findByTestId("file-viewer-missing-notice");

      expect(shownBanners()).toEqual(["staleOnDisk", "missingOnDisk"]);
    });

    it("replaces the stale-on-disk banner when the *reload* is what finds the file gone", async () => {
      mockedReadFile.mockResolvedValue(
        content({ content: "old", mtime: 111, size: 3 })
      );
      renderViewer({ sessionId: "s1" });
      typeInto(await screen.findByRole("textbox"), "edited");

      mockedReadFile.mockResolvedValue(
        content({ content: "theirs", mtime: 222, size: 6 })
      );
      landRefresh("s1", 1000);
      await screen.findByTestId("file-viewer-stale-notice");

      mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
      fireEvent.click(screen.getByRole("button", { name: RELOAD_BUTTON_RE }));
      await screen.findByTestId("file-viewer-missing-notice");

      expect(shownBanners()).toEqual(["missingOnDisk"]);
    });
  });
});
