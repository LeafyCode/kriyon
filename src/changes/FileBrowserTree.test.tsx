import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  createDir: vi.fn().mockResolvedValue(undefined),
  createFile: vi.fn().mockResolvedValue(undefined),
  deleteEntry: vi.fn().mockResolvedValue(undefined),
  listDir: vi.fn(),
  findFiles: vi.fn(),
  openInEditor: vi.fn().mockResolvedValue(undefined),
  renameEntry: vi.fn().mockResolvedValue(undefined),
  revealPath: vi.fn().mockResolvedValue(undefined),
}));
// Only the manual-refresh trigger is stubbed; the rest of the coordinator
// stays real so the tree's own `useRevalidateOn` revalidation still runs —
// same arrangement as `FileViewer.test.tsx`.
vi.mock("../state/changesRefresh.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestRefresh: vi.fn(),
}));

import {
  createDir,
  createFile,
  deleteEntry,
  findFiles,
  listDir,
  openInEditor,
  renameEntry,
  revealPath,
} from "../ipc/bridge.ts";
import { type SessionChanges, useChanges } from "../state/changes.ts";
import { requestRefresh } from "../state/changesRefresh.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import type { DirEntry } from "../types.ts";
import { Toast } from "../ui/Toast.tsx";
import { FileBrowserTree } from "./FileBrowserTree.tsx";

const mockedListDir = vi.mocked(listDir);
const mockedFindFiles = vi.mocked(findFiles);
const mockedCreateFile = vi.mocked(createFile);
const mockedCreateDir = vi.mocked(createDir);
const mockedOpenInEditor = vi.mocked(openInEditor);
const mockedRequestRefresh = vi.mocked(requestRefresh);
const mockedRenameEntry = vi.mocked(renameEntry);
const mockedDeleteEntry = vi.mocked(deleteEntry);
const mockedRevealPath = vi.mocked(revealPath);

const NEW_FILE_ITEM_RE = /new file/i;
const NEW_FOLDER_ITEM_RE = /new folder/i;
const OPEN_IN_EDITOR_RE = /open in editor/i;
const NO_EDITOR_RE = /no editor available/;
const REVEAL_RE = /reveal in finder/i;
const COPY_PATH_RE = /^copy path$/i;
const COPY_RELATIVE_RE = /^copy relative path$/i;
const ALREADY_EXISTS_RE = /already exists/i;
const LOADING_RE = /^Loading/;
const RENAME_ITEM_RE = /rename/i;
const DELETE_ITEM_RE = /delete/i;
const CONFIRM_DELETE_RE = /^move to trash$/i;
const CANCEL_RE = /^cancel$/i;
const UNSAVED_RE = /unsaved/i;
const ANOTHER_SESSION_RE = /another session/i;
const PATH_SEPARATOR_RE = /must not contain a path separator/i;
const MORE_MATCHES_RE = /more files match/i;

/** A `bySession` entry whose only interesting field is `fetchedAt` — the
 * "a diff refresh just landed" signal the tree revalidates off. */
function landedAt(fetchedAt: number): SessionChanges {
  return {
    baselineLabel: "",
    collapsed: {},
    diff: null,
    fetchedAt,
    hunkHashes: {},
    status: "ready",
    totals: null,
    viewed: {},
  };
}

/** Stamp a successful diff refresh for `s1` (what `doRefresh` in
 * `state/changesRefresh.ts` does on every landed fetch). */
function landRefresh(fetchedAt: number): void {
  act(() => {
    useChanges.setState((s) => ({
      bySession: { ...s.bySession, s1: landedAt(fetchedAt) },
    }));
  });
}

const rootEntries: DirEntry[] = [
  { ignored: false, isDir: true, name: "src" },
  { ignored: false, isDir: false, name: "README.md" },
];

describe("FileBrowserTree", () => {
  beforeEach(() => {
    useChanges.setState({
      bySession: {},
      dirtyFiles: {},
      expandedDirs: {},
      fileDrafts: {},
      ui: {},
    });
    // Only the cross-session-guard tests below populate this; reset so one
    // of them can't leave a session behind for an unrelated test to trip
    // over.
    useSessions.setState({ sessions: {} });
    mockedListDir.mockReset();
    mockedFindFiles.mockReset();
    // `.mockClear()`, not `.mockReset()`: these three keep their default
    // resolved-`undefined` implementation (set once, in the `vi.mock` factory
    // above) across tests — only each test's own call history needs to start
    // empty, since several tests assert `not.toHaveBeenCalled()` /
    // `toHaveBeenCalledWith(...)` and a prior test's create/refresh call must
    // never leak into that.
    mockedCreateFile.mockClear();
    mockedCreateDir.mockClear();
    mockedOpenInEditor.mockClear();
    mockedRequestRefresh.mockClear();
    mockedRenameEntry.mockClear();
    mockedDeleteEntry.mockClear();
    mockedRevealPath.mockClear();
  });

  it("lists the repo root on mount", async () => {
    mockedListDir.mockResolvedValue(rootEntries);

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(mockedListDir).toHaveBeenCalledWith("/repo", "");
  });

  // Real nesting (src/ containing src/deep/), unlike `rootEntries` above
  // (whose one directory has no directories of its own) — a fixture where an
  // eager recursive walk and a genuinely lazy one would make the same call
  // count is worthless for a laziness test (see the plan's finding 4a). With
  // this fixture, an eager walk would also fetch "src/deep"; a lazy one
  // fetches it only once "deep" is itself expanded, which none of the tests
  // below do.
  const srcEntriesWithNestedDir: DirEntry[] = [
    { ignored: false, isDir: false, name: "main.ts" },
    { ignored: false, isDir: true, name: "deep" },
  ];
  const deepEntries: DirEntry[] = [
    { ignored: false, isDir: false, name: "nested.ts" },
  ];

  function mockNestedTree(): void {
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return Promise.resolve(srcEntriesWithNestedDir);
      }
      if (path === "src/deep") {
        return Promise.resolve(deepEntries);
      }
      return Promise.resolve(rootEntries);
    });
  }

  it("expanding a directory fetches only that directory, never an unexpanded nested one", async () => {
    mockNestedTree();

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("src"));

    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/repo", "src")
    );
    expect(await screen.findByText("deep")).toBeInTheDocument();
    expect(mockedListDir).toHaveBeenCalledTimes(2);
    expect(mockedListDir).not.toHaveBeenCalledWith("/repo", "src/deep");
  });

  it("collapsing and re-expanding does not refetch, and still never touches an unexpanded nested directory", async () => {
    mockNestedTree();

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    const srcRow = await screen.findByText("src");

    fireEvent.click(srcRow);
    await waitFor(() => expect(mockedListDir).toHaveBeenCalledTimes(2));

    fireEvent.click(srcRow);
    fireEvent.click(srcRow);

    await waitFor(() =>
      expect(screen.getByText("main.ts")).toBeInTheDocument()
    );
    expect(mockedListDir).toHaveBeenCalledTimes(2);
    expect(mockedListDir).not.toHaveBeenCalledWith("/repo", "src/deep");
  });

  it("expanding two directories before either resolves costs exactly one listDir call per directory", async () => {
    // Regression test: the expansion effect used to depend on `listings`
    // with a per-run `cancelled` flag, so the re-render caused by expanding
    // the second directory cancelled the first directory's still-in-flight
    // fetch and re-issued it once the effect re-ran — 4 calls for 2
    // directories instead of 2. Deferred (never-auto-resolving) promises
    // here so both fetches are still in flight when the second expansion's
    // re-render happens, which is exactly the race the bug needed.
    let resolveSrc!: (entries: DirEntry[]) => void;
    let resolveReadme!: (entries: DirEntry[]) => void;
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return new Promise((resolve) => {
          resolveSrc = resolve;
        });
      }
      if (path === "other") {
        return new Promise((resolve) => {
          resolveReadme = resolve;
        });
      }
      return Promise.resolve([
        { ignored: false, isDir: true, name: "src" },
        { ignored: false, isDir: true, name: "other" },
      ]);
    });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("other"));

    await waitFor(() => expect(mockedListDir).toHaveBeenCalledTimes(3));

    resolveSrc([{ ignored: false, isDir: false, name: "main.ts" }]);
    resolveReadme([{ ignored: false, isDir: false, name: "readme-ish.ts" }]);

    await waitFor(() =>
      expect(screen.getByText("main.ts")).toBeInTheDocument()
    );
    expect(screen.getByText("readme-ish.ts")).toBeInTheDocument();
    // Still exactly 3: root + src + other, never re-issued.
    expect(mockedListDir).toHaveBeenCalledTimes(3);
  });

  it("a directory listing that lands before the root listing does is not wiped out by it", async () => {
    // Regression test: the root fetch used to call `setListings({ "":
    // entries })`, a hard replace of the whole map, so a directory listing
    // that landed first (e.g. one restored as already-expanded, whose
    // fetch races the root's own) was silently discarded once the root's
    // own listing resolved after it.
    let resolveRoot!: (entries: DirEntry[]) => void;
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "") {
        return new Promise((resolve) => {
          resolveRoot = resolve;
        });
      }
      if (path === "src") {
        return Promise.resolve([
          { ignored: false, isDir: false, name: "main.ts" },
        ]);
      }
      return Promise.resolve(rootEntries);
    });
    useChanges.setState({
      expandedDirs: { s1: { src: true } },
      ui: {},
    });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    // "src" is already expanded via restored store state, so its fetch
    // fires — and can land — independently of, and before, the root's own.
    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/repo", "src")
    );

    resolveRoot(rootEntries);

    expect(await screen.findByText("src")).toBeInTheDocument();
    // The nested listing must have survived the root's later resolution.
    expect(await screen.findByText("main.ts")).toBeInTheDocument();
  });

  it("a stale cwd's still-in-flight root listing never lands in the new cwd's tree", async () => {
    // Regression test: `cancelledRef` used to be a single boolean shared
    // across every `cwd` this component ever saw. On a `cwd` change, React
    // runs the old effect's cleanup (`cancelledRef.current = true`) and then
    // immediately the new effect's body (`cancelledRef.current = false`) —
    // the very same ref — so by the time the OLD cwd's still-in-flight
    // `listDir` call resolved, it read `false` and wrote its stale entries
    // straight into the NEW cwd's `listings`. Worse, once `listings[""]`
    // held that stale entry, the expansion effect's `!(dir in listings)`
    // guard meant the new cwd's own root listing was skipped on next fetch.
    let resolveOld!: (entries: DirEntry[]) => void;
    let resolveNew!: (entries: DirEntry[]) => void;
    mockedListDir.mockImplementation((cwd) => {
      if (cwd === "/old") {
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      if (cwd === "/new") {
        return new Promise((resolve) => {
          resolveNew = resolve;
        });
      }
      return Promise.resolve(rootEntries);
    });

    const { rerender } = render(<FileBrowserTree cwd="/old" sessionId="s1" />);
    await waitFor(() => expect(mockedListDir).toHaveBeenCalledWith("/old", ""));

    rerender(<FileBrowserTree cwd="/new" sessionId="s1" />);
    await waitFor(() => expect(mockedListDir).toHaveBeenCalledWith("/new", ""));

    // Resolve the new cwd's root first, then the old cwd's still-pending
    // root — the exact ordering that reproduces the bug.
    await act(async () => {
      resolveNew([{ ignored: false, isDir: false, name: "NEW_FILE.md" }]);
      await Promise.resolve();
    });
    await act(async () => {
      resolveOld([{ ignored: false, isDir: false, name: "OLD_FILE.md" }]);
      await Promise.resolve();
    });

    expect(await screen.findByText("NEW_FILE.md")).toBeInTheDocument();
    expect(screen.queryByText("OLD_FILE.md")).not.toBeInTheDocument();
  });

  it("a gitignored entry is dimmed", async () => {
    mockedListDir.mockResolvedValue([
      { ignored: true, isDir: false, name: "node_modules.log" },
    ]);

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    const row = await screen.findByText("node_modules.log");
    expect(row.closest("button")).toHaveAttribute("data-ignored", "true");
  });

  it("clicking a file selects it", async () => {
    mockedListDir.mockResolvedValue(rootEntries);

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("README.md"));

    expect(useChanges.getState().ui.s1?.selectedFile).toBe("README.md");
  });

  /** MINOR 6 (final review): spec §6 says right-clicking a row selects it,
   * matching a left-click. */
  it("right-clicking a file selects it", async () => {
    mockedListDir.mockResolvedValue(rootEntries);

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTitle("README.md"));

    expect(useChanges.getState().ui.s1?.selectedFile).toBe("README.md");
  });

  /** A folder has nothing to select — this tree's only "selected" state is
   * `selectedFile`, the file open in the viewer, and asking it to open a
   * directory is not what the spec means. */
  it("right-clicking a folder does not touch the selected file", async () => {
    mockedListDir.mockResolvedValue(rootEntries);

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTitle("src"));

    expect(useChanges.getState().ui.s1?.selectedFile).toBeUndefined();
  });

  it("revalidates the root and every expanded directory when a diff refresh lands", async () => {
    // The tree used to be a photograph: `listings` was reset only on a `cwd`
    // change, and this pane never unmounts — so a file Claude created during
    // the session could never be found, and a deleted one left a ghost row.
    let created = false;
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return Promise.resolve(
          created
            ? [{ ignored: false, isDir: false, name: "new.ts" }]
            : srcEntriesWithNestedDir
        );
      }
      return Promise.resolve(rootEntries);
    });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("src"));
    expect(await screen.findByText("main.ts")).toBeInTheDocument();
    expect(mockedListDir).toHaveBeenCalledTimes(2);

    created = true;
    landRefresh(1000);

    expect(await screen.findByText("new.ts")).toBeInTheDocument();
    expect(screen.queryByText("main.ts")).not.toBeInTheDocument();
    // Root + src re-listed, and nothing else.
    expect(mockedListDir).toHaveBeenCalledTimes(4);
    expect(mockedListDir).not.toHaveBeenCalledWith("/repo", "src/deep");
  });

  it("a landed refresh never walks a collapsed directory (the laziness contract)", async () => {
    mockNestedTree();

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(mockedListDir).toHaveBeenCalledTimes(1);

    landRefresh(1000);

    await waitFor(() => expect(mockedListDir).toHaveBeenCalledTimes(2));
    // Only the root, which is always on screen — never the unexpanded "src".
    expect(mockedListDir).not.toHaveBeenCalledWith("/repo", "src");
  });

  it("a diff that had already landed before this tab mounted does not double-fetch the root", async () => {
    // `FileBrowserTree` mounts lazily on the first visit to the All-files
    // tab, long after the session's first diff landed — the mount's own root
    // fetch is the fresh listing, so revalidating off that same `fetchedAt`
    // would be a pure duplicate.
    mockedListDir.mockResolvedValue(rootEntries);
    useChanges.setState({ bySession: { s1: landedAt(500) } });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(mockedListDir).toHaveBeenCalledTimes(1);
  });

  it("re-lists a directory whose revalidation was skipped for an in-flight call", async () => {
    // A refresh landing while the root listing is still in flight used to be
    // dropped on the floor: the in-flight call was started *before* the
    // change, so its result is a pre-change snapshot, and nothing re-listed
    // until some unrelated refresh happened to land.
    let resolveRoot: (entries: DirEntry[]) => void = () => {
      // Replaced synchronously by the promise below.
    };
    mockedListDir.mockReturnValueOnce(
      new Promise<DirEntry[]>((resolve) => {
        resolveRoot = resolve;
      })
    );
    mockedListDir.mockResolvedValue(rootEntries);

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await waitFor(() => expect(mockedListDir).toHaveBeenCalledTimes(1));

    landRefresh(1000);
    await act(async () => {
      resolveRoot([]);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedListDir).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("src")).toBeInTheDocument();
  });

  it("lets a stale cwd's response clear only its own in-flight marker", async () => {
    // The old `cwd`'s callback deleted from `inFlightRef` *before* checking
    // the generation — and the root effect had already replaced that set for
    // the new `cwd`, so the stale response cleared a marker belonging to a
    // live call and the tree fetched the same directory twice.
    const deferred = new Map<string, (entries: DirEntry[]) => void>();
    mockedListDir.mockImplementation((cwd: string, dir: string) => {
      if (cwd === "/a" && dir === "src") {
        return new Promise<DirEntry[]>((resolve) => {
          deferred.set("a:src", resolve);
        });
      }
      if (cwd === "/b" && dir === "src") {
        return new Promise<DirEntry[]>((resolve) => {
          deferred.set("b:src", resolve);
        });
      }
      return Promise.resolve(rootEntries);
    });
    useChanges.setState({ expandedDirs: { s1: { src: true } } });

    const { rerender } = render(<FileBrowserTree cwd="/a" sessionId="s1" />);
    await waitFor(() => expect(deferred.has("a:src")).toBe(true));

    rerender(<FileBrowserTree cwd="/b" sessionId="s1" />);
    await waitFor(() => expect(deferred.has("b:src")).toBe(true));

    // The abandoned `/a` listing finally answers.
    await act(async () => {
      deferred.get("a:src")?.([]);
      await Promise.resolve();
    });
    // Any re-run of the expansion effect (here: a second directory being
    // expanded) now re-reads the in-flight set.
    act(() => {
      useChanges.setState({ expandedDirs: { s1: { lib: true, src: true } } });
    });

    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/b", "lib")
    );
    const srcCalls = mockedListDir.mock.calls.filter(
      ([cwd, dir]) => cwd === "/b" && dir === "src"
    );
    expect(srcCalls).toHaveLength(1);
  });

  it("shows the dirty dot for the live-dirty path and any stashed draft, but not a clean file", async () => {
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return Promise.resolve([
          { ignored: false, isDir: false, name: "a.ts" },
          { ignored: false, isDir: false, name: "b.ts" },
          { ignored: false, isDir: false, name: "c.ts" },
        ]);
      }
      return Promise.resolve([{ ignored: false, isDir: true, name: "src" }]);
    });
    useChanges.setState({
      dirtyFiles: { s1: "src/a.ts" },
      fileDrafts: {
        s1: {
          "src/b.ts": {
            baseline: "old",
            draft: "new",
            eol: "lf",
            sig: { len: 3, mtime: 1 },
          },
        },
      },
    });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("c.ts");

    const aRow = screen.getByText("a.ts").closest("button");
    const bRow = screen.getByText("b.ts").closest("button");
    const cRow = screen.getByText("c.ts").closest("button");

    expect(
      aRow?.querySelector('[data-testid="tree-dirty-dot"]')
    ).toBeInTheDocument();
    expect(
      bRow?.querySelector('[data-testid="tree-dirty-dot"]')
    ).toBeInTheDocument();
    expect(
      cRow?.querySelector('[data-testid="tree-dirty-dot"]')
    ).not.toBeInTheDocument();
    // An image, not a live region: one `role="status"` per row means every
    // expand announces "Unsaved changes" once per dirty file it reveals.
    // `FileViewer`'s single header dot is the live region that belongs here.
    expect(aRow?.querySelector('[role="img"]')).toBeInTheDocument();
    expect(aRow?.querySelector('[role="status"]')).not.toBeInTheDocument();
  });

  it("a failed listing shows an inline error and does not throw", async () => {
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return Promise.reject(new Error("permission denied"));
      }
      return Promise.resolve(rootEntries);
    });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("src"));

    expect(await screen.findByTestId("file-browser-error")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("strips the Command failure kind leader from a listDir rejection before showing it", async () => {
    // `SandboxRoot::resolve` (sandbox.rs) is shared by `read_file`, `write_file`,
    // AND `list_dir` — a directory deleted between the parent listing and
    // this expand-fetch surfaces the same `"kind:file-missing: "`-tagged
    // error `useFileEditorSession.ts` classifies on. This row has no `kind`
    // reaction of its own, only a message to show, but it must show the
    // human half — never the raw wire text with its leader still attached.
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return Promise.reject(
          new Error("kind:file-missing: path does not exist")
        );
      }
      return Promise.resolve(rootEntries);
    });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("src"));

    const errorRow = await screen.findByTestId("file-browser-error");
    expect(errorRow).toHaveTextContent("Failed to load: path does not exist");
    expect(errorRow).not.toHaveTextContent("kind:file-missing:");
  });

  it("right-clicking a folder offers New File and New Folder", async () => {
    mockedListDir.mockResolvedValue([
      { ignored: false, isDir: true, name: "src" },
    ]);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    fireEvent.contextMenu(await screen.findByTitle("src"));

    expect(
      screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: NEW_FOLDER_ITEM_RE })
    ).toBeInTheDocument();
  });

  it("New File opens a draft row and Enter creates the file inside that folder", async () => {
    mockedListDir.mockResolvedValue([
      { ignored: false, isDir: true, name: "src" },
    ]);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTitle("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "new.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockedCreateFile).toHaveBeenCalledWith("/repo", "src/new.ts");
    });
  });

  // Regression coverage for the brief's named defect: `renderDir` used to
  // append the draft row only after a landed listing's `sorted.map(...)`
  // rows, but "New File" on a collapsed folder expands it — so on the very
  // next render that folder's listing is absent (`Loading…`), and the draft
  // row must still show. This test's folder starts collapsed, so it exercises
  // exactly that path.
  it("the draft row survives its folder still being in the Loading… state", async () => {
    // The folder's own listing is deliberately deferred and never resolved
    // until the end: the first version of this test used `findByTestId`,
    // which retries until the child listing lands, so it only ever observed
    // the landed branch and passed with the loading branch's draft row
    // deleted. Every assertion below the click is synchronous, taken while
    // `Loading…` is provably still the only thing that folder has rendered.
    let resolveSrc!: (entries: DirEntry[]) => void;
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return new Promise<DirEntry[]>((resolve) => {
          resolveSrc = resolve;
        });
      }
      return Promise.resolve([{ ignored: false, isDir: true, name: "src" }]);
    });
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTitle("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    expect(screen.getByText(LOADING_RE)).toBeInTheDocument();
    expect(screen.getByTestId("file-browser-draft")).toBeInTheDocument();

    // ...and it is still there once the listing finally lands, rather than
    // being replaced by the landed branch's rows.
    await act(async () => {
      resolveSrc([{ ignored: false, isDir: false, name: "main.ts" }]);
      await Promise.resolve();
    });
    expect(screen.getByText("main.ts")).toBeInTheDocument();
    expect(screen.getByTestId("file-browser-draft")).toBeInTheDocument();
  });

  // The menu's own `onClose` restores focus to whatever was focused before it
  // opened, and that runs as part of the very same click that opens the
  // draft — so the draft input has to win that race, not just receive an
  // `autoFocus` prop that never actually lands the focus (jsdom does not
  // implement `autofocus`).
  it("focuses the draft input despite the closing menu's own focus restore", async () => {
    mockedListDir.mockResolvedValue([]);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    expect(input).toHaveFocus();
  });

  it("Escape cancels the draft without creating anything", async () => {
    mockedListDir.mockResolvedValue([
      { ignored: false, isDir: true, name: "src" },
    ]);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTitle("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "new.ts" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
    expect(mockedCreateFile).not.toHaveBeenCalled();
  });

  /** A rejected name must stay on screen: retyping it because it vanished into a
   * toast is the failure mode this row exists to avoid. */
  it("a refused name keeps the draft row and shows why", async () => {
    mockedListDir.mockResolvedValue([]);
    mockedCreateFile.mockRejectedValueOnce("already exists");
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "a.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(ALREADY_EXISTS_RE)).toBeInTheDocument();
    expect(screen.getByTestId("file-browser-draft")).toHaveValue("a.txt");
  });

  /** MINOR 7 (final review): typing `a/b.ts` into New File used to reach the
   * backend and come back with `WRITE_MISSING_ERROR` ("path does not exist")
   * — technically accurate about the *parent half* of that name, but useless
   * to a user who just wants to know their file name can't contain a slash.
   * Refused in the frontend instead, with a message that names the real
   * problem, the same way every other refusal on this row does. */
  it("refuses a name containing a path separator without reaching the backend", async () => {
    mockedListDir.mockResolvedValue([]);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "a/b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(PATH_SEPARATOR_RE)).toBeInTheDocument();
    expect(screen.getByTestId("file-browser-draft")).toHaveValue("a/b.ts");
    expect(mockedCreateFile).not.toHaveBeenCalled();
  });

  it("New Folder creates a directory and asks the Changes view to refresh", async () => {
    mockedListDir.mockResolvedValue([]);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FOLDER_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "docs" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockedCreateDir).toHaveBeenCalledWith("/repo", "docs");
    });
    await waitFor(() => {
      expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "manual");
    });
  });

  /** The worst outcome this feature can produce: a file written into a
   * repository the user was not looking at when they typed its name. */
  it("a draft left open across a session switch never commits into the new repo", async () => {
    mockedListDir.mockResolvedValue([]);
    const { rerender } = render(
      <FileBrowserTree cwd="/repoA" sessionId="s1" />
    );
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "oops.txt" } });

    rerender(<FileBrowserTree cwd="/repoB" sessionId="s2" />);
    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/repoB", "")
    );

    // The row goes with the session it was opened in. Without that, the row
    // survives untouched (same `key`, so React keeps the very same DOM
    // node) while every handler on it is a fresh closure over the NEW
    // `cwd`/`sessionId` — and Enter writes `oops.txt` into /repoB.
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockedCreateFile).not.toHaveBeenCalled();
  });

  it("blurring a refused draft dismisses it instead of retrying the failed create", async () => {
    mockedListDir.mockResolvedValue([]);
    mockedCreateFile.mockRejectedValueOnce("already exists");
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "a.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(ALREADY_EXISTS_RE)).toBeInTheDocument();

    fireEvent.blur(input);

    // Committing on blur unconditionally re-fired the identical, failing
    // create on every click away, and the row could never be dismissed.
    expect(mockedCreateFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
  });

  it("Enter followed by a blur before the create resolves fires exactly one create", async () => {
    let resolveCreate!: () => void;
    mockedListDir.mockResolvedValue([]);
    mockedCreateFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        })
    );
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "a.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The draft is still open (the create has not resolved), so the blur's
    // handler still sees it — only the in-flight guard stops the duplicate.
    fireEvent.blur(input);

    expect(mockedCreateFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });
    expect(mockedCreateFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
  });

  it("editing the name clears the rejection it earned", async () => {
    mockedListDir.mockResolvedValue([]);
    mockedCreateFile.mockRejectedValueOnce("already exists");
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "a.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(ALREADY_EXISTS_RE)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "totally-new.txt" } });

    // "already exists" under a name that has never been tried is worse than
    // no message at all.
    expect(screen.queryByText(ALREADY_EXISTS_RE)).not.toBeInTheDocument();
    // The input is uncontrolled: clearing the error must not blank it.
    expect(screen.getByTestId("file-browser-draft")).toHaveValue(
      "totally-new.txt"
    );
  });

  it("collapsing the draft's folder dismisses it rather than resurrecting an empty row", async () => {
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return Promise.resolve([
          { ignored: false, isDir: false, name: "main.ts" },
        ]);
      }
      return Promise.resolve([{ ignored: false, isDir: true, name: "src" }]);
    });
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    const srcRow = await screen.findByTitle("src");
    fireEvent.contextMenu(srcRow);
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));
    expect(await screen.findByText("main.ts")).toBeInTheDocument();
    expect(screen.getByTestId("file-browser-draft")).toBeInTheDocument();

    fireEvent.click(srcRow);
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();

    // The draft used to survive the collapse invisibly and come back, blank
    // and stealing focus, the moment the folder was re-expanded.
    fireEvent.click(srcRow);
    expect(screen.getByText("main.ts")).toBeInTheDocument();
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
  });

  // ---- Rename / Delete (Task 6) -------------------------------------------

  const oneFile: DirEntry[] = [{ ignored: false, isDir: false, name: "a.ts" }];

  /** A root holding `src/`, which holds `a.ts` — the fixture the folder-level
   * rename/delete cases need, where the entry acted on is an *ancestor* of
   * whatever the viewer happens to be showing. */
  function mockFolderWithFile(): void {
    mockedListDir.mockImplementation((_cwd, path) =>
      Promise.resolve(
        path === "src"
          ? [{ ignored: false, isDir: false, name: "a.ts" }]
          : [{ ignored: false, isDir: true, name: "src" }]
      )
    );
  }

  /** Right-click `title`'s row and run the menu item matching `item`. */
  async function runMenuItem(title: string, item: RegExp): Promise<void> {
    fireEvent.contextMenu(await screen.findByTitle(title));
    fireEvent.click(screen.getByRole("menuitem", { name: item }));
  }

  /** A minimal, non-worktree `UiSession` — enough for `sessionWorkingDir` to
   * resolve to `cwd`, which is all the cross-session guard tests below need. */
  function makeSession(id: string, cwd: string): UiSession {
    return {
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 0,
      cwd,
      id,
      projectId: "default",
      status: "idle",
      summary: "",
      title: id,
      titleLocked: false,
      worktreePath: null,
    };
  }

  // ---- Open / Reveal / Copy -----------------------------------------------

  /** Stamp a clipboard onto jsdom's navigator (it ships none) and return the
   * spy. `configurable` so the next test can stamp its own. */
  function stubClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("a file row's menu offers Open in Editor, Reveal in Finder and both copies", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    fireEvent.contextMenu(await screen.findByTitle("a.ts"));

    for (const name of [
      OPEN_IN_EDITOR_RE,
      REVEAL_RE,
      COPY_PATH_RE,
      COPY_RELATIVE_RE,
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  it("a folder row's menu reveals and copies but has no Open in Editor", async () => {
    mockFolderWithFile();
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    fireEvent.contextMenu(await screen.findByTitle("src"));

    expect(screen.getByRole("menuitem", { name: REVEAL_RE })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: COPY_PATH_RE })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: OPEN_IN_EDITOR_RE })
    ).not.toBeInTheDocument();
  });

  it("the empty area's menu stays creates-only", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await screen.findByTitle("a.ts");

    fireEvent.contextMenu(screen.getByTestId("file-browser-empty-area"));

    expect(
      screen.queryByRole("menuitem", { name: REVEAL_RE })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: COPY_PATH_RE })
    ).not.toBeInTheDocument();
  });

  it("Open in Editor hands the file to the editor opener", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    await runMenuItem("a.ts", OPEN_IN_EDITOR_RE);

    expect(mockedOpenInEditor).toHaveBeenCalledWith("/repo", "a.ts");
  });

  it("Reveal in Finder works on folders too", async () => {
    mockFolderWithFile();
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    await runMenuItem("src", REVEAL_RE);

    expect(mockedRevealPath).toHaveBeenCalledWith("/repo", "src");
  });

  it("Copy Path copies the absolute path, Copy Relative Path the repo one", async () => {
    const writeText = stubClipboard();
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

    await runMenuItem("a.ts", COPY_PATH_RE);
    expect(writeText).toHaveBeenCalledWith("/repo/a.ts");

    await runMenuItem("a.ts", COPY_RELATIVE_RE);
    expect(writeText).toHaveBeenLastCalledWith("a.ts");
  });

  it("a failed open surfaces as a toast, not a silent no-op", async () => {
    mockedOpenInEditor.mockRejectedValueOnce(new Error("no editor available"));
    mockedListDir.mockResolvedValue(oneFile);
    render(
      <>
        <FileBrowserTree cwd="/repo" sessionId="s1" />
        <Toast />
      </>
    );

    await runMenuItem("a.ts", OPEN_IN_EDITOR_RE);

    expect(await screen.findByText(NO_EDITOR_RE)).toBeInTheDocument();
  });

  it("Rename seeds the row with the current name and commits the new one", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    const input = await screen.findByTestId("file-browser-draft");
    expect(input).toHaveValue("a.ts");
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockedRenameEntry).toHaveBeenCalledWith("/repo", "a.ts", "b.ts");
    });
    await waitFor(() => {
      expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "manual");
    });
  });

  /** VS Code's own seeding: the stem is selected so typing replaces the name
   * but keeps the extension, and the row must actually hold focus despite the
   * closing menu restoring focus to the row that opened it. */
  it("the rename row holds focus with the stem selected", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    const input =
      await screen.findByTestId<HTMLInputElement>("file-browser-draft");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);
  });

  it("a rename to the unchanged name closes the row without calling the backend", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockedRenameEntry).not.toHaveBeenCalled();
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
  });

  it("Enter followed by a blur before the rename resolves fires exactly one rename", async () => {
    let resolveRename!: () => void;
    mockedListDir.mockResolvedValue(oneFile);
    mockedRenameEntry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        })
    );
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The row is still open (the rename has not resolved), so the blur's
    // handler still sees it — only the in-flight guard stops the duplicate,
    // and a second `renameEntry("/repo", "a.ts", …)` would fail anyway: the
    // source is gone by then.
    fireEvent.blur(input);

    expect(mockedRenameEntry).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRename();
      await Promise.resolve();
    });
    expect(mockedRenameEntry).toHaveBeenCalledTimes(1);
  });

  it("a refused rename keeps the row and shows why, and blurring then dismisses it", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    mockedRenameEntry.mockRejectedValueOnce("already exists");
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(ALREADY_EXISTS_RE)).toBeInTheDocument();
    expect(screen.getByTestId("file-browser-draft")).toHaveValue("b.ts");

    fireEvent.blur(screen.getByTestId("file-browser-draft"));
    expect(mockedRenameEntry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
  });

  /** Reachable whenever a create is still in flight: `commitDraft`'s in-flight
   * guard returns without clearing the draft, so the blur that a right-click
   * fires leaves the create's row open — and the Rename that follows lands on
   * the same `parentDir`. With one shared `key`, React would keep the very
   * same (uncontrolled) `<input>` and its stale typed name, and Enter would
   * rename the file to a name typed for a different purpose entirely. */
  it("a create that fails late keeps its error off a rename opened meanwhile", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    let failCreate: (e: Error) => void = () => undefined;
    mockedCreateFile.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failCreate = reject;
        })
    );
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));
    fireEvent.change(await screen.findByTestId("file-browser-draft"), {
      target: { value: "taken.ts" },
    });
    // Right-clicking blurs the row, which commits the create — in flight.
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    await act(async () => {
      failCreate(new Error("already exists"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("file-browser-draft")).toHaveValue("a.ts");
    expect(screen.queryByText(ALREADY_EXISTS_RE)).not.toBeInTheDocument();
  });

  it("a rename that resolves late leaves a New file row opened meanwhile", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    let finishRename: () => void = () => undefined;
    mockedRenameEntry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRename = () => resolve(undefined);
        })
    );
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);
    const rename = await screen.findByTestId("file-browser-draft");
    fireEvent.change(rename, { target: { value: "b.ts" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    // While the rename is in flight, the toolbar opens a New file row.
    fireEvent.click(screen.getByRole("button", { name: "New file" }));

    await act(async () => {
      finishRename();
      await Promise.resolve();
    });

    expect(screen.getByTestId("file-browser-draft")).toHaveValue("");
  });

  it("Rename re-seeds the row even when a create draft was already open in that folder", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
    fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));
    fireEvent.change(await screen.findByTestId("file-browser-draft"), {
      target: { value: "typed-for-the-create.ts" },
    });

    await runMenuItem("a.ts", RENAME_ITEM_RE);

    expect(await screen.findByTestId("file-browser-draft")).toHaveValue("a.ts");
  });

  it("Delete asks first and moves the entry to the Trash", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", DELETE_ITEM_RE);

    expect(mockedDeleteEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

    await waitFor(() => {
      expect(mockedDeleteEntry).toHaveBeenCalledWith("/repo", "a.ts");
    });
    await waitFor(() => {
      expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "manual");
    });
  });

  it("cancelling the delete confirm does nothing", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", DELETE_ITEM_RE);
    fireEvent.click(screen.getByRole("button", { name: CANCEL_RE }));

    expect(mockedDeleteEntry).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("delete-entry-backdrop")
    ).not.toBeInTheDocument();
  });

  /** The same class of defect as Task 5's draft-across-a-session-switch
   * CRITICAL, one step more destructive: the dialog's own `onConfirm` closes
   * over nothing, so a confirm left standing would call `deleteEntry` with the
   * NEW `cwd` and the OLD path — trashing a file in a repository the user was
   * never looking at. */
  it("a delete confirm left open across a session switch never fires", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    const { rerender } = render(
      <FileBrowserTree cwd="/repoA" sessionId="s1" />
    );
    await runMenuItem("a.ts", DELETE_ITEM_RE);
    expect(screen.getByTestId("delete-entry-backdrop")).toBeInTheDocument();

    rerender(<FileBrowserTree cwd="/repoB" sessionId="s2" />);
    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/repoB", "")
    );

    expect(
      screen.queryByTestId("delete-entry-backdrop")
    ).not.toBeInTheDocument();
    expect(mockedDeleteEntry).not.toHaveBeenCalled();
  });

  /** Renaming the open file must not leave the viewer pointing at a ghost. */
  it("renaming the open file re-points the viewer at its new path", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() => useChanges.getState().selectFile("s1", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);
    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useChanges.getState().ui.s1?.selectedFile).toBe("b.ts");
    });
  });

  it("deleting the open file closes the viewer", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() => useChanges.getState().selectFile("s1", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", DELETE_ITEM_RE);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

    await waitFor(() => {
      expect(useChanges.getState().ui.s1?.selectedFile).toBeUndefined();
    });
  });

  /** Same reasoning one door along: renaming `src/` moves `src/a.ts` with it,
   * so a viewer left on the old path is showing a file that no longer exists
   * under that name. */
  it("renaming a folder re-points a viewer showing a file inside it", async () => {
    mockFolderWithFile();
    act(() => useChanges.getState().selectFile("s1", "src/a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("src", RENAME_ITEM_RE);
    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "lib" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockedRenameEntry).toHaveBeenCalledWith("/repo", "src", "lib");
    });
    await waitFor(() => {
      expect(useChanges.getState().ui.s1?.selectedFile).toBe("lib/a.ts");
    });
  });

  /** A folder is not "the open file", but trashing it takes the open file with
   * it just the same — the viewer must not be left on a path that is gone. */
  it("deleting a folder closes a viewer showing a file inside it", async () => {
    mockFolderWithFile();
    act(() => useChanges.getState().selectFile("s1", "src/a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("src", DELETE_ITEM_RE);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

    await waitFor(() => {
      expect(mockedDeleteEntry).toHaveBeenCalledWith("/repo", "src");
    });
    await waitFor(() => {
      expect(useChanges.getState().ui.s1?.selectedFile).toBeUndefined();
    });
  });

  /** MINOR 2 (final review): `expandedDirs[oldPath]` was never cleared on a
   * successful rename or delete, so every later revalidation reissued a
   * doomed `listDir` for a directory that no longer existed at that path —
   * for the rest of the session's life. */
  it("renaming an expanded folder prunes its stale expandedDirs entry", async () => {
    mockFolderWithFile();
    useChanges.setState({ expandedDirs: { s1: { src: true } } });
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(useChanges.getState().expandedDirs.s1?.src).toBe(true);

    await runMenuItem("src", RENAME_ITEM_RE);
    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "lib" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useChanges.getState().expandedDirs.s1?.src).toBeUndefined();
    });
  });

  /** Same finding, the delete side. */
  it("deleting an expanded folder prunes its stale expandedDirs entry", async () => {
    mockFolderWithFile();
    useChanges.setState({ expandedDirs: { s1: { src: true } } });
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    expect(await screen.findByText("a.ts")).toBeInTheDocument();

    await runMenuItem("src", DELETE_ITEM_RE);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

    await waitFor(() => {
      expect(useChanges.getState().expandedDirs.s1?.src).toBeUndefined();
    });
  });

  /** MINOR 2's companion cleanup: a stale `listings[oldPath]` entry is more
   * than clutter. Left behind, a directory that later lands at the exact same
   * literal path (here: the mock reporting a "src" folder at the root again,
   * as if one were freshly created under the name just vacated by the rename)
   * finds the expansion effect's `!(dir in listings)` guard already satisfied
   * by the stale entry, so it never fetches the new directory's real
   * contents — the tree would show the OLD folder's listing under the NEW
   * one's name, forever. */
  it("a renamed-away folder's stale listing does not leak into a later folder at the same path", async () => {
    let srcCalls = 0;
    mockedListDir.mockImplementation((_cwd, dir) => {
      if (dir === "src") {
        srcCalls += 1;
        return Promise.resolve(
          srcCalls === 1
            ? [{ ignored: false, isDir: false, name: "old.ts" }]
            : [{ ignored: false, isDir: false, name: "new.ts" }]
        );
      }
      return Promise.resolve([{ ignored: false, isDir: true, name: "src" }]);
    });
    useChanges.setState({ expandedDirs: { s1: { src: true } } });

    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    expect(await screen.findByText("old.ts")).toBeInTheDocument();

    await runMenuItem("src", RENAME_ITEM_RE);
    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "lib" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mockedRenameEntry).toHaveBeenCalledWith("/repo", "src", "lib")
    );

    // The mock always reports a "src" folder at the root — as if a fresh one
    // now sits where the renamed one used to be. Expand it.
    await waitFor(() => expect(screen.queryByText("old.ts")).toBeNull());
    fireEvent.click(await screen.findByTitle("src"));

    expect(await screen.findByText("new.ts")).toBeInTheDocument();
    expect(screen.queryByText("old.ts")).not.toBeInTheDocument();
  });

  /** A rename that silently throws away an unsaved draft is a data loss the
   * user did not ask for. Refused up front instead. */
  it("refuses to rename a file with unsaved edits", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() => useChanges.getState().setDirtyFile("s1", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
    // This session is the one with the dirty edits — the "another session"
    // wording belongs only to the cross-session case below.
    expect(screen.queryByText(ANOTHER_SESSION_RE)).not.toBeInTheDocument();
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
    expect(mockedRenameEntry).not.toHaveBeenCalled();
  });

  it("refuses to delete a file with unsaved edits", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() => useChanges.getState().setDirtyFile("s1", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", DELETE_ITEM_RE);

    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
    expect(
      screen.queryByTestId("delete-entry-backdrop")
    ).not.toBeInTheDocument();
    expect(mockedDeleteEntry).not.toHaveBeenCalled();
  });

  /** The dirty guard has to reach *inside* a folder: trashing `src/` destroys
   * the unsaved draft in `src/a.ts` exactly as deleting the file itself would,
   * and the confirm dialog says nothing about unsaved work. */
  it("refuses to delete a folder holding a file with unsaved edits", async () => {
    mockFolderWithFile();
    act(() => useChanges.getState().setDirtyFile("s1", "src/a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("src", DELETE_ITEM_RE);

    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
    expect(mockedDeleteEntry).not.toHaveBeenCalled();
  });

  it("the unsaved-edits refusal can be dismissed", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() => useChanges.getState().setDirtyFile("s1", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    fireEvent.click(await screen.findByTestId("file-browser-refusal"));

    expect(screen.queryByText(UNSAVED_RE)).not.toBeInTheDocument();
  });

  it("a standing refusal is cleared by the next right-click", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() => useChanges.getState().setDirtyFile("s1", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);
    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId("file-browser-empty-area"));

    // The message belongs to the action that earned it; the next right-click
    // is the user moving on from it.
    expect(screen.queryByText(UNSAVED_RE)).not.toBeInTheDocument();
  });

  it("a refusal naming an entry in one repo does not survive a session switch", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() => useChanges.getState().setDirtyFile("s1", "a.ts"));
    const { rerender } = render(
      <FileBrowserTree cwd="/repoA" sessionId="s1" />
    );
    await runMenuItem("a.ts", RENAME_ITEM_RE);
    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();

    rerender(<FileBrowserTree cwd="/repoB" sessionId="s2" />);
    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/repoB", "")
    );

    expect(screen.queryByText(UNSAVED_RE)).not.toBeInTheDocument();
  });

  /** A stashed draft counts as unsaved work too — it is the copy that outlives
   * the pane being evicted, and the tree already draws its dirty dot from it. */
  it("refuses to rename a file whose only unsaved copy is a stashed draft", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    act(() =>
      useChanges.setState({
        fileDrafts: {
          s1: {
            "a.ts": {
              baseline: "old",
              draft: "new",
              eol: "lf",
              sig: { len: 3, mtime: 1 },
            },
          },
        },
      })
    );
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
    expect(mockedRenameEntry).not.toHaveBeenCalled();
  });

  // ---- Fix round 2: cross-session guard, gen-check reversal, stem reselect

  /** The scenario the finding names directly: this user runs several Kriyon
   * sessions against one shared checkout as an everyday arrangement, so a
   * dirty file in session B is exactly as real a hazard to a rename/delete in
   * session A as A's own dirty state would be. */
  it("refuses to rename a file with unsaved edits held by another session sharing this checkout", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    useSessions.setState({
      sessions: {
        s1: makeSession("s1", "/repo"),
        s2: makeSession("s2", "/repo"),
      },
    });
    act(() => useChanges.getState().setDirtyFile("s2", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
    expect(screen.getByText(ANOTHER_SESSION_RE)).toBeInTheDocument();
    expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
    expect(mockedRenameEntry).not.toHaveBeenCalled();
  });

  /** The dirty guard has to reach inside a folder even when what is dirty
   * belongs to a different session: trashing `src/` orphans `src/a.ts`'s
   * draft in session s2 exactly as surely as it would in s1's own. */
  it("refuses to delete a folder holding a file with unsaved edits in another session sharing this checkout", async () => {
    mockFolderWithFile();
    useSessions.setState({
      sessions: {
        s1: makeSession("s1", "/repo"),
        s2: makeSession("s2", "/repo"),
      },
    });
    act(() => useChanges.getState().setDirtyFile("s2", "src/a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("src", DELETE_ITEM_RE);

    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
    expect(mockedDeleteEntry).not.toHaveBeenCalled();
  });

  /** A stashed draft in another session counts too, the same as it does for
   * this session's own stashed drafts. */
  it("refuses to rename a file whose only unsaved copy is a stashed draft in another session sharing this checkout", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    useSessions.setState({
      sessions: {
        s1: makeSession("s1", "/repo"),
        s2: makeSession("s2", "/repo"),
      },
    });
    act(() =>
      useChanges.setState({
        fileDrafts: {
          s2: {
            "a.ts": {
              baseline: "old",
              draft: "new",
              eol: "lf",
              sig: { len: 3, mtime: 1 },
            },
          },
        },
      })
    );
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
    expect(mockedRenameEntry).not.toHaveBeenCalled();
  });

  /** The scan is scoped to sessions `useSessions` can confirm share this
   * checkout — a dirty file in an unrelated repository must not block
   * anything here. */
  it("does not refuse when the dirty file belongs to a session in a different checkout", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    useSessions.setState({
      sessions: {
        s1: makeSession("s1", "/repo"),
        s2: makeSession("s2", "/other-repo"),
      },
    });
    act(() => useChanges.getState().setDirtyFile("s2", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    const input = await screen.findByTestId("file-browser-draft");
    expect(input).toHaveValue("a.ts");
    expect(screen.queryByText(UNSAVED_RE)).not.toBeInTheDocument();
  });

  /** MINOR 3 (final review): an archived session is excluded from the scan,
   * matching `isWorkingSession` (`src/state/sessions.ts`). Archiving does not
   * clear `dirtyFiles`, so a leftover draft there used to refuse a rename
   * while naming a session the user cannot see any more. */
  it("does not refuse when the dirty file belongs to an archived session sharing this checkout", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    useSessions.setState({
      sessions: {
        s1: makeSession("s1", "/repo"),
        s2: { ...makeSession("s2", "/repo"), archivedAt: Date.now() },
      },
    });
    act(() => useChanges.getState().setDirtyFile("s2", "a.ts"));
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", RENAME_ITEM_RE);

    const input = await screen.findByTestId("file-browser-draft");
    expect(input).toHaveValue("a.ts");
    expect(screen.queryByText(UNSAVED_RE)).not.toBeInTheDocument();
  });

  /** Cheap insurance on an action `deleteEntry` cannot undo: the confirm
   * dialog's own window is long enough for the file to go dirty after the
   * menu click that opened it. */
  it("re-checks for unsaved edits immediately before deleting", async () => {
    mockedListDir.mockResolvedValue(oneFile);
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    await runMenuItem("a.ts", DELETE_ITEM_RE);
    expect(screen.getByTestId("delete-entry-backdrop")).toBeInTheDocument();

    // Goes dirty while the confirm dialog is still open.
    act(() => useChanges.getState().setDirtyFile("s1", "a.ts"));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

    expect(mockedDeleteEntry).not.toHaveBeenCalled();
    expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
  });

  /** CONTROLLER RULING (fix round 2): the outer `gen` re-check in
   * `commitRename`'s `.then()` used to suppress this — but the rename really
   * did happen in `/repoA`, under s1, no matter which session is on screen by
   * the time the backend answers. Leaving the OLD session's viewer stuck on a
   * path a rename had already moved is the regression this test guards. */
  it("a rename that resolves after a session switch still re-points the OLD session's viewer", async () => {
    let resolveRename!: () => void;
    mockedListDir.mockResolvedValue(oneFile);
    mockedRenameEntry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        })
    );
    act(() => useChanges.getState().selectFile("s1", "a.ts"));
    const { rerender } = render(
      <FileBrowserTree cwd="/repoA" sessionId="s1" />
    );
    await runMenuItem("a.ts", RENAME_ITEM_RE);
    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    rerender(<FileBrowserTree cwd="/repoB" sessionId="s2" />);
    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/repoB", "")
    );

    await act(async () => {
      resolveRename();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useChanges.getState().ui.s1?.selectedFile).toBe("b.ts");
    });
    expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "manual");
  });

  /** Same ruling, the delete side: a trashed file's OLD session viewer must
   * still close once the call resolves, even after the user has switched
   * away from it. */
  it("a delete that resolves after a session switch still closes the OLD session's viewer", async () => {
    let resolveDelete!: () => void;
    mockedListDir.mockResolvedValue(oneFile);
    mockedDeleteEntry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        })
    );
    act(() => useChanges.getState().selectFile("s1", "a.ts"));
    const { rerender } = render(
      <FileBrowserTree cwd="/repoA" sessionId="s1" />
    );
    await runMenuItem("a.ts", DELETE_ITEM_RE);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

    rerender(<FileBrowserTree cwd="/repoB" sessionId="s2" />);
    await waitFor(() =>
      expect(mockedListDir).toHaveBeenCalledWith("/repoB", "")
    );

    await act(async () => {
      resolveDelete();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useChanges.getState().ui.s1?.selectedFile).toBeUndefined();
    });
    expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "manual");
  });

  /** IMPORTANT 1 (final whole-branch review): `fetchDir`'s `run` used to add
   * `dir` to `inFlightRef` *before* its `settle` callback's `gen` check. A
   * rename/delete that resolves after a `cwd` change calls
   * `fetchDir(parentDir, oldGen)` from its own stale closure (see the two
   * tests above — that call is deliberate and correct). `run` marked the
   * NEW session's directory as in-flight regardless, and `settle`'s `gen`
   * mismatch then made it bail without ever removing it — so that directory
   * stayed "in flight" forever: the expansion effect skips it and every
   * revalidation just parks itself in `pendingRevalRef`, which only that
   * abandoned call's own `settle` drains, and it already bailed. The new
   * session's tree silently stops refreshing until its `cwd` changes again.
   * Fixed by moving the `gen` check to the first line of `run`, before the
   * `inFlightRef` add. */
  it("a rename that resolves after a session switch does not freeze the new session's tree", async () => {
    let resolveRename!: () => void;
    mockedListDir.mockResolvedValue(oneFile);
    mockedRenameEntry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        })
    );

    const { rerender } = render(
      <FileBrowserTree cwd="/repoA" sessionId="s1" />
    );
    await runMenuItem("a.ts", RENAME_ITEM_RE);
    const input = await screen.findByTestId("file-browser-draft");
    fireEvent.change(input, { target: { value: "b.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockedRenameEntry).toHaveBeenCalledWith("/repoA", "a.ts", "b.ts");

    // Switch to a different session on a different repo before the rename
    // resolves, and let ITS OWN root fetch land normally first.
    rerender(<FileBrowserTree cwd="/repoB" sessionId="s2" />);
    await screen.findByTitle("a.ts");
    const rootCallsFor = () =>
      mockedListDir.mock.calls.filter(
        ([cwd, dir]) => cwd === "/repoB" && dir === ""
      ).length;
    const callsBeforeResolve = rootCallsFor();

    // The abandoned rename finally answers — this is where the bug pollutes
    // the NEW session's `inFlightRef` for its root directory.
    await act(async () => {
      resolveRename();
      await Promise.resolve();
    });

    // A diff refresh lands for the NEW session: the tree must still
    // revalidate its root rather than sitting frozen with "" stuck
    // permanently in-flight.
    act(() => {
      useChanges.setState((s) => ({
        bySession: { ...s.bySession, s2: landedAt(1000) },
      }));
    });

    await waitFor(() => {
      expect(rootCallsFor()).toBeGreaterThan(callsBeforeResolve);
    });
  });

  /** The stem-selection effect used to key on the name alone. Right-clicking
   * a different row to open a second `Rename…` first blurs whatever draft row
   * is open (the new context menu steals focus to its own first item) — which
   * ordinarily cancels an unchanged, not-yet-submitted rename outright. The
   * one case that reaches "swap straight from one draft to the next with no
   * intervening `undefined`" is a rename already in flight: `commitRename`'s
   * own in-flight guard (shared with `commitDraft`, see "Rename re-seeds the
   * row even when a create draft was already open in that folder" above)
   * makes that blur a no-op instead of clearing `draft`. `draftRow` then
   * mounts a brand-new `<input>` in a different directory's subtree, but
   * `renaming` reads `"a.ts"` both times, so the old key never changed and
   * the effect didn't re-run for the new node. */
  it("selects the stem again after opening Rename on a different file while the first rename is still in flight", async () => {
    let resolveRename!: () => void;
    mockedListDir.mockImplementation((_cwd, path) => {
      if (path === "src") {
        return Promise.resolve([
          { ignored: false, isDir: false, name: "a.ts" },
        ]);
      }
      if (path === "lib") {
        return Promise.resolve([
          { ignored: false, isDir: false, name: "a.ts" },
        ]);
      }
      return Promise.resolve([
        { ignored: false, isDir: true, name: "lib" },
        { ignored: false, isDir: true, name: "src" },
      ]);
    });
    mockedRenameEntry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        })
    );
    render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
    fireEvent.click(await screen.findByText("lib"));
    fireEvent.click(await screen.findByText("src"));
    await screen.findByTitle("lib/a.ts");
    await screen.findByTitle("src/a.ts");

    await runMenuItem("src/a.ts", RENAME_ITEM_RE);
    const firstInput = await screen.findByTestId("file-browser-draft");
    fireEvent.change(firstInput, { target: { value: "b.ts" } });
    fireEvent.keyDown(firstInput, { key: "Enter" });
    // Not resolved yet, so `committingRef` is still set: the row is still
    // open (`draft` unchanged), exactly like the create-draft-in-flight case
    // above.
    expect(screen.getByTestId("file-browser-draft")).toBeInTheDocument();

    // Switches the open, still-committing draft to a different file — the
    // blur this right-click fires can't cancel it (the in-flight guard), so
    // `draft` goes straight from the src rename to the lib one.
    await runMenuItem("lib/a.ts", RENAME_ITEM_RE);

    const input =
      await screen.findByTestId<HTMLInputElement>("file-browser-draft");
    expect(input).toHaveValue("a.ts");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);

    // Let the abandoned first rename settle so it can't leak into another
    // test.
    await act(async () => {
      resolveRename();
      await Promise.resolve();
    });
  });

  describe("editor-style explorer", () => {
    it("marks the open file's row as selected", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      useChanges.getState().selectFile("s1", "README.md");

      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

      const row = (await screen.findByText("README.md")).closest("button");
      expect(row).toHaveAttribute("aria-current", "true");
      const src = screen.getByText("src").closest("button");
      expect(src).not.toHaveAttribute("aria-current");
    });

    it("paints git marks on changed files and the folders that hold them", async () => {
      mockedListDir.mockResolvedValue(rootEntries);

      render(
        <FileBrowserTree
          cwd="/repo"
          decorations={{
            dirs: new Set(["src"]),
            files: new Map([["README.md", "added" as const]]),
          }}
          sessionId="s1"
        />
      );

      const readme = (await screen.findByText("README.md")).closest("button");
      expect(readme).toHaveAttribute("data-git", "added");
      expect(readme).toHaveTextContent("A");
      const src = screen.getByText("src").closest("button");
      expect(src).toHaveAttribute("data-git", "contains");
    });

    it("opens every folder above a file opened from elsewhere", async () => {
      mockNestedTree();
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      act(() => useChanges.getState().selectFile("s1", "src/deep/nested.ts"));

      expect(await screen.findByText("nested.ts")).toBeInTheDocument();
      expect(useChanges.getState().expandedDirs.s1).toMatchObject({
        src: true,
        "src/deep": true,
      });
    });

    it("collapse folders closes the whole tree", async () => {
      mockNestedTree();
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      fireEvent.click(await screen.findByText("src"));
      expect(await screen.findByText("main.ts")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Collapse folders" }));

      expect(screen.queryByText("main.ts")).not.toBeInTheDocument();
    });

    it("the toolbar's new file opens a naming row at the root", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.click(screen.getByRole("button", { name: "New file" }));

      const input = await screen.findByTestId("file-browser-draft");
      fireEvent.change(input, { target: { value: "x.ts" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(mockedCreateFile).toHaveBeenCalledWith("/repo", "x.ts")
      );
    });

    it("arrow keys walk the rows; right opens a folder and left closes it", async () => {
      mockNestedTree();
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      const src = (await screen.findByText("src")).closest(
        "button"
      ) as HTMLButtonElement;
      src.focus();

      fireEvent.keyDown(src, { key: "ArrowDown" });
      expect(document.activeElement).toHaveTextContent("README.md");
      fireEvent.keyDown(document.activeElement as Element, {
        key: "ArrowUp",
      });
      expect(document.activeElement).toBe(src);

      fireEvent.keyDown(src, { key: "ArrowRight" });
      expect(await screen.findByText("main.ts")).toBeInTheDocument();
      expect(src).toHaveAttribute("aria-expanded", "true");

      // Left from a child goes to its folder; left again closes it.
      const main = screen
        .getByText("main.ts")
        .closest("button") as HTMLButtonElement;
      main.focus();
      fireEvent.keyDown(main, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(src);
      fireEvent.keyDown(src, { key: "ArrowLeft" });
      expect(screen.queryByText("main.ts")).not.toBeInTheDocument();
    });
  });

  describe("search", () => {
    function searchBox(): HTMLInputElement {
      return screen.getByRole("searchbox", { name: "Search files" });
    }

    it("searches the whole project and lists matches in the order the backend ranked them, in place of the tree", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      mockedFindFiles.mockResolvedValue({
        entries: [
          { isDir: false, path: "src/ui/IconButton.tsx" },
          { isDir: false, path: "src/ui/Button.tsx" },
        ],
        truncated: false,
      });
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.change(searchBox(), { target: { value: "button" } });

      const results = await screen.findAllByTestId("file-search-result");
      expect(mockedFindFiles).toHaveBeenCalledWith("/repo", "button");
      expect(results.map((r) => r.getAttribute("data-row-path"))).toEqual([
        "src/ui/IconButton.tsx",
        "src/ui/Button.tsx",
      ]);
      expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    });

    it("opening a result shows the file and puts the tree back", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      mockedFindFiles.mockResolvedValue({
        entries: [{ isDir: false, path: "README.md" }],
        truncated: false,
      });
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.change(searchBox(), { target: { value: "read" } });
      fireEvent.click(await screen.findByTestId("file-search-result"));

      expect(useChanges.getState().ui.s1?.selectedFile).toBe("README.md");
      expect(searchBox()).toHaveValue("");
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    it("Enter opens the top match", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      mockedFindFiles.mockResolvedValue({
        entries: [
          { isDir: false, path: "main.ts" },
          { isDir: false, path: "a/deep/main.ts" },
        ],
        truncated: false,
      });
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.change(searchBox(), { target: { value: "main" } });
      await screen.findAllByTestId("file-search-result");
      fireEvent.keyDown(searchBox(), { key: "Enter" });

      expect(useChanges.getState().ui.s1?.selectedFile).toBe("main.ts");
    });

    it("a folder result opens that folder in the tree", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      mockedFindFiles.mockResolvedValue({
        entries: [{ isDir: true, path: "src" }],
        truncated: false,
      });
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("README.md");

      fireEvent.change(searchBox(), { target: { value: "src" } });
      fireEvent.click(await screen.findByTestId("file-search-result"));

      expect(useChanges.getState().expandedDirs.s1?.src).toBe(true);
      expect(useChanges.getState().ui.s1?.selectedFile).toBeUndefined();
    });

    it("Escape clears the search", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      mockedFindFiles.mockResolvedValue({ entries: [], truncated: false });
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.change(searchBox(), { target: { value: "zzz" } });
      expect(await screen.findByText("No files match.")).toBeInTheDocument();
      fireEvent.keyDown(searchBox(), { key: "Escape" });

      expect(searchBox()).toHaveValue("");
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });

    it("says when the backend cut the list", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      mockedFindFiles.mockResolvedValue({
        entries: [{ isDir: false, path: "f.ts" }],
        truncated: true,
      });
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.change(searchBox(), { target: { value: "f" } });

      expect(await screen.findByText(MORE_MATCHES_RE)).toBeInTheDocument();
    });

    it("Enter pressed before the new answer lands opens the new query's top match, not the old one's", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      mockedFindFiles.mockImplementation((_cwd, query) =>
        Promise.resolve({
          entries: [{ isDir: false, path: `${query}.ts` }],
          truncated: false,
        })
      );
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.change(searchBox(), { target: { value: "app" } });
      await screen.findAllByTestId("file-search-result");
      // Type on and press Enter inside the debounce.
      fireEvent.change(searchBox(), { target: { value: "apps" } });
      fireEvent.keyDown(searchBox(), { key: "Enter" });

      await waitFor(() =>
        expect(useChanges.getState().ui.s1?.selectedFile).toBe("apps.ts")
      );
    });

    it("a slow answer for an older query never replaces a newer one", async () => {
      mockedListDir.mockResolvedValue(rootEntries);
      let answerOld: (v: {
        entries: { isDir: boolean; path: string }[];
        truncated: boolean;
      }) => void = () => undefined;
      mockedFindFiles.mockImplementation((_cwd, query) =>
        query === "ol"
          ? new Promise((resolve) => {
              answerOld = resolve;
            })
          : Promise.resolve({
              entries: [{ isDir: false, path: "new.ts" }],
              truncated: false,
            })
      );
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      await screen.findByText("src");

      fireEvent.change(searchBox(), { target: { value: "ol" } });
      await waitFor(() =>
        expect(mockedFindFiles).toHaveBeenCalledWith("/repo", "ol")
      );
      fireEvent.change(searchBox(), { target: { value: "new" } });
      const resultPaths = () =>
        screen
          .queryAllByTestId("file-search-result")
          .map((r) => r.getAttribute("data-row-path"));
      await waitFor(() => expect(resultPaths()).toEqual(["new.ts"]));
      await act(async () => {
        answerOld({
          entries: [{ isDir: false, path: "old.ts" }],
          truncated: false,
        });
        await Promise.resolve();
      });

      expect(resultPaths()).toEqual(["new.ts"]);
    });
  });
  it("scrolls a file into view when its folders reopen from cache", async () => {
    mockNestedTree();
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
      fireEvent.click(await screen.findByText("src"));
      fireEvent.click(await screen.findByText("deep"));
      await screen.findByText("nested.ts");
      // Listings are cached now; close everything.
      fireEvent.click(screen.getByRole("button", { name: "Collapse folders" }));

      act(() => useChanges.getState().selectFile("s1", "src/deep/nested.ts"));

      await waitFor(() => expect(scrolled).toContain("nested.ts"));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
