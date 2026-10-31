import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BaselineContent,
  readBaseline,
  readFile,
  writeFile,
} from "../ipc/bridge.ts";
import { commandFailure, failureMessage } from "../ipc/failures.ts";
import {
  type EditState,
  type Eol,
  type Signature,
  useChanges,
} from "../state/changes.ts";
import { requestRefresh, useRevalidateOn } from "../state/changesRefresh.ts";
import type { FileContent } from "../types.ts";

export type LoadState =
  | { status: "loading" }
  | { content: FileContent; status: "loaded" }
  | { message: string; status: "error" };

/** A `(cwd, path)` pair identifying which file is actually being fetched /
 * displayed — kept separate from the raw `cwd`/`path` inputs so a switch away
 * from a dirty file can be held behind a confirmation banner instead of
 * silently discarding the draft (see {@link useTarget}). */
export interface Target {
  cwd: string;
  path: string;
}

/** The raw, possibly [Command failure kind]-tagged message — kept
 * un-stripped so `isConflictError`/`isMissingFileError` (both thin wrappers
 * over `commandFailure`) can still classify it downstream. Callers that
 * display this text must run it through `failureMessage` themselves (see
 * `save`/`reload`'s `.catch` below, and the fetch effect's `state.message`)
 * — this alone is not display-safe. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Failed to read file.";
}

function sameTarget(a: Target, b: Target): boolean {
  return a.cwd === b.cwd && a.path === b.path;
}

function computeDirty(edit: EditState | null): boolean {
  return edit !== null && edit.draft !== edit.baseline;
}

const CRLF_GLOBAL = /\r\n/g;
const LF_GLOBAL = /\n/g;

/**
 * The one line-ending convention the editing session speaks — everything
 * between a read and a write is LF, because CodeMirror has already decided
 * that for us: it splits a document on `/\r\n?|\n/` and keeps no `\r`, so the
 * buffer physically cannot hold a CRLF file. Left un-normalized, `baseline`
 * (CRLF, straight off disk) differed from `draft` (LF, echoed back by the
 * editor) on every line of every Windows-line-ending file.
 *
 * The `eol` recorded by {@link detectEol} is what puts it back on save.
 */
export function toLf(text: string): string {
  return text.replace(CRLF_GLOBAL, "\n");
}

/** {@link toLf}'s inverse, applied to a draft on its way to `write_file`. */
function toCrlf(text: string): string {
  return text.replace(LF_GLOBAL, "\r\n");
}

/**
 * The file's own convention, by majority of its line endings.
 *
 * A pure file of either kind round-trips byte-exactly, which is the case that
 * actually matters. Majority — rather than "does it contain a CRLF at all" —
 * is what keeps a mixed file from being rewritten wholesale in whichever
 * direction the test happens to be phrased: one stray CRLF in a
 * thousand-line LF file would otherwise convert the entire file to CRLF on
 * its first save, which is the same silent whole-file rewrite this
 * normalization exists to prevent, only pointed the other way.
 *
 * A mixed file does get normalized toward its majority, and that is
 * unavoidable rather than chosen: CodeMirror strips every `\r` on the way in,
 * so by the time a draft exists the minority endings are already gone and no
 * write can restore them. Following the majority is simply the version of
 * that loss that touches the fewest lines.
 *
 * Ties (equal counts) fall to LF, along with a file that has no newline at
 * all — the same default a new file gets.
 */
function detectEol(text: string): Eol {
  const crlfCount = text.match(CRLF_GLOBAL)?.length ?? 0;
  const totalLf = text.match(LF_GLOBAL)?.length ?? 0;
  // Every CRLF contains an LF, so the bare-LF count is the difference.
  return crlfCount > totalLf - crlfCount ? "crlf" : "lf";
}

/** Byte-identical to `WRITE_CONFLICT_ERROR` in src-tauri/src/file_cmd.rs —
 * the display half of the Reload banner; both sides pin it with a test. No
 * longer what {@link isConflictError} matches on — see its doc comment. */
export const CONFLICT_ERROR_MESSAGE =
  "file changed on disk since it was opened";

/** The Rust `write_file`'s conflict-guard error is the one save failure with
 * its own recovery action (Reload) — every other failure (too-large,
 * binary-on-disk, permission, …) just surfaces as a plain message.
 *
 * A thin wrapper over `commandFailure` (ADR-0006 addendum, [Command failure
 * kind]): `write_file_sync` tags this failure `"kind:save-conflict: "`, and
 * `err` must still carry that leader for this to classify correctly — pass
 * the caught error (or its raw, un-stripped message), never text already run
 * through `failureMessage`. */
function isConflictError(err: unknown): boolean {
  return commandFailure(err) === "saveConflict";
}

/** Byte-identical to `WRITE_MISSING_ERROR` in src-tauri/src/file_cmd.rs —
 * the display half of the deleted-file banner; both sides pin it with a
 * test. No longer what {@link isMissingFileError} matches on — see its doc
 * comment. */
export const MISSING_FILE_ERROR_MESSAGE = "path does not exist";

/** The second save failure with its own recovery affordance (spec P1.4): the
 * file is gone from disk, so the answer isn't "try again" but the same
 * deleted-file banner revalidation raises.
 *
 * A thin wrapper over `commandFailure`, mirroring {@link isConflictError} —
 * same "pass the raw error, not an already-stripped message" requirement.
 * `SandboxRoot::resolve` (`sandbox.rs`) tags this `"kind:file-missing: "` for
 * `read_file`/`list_dir`/`write_file` alike, which is why this classifies a
 * `readFile` rejection (the revalidation/reload paths below) exactly the way
 * it classifies a `writeFile` one. */
function isMissingFileError(err: unknown): boolean {
  return commandFailure(err) === "fileMissing";
}

/**
 * Floor on how often one open file refetches its gutter baseline.
 *
 * Every refetch is a `git` child process (two, counting the size probe), per
 * warm pane — and a busy turn lands a refresh once or twice a second, so
 * following `fetchedAt` unthrottled turns a decoration into sustained fork
 * pressure across every pane that happens to have a file open. What the
 * baseline actually tracks is the HEAD blob, which moves on a commit or a
 * checkout, not on a keystroke: two seconds is already far finer-grained
 * than the thing being followed. Leading-edge only — no trailing refetch is
 * scheduled, because the next landed refresh (there is always one within a
 * turn) does the job, and a missed one costs a slightly stale gutter, not
 * correctness.
 */
export const BASELINE_REFETCH_INTERVAL_MS = 2000;

/**
 * The gutter's baseline text for one `readBaseline` result — `undefined`
 * leaves the gutter off entirely.
 *
 * Only a tracked file with a showable HEAD blob gets a gutter. The other two
 * states both mean "nothing to diff against", and both leave it off:
 *
 * - `notARepo` — a session cwd that isn't a repo has no baseline and never
 *   will (the All-files browser works in any folder).
 * - `untracked` — a file with no HEAD blob yet. An empty-string baseline would
 *   be *arithmetically* right (every line genuinely is new) and is still what
 *   `computeLineChanges` does with one, but it is the wrong thing to draw: it
 *   is one marker per line for the whole file, built synchronously on the main
 *   thread, which is a frozen window on a large file and a solid stripe saying
 *   nothing the file's untracked status doesn't already say. VSCode's
 *   dirty-diff decorations are tracked-files-only for the same reason.
 */
function baselineText(result: BaselineContent): string | undefined {
  if (result.state === "tracked") {
    // LF-normalized for the same reason the draft is (see {@link toLf}): the
    // gutter diffs this against the editor's own document, which has no `\r`
    // in it, so a CRLF HEAD blob would mark every line of the file modified.
    return result.content === null ? undefined : toLf(result.content);
  }
}

/**
 * Resolves which `(cwd, path)` is actually fetched/displayed, holding a
 * switch behind `pendingTarget` instead of adopting it immediately whenever
 * `dirtyRef.current` is true at the moment the raw inputs change. `dirtyRef`
 * is a ref (not a plain boolean) so this hook's effect doesn't need to
 * re-run — and doesn't need to be declared before the state that produces it
 * exists (`useLoadedFile` computes `edit`, which {@link useFileEditorSession}
 * uses to compute `dirty` and write into the same ref this hook holds).
 */
function useTarget(cwd: string, path: string, dirtyRef: { current: boolean }) {
  const [target, setTarget] = useState<Target>(() => ({ cwd, path }));
  const [pendingTarget, setPendingTarget] = useState<Target | null>(null);

  // Mirrors `target` on every render (not just inside the effect below) so
  // the effect can read the current value without needing `target` itself
  // as a dependency — the same "written every render, read fresh async"
  // pattern `dirtyRef` already uses. This is what lets the effect stay a
  // plain side effect instead of calling `setPendingTarget` *inside*
  // `setTarget`'s updater function: state updater functions must be pure,
  // and StrictMode double-invokes them specifically to catch a side effect
  // like that one.
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const next = { cwd, path };
    if (sameTarget(targetRef.current, next)) {
      return;
    }
    if (dirtyRef.current) {
      setPendingTarget(next);
      return;
    }
    setPendingTarget(null);
    setTarget(next);
    // `dirtyRef` is a stable ref identity across the component's lifetime —
    // intentionally not a dependency in the exhaustive sense; its `.current`
    // is read fresh on every invocation regardless.
  }, [cwd, path, dirtyRef]);

  return { pendingTarget, setPendingTarget, setTarget, target };
}

/**
 * The close/switch dirty-guard's click handlers. Takes the raw setters
 * `useTarget`/`useState` already produced rather than owning any state itself.
 */
function useDirtyGuardHandlers({
  dirty,
  discardedRef,
  onClose,
  pendingTarget,
  sessionId,
  setPendingClose,
  setPendingTarget,
  setTarget,
  target,
}: {
  dirty: boolean;
  discardedRef: { current: boolean };
  onClose: () => void;
  pendingTarget: Target | null;
  sessionId: string | undefined;
  setPendingClose: (value: boolean) => void;
  setPendingTarget: (value: Target | null) => void;
  setTarget: (value: Target) => void;
  target: Target;
}) {
  function discardSwitch() {
    if (!pendingTarget) {
      return;
    }
    setTarget(pendingTarget);
    setPendingTarget(null);
  }

  function keepEditing() {
    setPendingTarget(null);
    if (sessionId) {
      useChanges.getState().selectFile(sessionId, target.path);
    }
  }

  function closeClick() {
    if (dirty) {
      setPendingClose(true);
      return;
    }
    onClose();
  }

  function discardClose() {
    // Set before `onClose` so the unmount this triggers can tell a draft the
    // user threw away from one a [Warm pane] eviction took. A ref, not state:
    // `onClose` unmounts in the same commit, so a queued setState would never
    // reach the cleanup.
    discardedRef.current = true;
    setPendingClose(false);
    onClose();
  }

  function cancelClose() {
    setPendingClose(false);
  }

  return { cancelClose, closeClick, discardClose, discardSwitch, keepEditing };
}

/**
 * Fetches `target` and owns the editable-file lifecycle: load state, the
 * `edit` buffer (`null` for binary/truncated/lossy), and the `save`/`revert`/
 * `reload` actions. Re-fetches whenever `target` itself changes — see
 * {@link useTarget} for why that's not simply `cwd`/`path` directly.
 *
 * `sessionId` (when given) is threaded through purely so a successful
 * `save()` can trigger a refresh via `requestRefresh` — the user's own Save
 * is a fourth way the working tree changes, alongside session-becomes-active,
 * a completed Claude tool edit, and the manual Refresh button, and was the
 * only one of the four not wired to any refresh trigger before this (I2,
 * round-two review). Best-effort and fire-and-forget: a refresh failure
 * already routes into the changes store's own error state, so it must never
 * make `save()` itself reject.
 */
function useLoadedFile(
  target: Target,
  sessionId: string | undefined,
  discardedRef: { current: boolean }
) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The file moved on disk while the user had unsaved edits — set by the
  // revalidation effect below. Purely informational: the draft is never
  // touched, so this only tells the user their Reload/Save choice is now a
  // real one.
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  // The file could no longer be read from disk (deleted or moved) the last
  // time revalidation checked — set by the revalidation effect's `.catch`
  // below. Not a skip-condition on its own: each subsequent refresh retries
  // the read, so a transient failure (or the file coming back) self-heals
  // the next time `fetchedAt` bumps.
  const [missingOnDisk, setMissingOnDisk] = useState(false);
  // The HEAD version of the open file, for the editor's git gutter —
  // `undefined` means the gutter stays off (a non-git cwd, an untracked file,
  // a tracked file whose HEAD blob couldn't be shown, or the fetch itself
  // failing/still in flight). See {@link baselineText}. Fetched alongside the
  // content read below, never blocking it and never producing an error state
  // — the gutter is a decoration, not something a failure should ever be
  // surfaced to the user over.
  const [baseline, setBaseline] = useState<string | undefined>(undefined);

  // Mirrors `target` on every render — read fresh inside `save`/`reload`'s
  // `.then`/`.catch` callbacks so a response that resolves after the user
  // has since switched files (the "discard & switch" dirty-guard flow, or a
  // rapid re-select) can detect it's stale and bail, instead of seeding the
  // now-current file with the previous file's content/signature. The fetch
  // effect below already has its own per-request `cancelled` flag for the
  // same reason; `save`/`reload` are imperative (not effects), so they need
  // this ref instead.
  const targetRef = useRef(target);
  targetRef.current = target;

  // This hook instance is gone. Unlike the fetch effect's per-run `cancelled`
  // flag, `fetchBaseline`'s guards below are all refs — they outlive the
  // unmount, so they can tell a *superseded* response from a current one but
  // not a *dead* hook from a live one. A [Warm pane] eviction racing an
  // in-flight `readBaseline` is exactly that case.
  const disposedRef = useRef(false);
  useEffect(
    () => () => {
      disposedRef.current = true;
    },
    []
  );

  // Adopts a freshly-read file: seeds `edit` for a faithfully-read text load
  // (non-binary, non-truncated, non-lossy), or clears it (read-only) for a
  // binary, truncated, or lossy (non-UTF-8) load — anything the editor can't
  // round-trip without corrupting.
  //
  // Also records the `(mtime, len)` the shown content was read at, in
  // `loadedSigRef` — the one place a load is ever adopted, so the revalidation
  // below always compares against what is genuinely on screen, including for a
  // read-only (binary/truncated/lossy) load that has no `edit` to derive it from.
  const loadedSigRef = useRef<Signature | null>(null);
  const applyLoaded = useCallback((loaded: FileContent) => {
    loadedSigRef.current = { len: loaded.size, mtime: loaded.mtime };
    setState({ content: loaded, status: "loaded" });
    setSaveError(null);
    setStaleOnDisk(false);
    setMissingOnDisk(false);
    if (loaded.binary || loaded.truncated || loaded.lossy) {
      setEdit(null);
      return;
    }
    const text = toLf(loaded.content);
    setEdit({
      baseline: text,
      draft: text,
      eol: detectEol(loaded.content),
      sig: { len: loaded.size, mtime: loaded.mtime },
    });
  }, []);

  // The one place `readBaseline` is called from — the initial open and every
  // revalidation alike — so the two guards it needs can't be applied one way
  // in one caller and another way in the next:
  //
  // - A monotonic request id. Both callers only ever checked "is this still
  //   the same file?", which a *second fetch of the same file* passes by
  //   construction: a slow first response landing after a fast second one
  //   silently reinstated the older HEAD. Only the newest issued fetch may
  //   write `baseline`.
  // - The refetch timestamp behind {@link BASELINE_REFETCH_INTERVAL_MS}
  //   (recorded here, enforced by the revalidation caller — an open is never
  //   throttled).
  const baselineReqRef = useRef(0);
  const lastBaselineFetchRef = useRef(0);
  const fetchBaseline = useCallback((cwd: string, path: string) => {
    baselineReqRef.current += 1;
    const req = baselineReqRef.current;
    lastBaselineFetchRef.current = Date.now();
    readBaseline(cwd, path)
      .then((b) => {
        if (
          disposedRef.current ||
          baselineReqRef.current !== req ||
          !sameTarget(targetRef.current, { cwd, path })
        ) {
          return;
        }
        setBaseline(baselineText(b));
      })
      .catch(() => {
        // The gutter is a decoration, never an error state — a failed
        // baseline fetch just leaves it as it was (off, on the open path).
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setEdit(null);
    setSaveError(null);
    setStaleOnDisk(false);
    setMissingOnDisk(false);
    setBaseline(undefined);
    loadedSigRef.current = null;
    // A target change always clears a leftover in-flight-save flag for the
    // newly-shown file — `save`'s own `.finally` only resets `saving` when
    // its target is still current (the staleness guard), so a save that was
    // still in flight at the moment of a discard-and-switch would otherwise
    // leave `saving` stuck `true` forever, permanently disabling Save with
    // no error banner explaining why.
    setSaving(false);
    readFile(target.cwd, target.path)
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        applyLoaded(loaded);
        // A [File draft] stashed when this pane was evicted comes back exactly
        // as it was — baseline and read-time signature included — so the Save
        // conflict guard, not this restore, is still what decides whether the
        // draft can land on a file that moved meanwhile. Skipped when the
        // fresh read is no longer editable (it turned binary/truncated/lossy),
        // since `applyLoaded` has already made this a read-only view.
        const stashed = sessionId
          ? useChanges.getState().takeFileDraft(sessionId, target.path)
          : undefined;
        if (stashed && !(loaded.binary || loaded.truncated || loaded.lossy)) {
          // Re-normalized on the way back in, and re-tagged with the *fresh*
          // read's line ending: `eol` describes the file as it is on disk
          // now, not as it was when the pane was evicted, so a file converted
          // while this pane was cold saves back in its current convention.
          setEdit({
            ...stashed,
            baseline: toLf(stashed.baseline),
            draft: toLf(stashed.draft),
            eol: detectEol(loaded.content),
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          // `failureMessage`: a leader-tagged failure here is unusual (this
          // is the initial load, before the file has a known signature to
          // conflict against) but not impossible — a file deleted between
          // the browser listing it and this open reaching disk would surface
          // `readFile`'s `"kind:file-missing: "`-tagged error — so this
          // banner must strip it the same way every other display path does.
          setState({
            message: failureMessage(errorMessage(error)),
            status: "error",
          });
        }
      });
    // Fired alongside the content read, not chained after it — the gutter
    // has nothing to wait on and must never hold up (or fail because of) the
    // file actually opening.
    fetchBaseline(target.cwd, target.path);
    return () => {
      cancelled = true;
    };
  }, [target.cwd, target.path, applyLoaded, sessionId, fetchBaseline]);

  // Mirrors `edit` every render so the unmount cleanup below — which runs once,
  // with the closure it was created with — can read the final draft.
  const editRef = useRef(edit);
  editRef.current = edit;

  const staleOnDiskRef = useRef(false);
  staleOnDiskRef.current = staleOnDisk;

  // Revalidate the open file whenever a diff refresh lands for this session —
  // through {@link useRevalidateOn}, the same protocol (and the same epoch)
  // `FileBrowserTree` re-lists its tree on.
  //
  // Without this the viewer was a photograph: the fetch effect above runs only
  // on a `target` change, so a file Claude edited while it was open kept
  // showing the content it had when the user opened it, and — worse — kept the
  // `(mtime, len)` it was read at, so the first Save failed the conflict guard
  // over a change the user could not see and had not made.
  //
  // Three bounds — this view's own, which is why they stay here rather than
  // in the shared protocol — keep the *content* half from costing anything it
  // shouldn't:
  // - An unchanged signature re-seeds nothing, so the once-or-twice-a-second
  //   refresh cadence of a busy turn never fights the user's cursor.
  // - A dirty buffer is never overwritten. The draft stays exactly as typed
  //   and `staleOnDisk` says so; reloading is the user's call.
  // - Once flagged stale it stops re-reading until the user resolves it (or
  //   opens another file) — the flag can't change, so the reads would be pure
  //   waste for as long as the draft sits there.
  //
  // The gutter baseline is fetched *above* all three, because none of them
  // apply to it: HEAD moves independently of the working-tree file (a commit
  // doesn't touch its mtime), and a dirty draft beside a file that moved is
  // precisely the state where a frozen gutter misleads most. Its own bound is
  // {@link BASELINE_REFETCH_INTERVAL_MS} instead.
  useRevalidateOn(sessionId, () => {
    const revalidatedFor = targetRef.current;
    if (
      Date.now() - lastBaselineFetchRef.current >=
      BASELINE_REFETCH_INTERVAL_MS
    ) {
      fetchBaseline(revalidatedFor.cwd, revalidatedFor.path);
    }
    if (staleOnDiskRef.current) {
      return;
    }
    readFile(revalidatedFor.cwd, revalidatedFor.path)
      .then((loaded) => {
        if (!sameTarget(targetRef.current, revalidatedFor)) {
          return;
        }
        // The read succeeded, so the file is back — even if the rest of
        // this handler bails out below (unchanged signature, or a dirty
        // draft that only gets flagged stale).
        setMissingOnDisk(false);
        const sig = loadedSigRef.current;
        if (sig && sig.mtime === loaded.mtime && sig.len === loaded.size) {
          return;
        }
        const { current } = editRef;
        if (current && current.draft !== current.baseline) {
          setStaleOnDisk(true);
          return;
        }
        applyLoaded(loaded);
      })
      .catch((error: unknown) => {
        // A file that vanished or became unreadable between the refresh and
        // this read is not worth blowing away a working view for — the
        // draft stays untouched and the next refresh (or an explicit
        // Reload) retries, so a transient failure self-heals. Only flag it
        // when this read is still for the file actually being shown; a
        // switch away in the meantime makes the failure moot.
        //
        // And only for the *one* failure the banner actually describes: it
        // says "deleted or moved", so a permission error, an IPC hiccup or a
        // cwd that stopped being a repo must stay on the silent-retry path
        // rather than confidently mis-diagnosing a file that is still there.
        if (
          sameTarget(targetRef.current, revalidatedFor) &&
          isMissingFileError(error)
        ) {
          setMissingOnDisk(true);
        }
      });
  });

  // Stash a dirty draft on the way out. Unmounting is not something the user
  // asked for: the [Warm pane] LRU evicts this pane when they visit enough
  // other sessions, and before this the draft simply vanished with it, with no
  // dirty guard in the path. A draft they *did* choose to throw away sets
  // `discardedRef` first, so only the involuntary case is kept.
  useEffect(
    () => () => {
      const { current } = editRef;
      if (
        sessionId &&
        !discardedRef.current &&
        current &&
        current.draft !== current.baseline
      ) {
        useChanges
          .getState()
          .stashFileDraft(sessionId, targetRef.current.path, current);
      }
    },
    [sessionId, discardedRef]
  );

  function save() {
    if (!edit || saving) {
      return;
    }
    setSaving(true);
    const { draft } = edit;
    // What actually goes to disk: the draft with the file's own line endings
    // put back (see {@link toLf}). Kept separate from `draft` itself, which
    // is what the post-save baseline below becomes — the buffer stays LF, so
    // `dirty` keeps comparing like with like. `result.len`/`result.mtime`
    // come back from the write, so the conflict signature is the real
    // on-disk one either way.
    const bytes = edit.eol === "crlf" ? toCrlf(draft) : draft;
    const savedFor = target;
    writeFile(target.cwd, target.path, bytes, edit.sig.mtime, edit.sig.len)
      .then((result) => {
        if (!sameTarget(targetRef.current, savedFor)) {
          return;
        }
        // Merge into the *live* `edit`, never overwrite it wholesale: the
        // user may have kept typing while this write was in flight (the
        // Save button disables, but the editor itself stays writable), and
        // clobbering `draft` back to the pre-save snapshot would silently
        // discard those keystrokes. Only `baseline`/`sig` move to what was
        // actually just written — `dirty` (draft !== baseline) then
        // correctly stays true if the user kept typing, false if they
        // didn't.
        setEdit((current) =>
          current
            ? {
                ...current,
                baseline: draft,
                sig: { len: result.len, mtime: result.mtime },
              }
            : current
        );
        // The revalidation effect compares its re-read against this, not
        // `edit.sig` — without updating it here, the refresh a save itself
        // triggers (`requestRefresh` below) sees the write as an external
        // change and can flag `staleOnDisk` for the user's own save.
        loadedSigRef.current = { len: result.len, mtime: result.mtime };
        setSaveError(null);
        // The write landed, so the file demonstrably exists — a
        // deleted-file banner raised by an earlier save or revalidation is
        // stale the moment this resolves (the file came back, or the user's
        // own tooling recreated it) and must not outlive it.
        setMissingOnDisk(false);
        if (sessionId) {
          // A user Save is a fourth way the working tree changes; route it
          // through the one refresh coordinator like every other trigger.
          requestRefresh(sessionId, "saved");
        }
      })
      .catch((error: unknown) => {
        if (!sameTarget(targetRef.current, savedFor)) {
          return;
        }
        // The file being gone is not a "save failed, try again" error — it's
        // the deleted-file state, with its own banner and its own Close/keep-
        // draft recovery (spec P1.4). Routed *instead of* `saveError`, not
        // alongside it: both would stack two banners saying the same thing,
        // one of them raw backend wording. The draft itself is untouched
        // either way, so nothing is lost by preferring the clearer one.
        if (isMissingFileError(error)) {
          setSaveError(null);
          setMissingOnDisk(true);
          return;
        }
        // Kept un-stripped (see `errorMessage`'s doc comment): the saveError
        // [File viewer notice] needs the leader to decide `canReload` via
        // `isConflictError`, and strips it only once that is settled.
        setSaveError(errorMessage(error));
      })
      .finally(() => {
        if (sameTarget(targetRef.current, savedFor)) {
          setSaving(false);
        }
      });
  }

  function revert() {
    setEdit((current) =>
      current ? { ...current, draft: current.baseline } : current
    );
  }

  function reload() {
    setSaveError(null);
    const reloadedFor = target;
    readFile(target.cwd, target.path)
      .then((loaded) => {
        if (!sameTarget(targetRef.current, reloadedFor)) {
          return;
        }
        applyLoaded(loaded);
      })
      .catch((error: unknown) => {
        if (!sameTarget(targetRef.current, reloadedFor)) {
          return;
        }
        // Same branch `save()` takes, for the same reason: Reload is the
        // button on the stale/conflict banner, and the file being gone means
        // there is nothing to reload *to*. Raw "path does not exist" in
        // `saveError` stacked a second banner over the first with no way out
        // of either; the deleted-file banner has the Close/keep-draft
        // recovery, so clear the stale flag and hand the user that instead.
        if (isMissingFileError(error)) {
          setSaveError(null);
          setStaleOnDisk(false);
          setMissingOnDisk(true);
          return;
        }
        // Kept un-stripped — see the matching comment in `save()`'s `.catch`.
        setSaveError(errorMessage(error));
      });
  }

  return {
    baseline,
    edit,
    missingOnDisk,
    reload,
    revert,
    save,
    saveError,
    saving,
    setEdit,
    staleOnDisk,
    state,
  };
}

/**
 * One banner the editing session wants shown, carrying everything the view
 * needs to draw it — a [File viewer notice].
 *
 * {@link useFileEditorSession} returns these as an ordered *list*, not a
 * single winner, because that is what the viewer genuinely does. Only the two
 * guard notices are mutually exclusive — a close raised over a pending switch
 * hides that switch until the close is answered — and {@link guardNotice} is
 * the one place that choice is made, so "both at once" is not a value this
 * module can produce. The other three are independent facts about the same
 * file (a save failed / it moved / it vanished) and any combination can hold,
 * so the viewer stacks them. Forcing a total precedence order would silently
 * swallow banners the user still needs; `FileViewer.test.tsx`'s precedence
 * matrix pins every pair.
 *
 * List order is render order: guard, save error, stale, missing.
 *
 * Content notices (binary / truncated / lossy) deliberately live outside this
 * union. They describe the *file*, not the session, never contend with these,
 * and are read straight off the load state.
 */
export type FileViewerNotice =
  | { kind: "closeGuard"; path: string }
  | { from: string; kind: "switchGuard"; to: string }
  | { canReload: boolean; kind: "saveError"; message: string }
  | { kind: "staleOnDisk" }
  | { dirty: boolean; kind: "missingOnDisk" };

/**
 * The at-most-one guard banner — the whole of the exclusivity that used to be
 * an ordering convention inside `FileViewer`'s `GuardBanners`. A close
 * confirmation outranks a pending switch: the user just asked to throw the
 * draft away, and answering that decides the switch too.
 */
function guardNotice(
  pendingClose: boolean,
  pendingTarget: Target | null,
  target: Target
): Extract<FileViewerNotice, { kind: "closeGuard" | "switchGuard" }> | null {
  if (pendingClose) {
    return { kind: "closeGuard", path: target.path };
  }
  if (pendingTarget) {
    return { from: target.path, kind: "switchGuard", to: pendingTarget.path };
  }
  return null;
}

/** Every notice currently raised, in render order — see
 * {@link FileViewerNotice} for why this is a list. */
function fileViewerNotices({
  dirty,
  missingOnDisk,
  pendingClose,
  pendingTarget,
  saveError,
  staleOnDisk,
  target,
}: {
  dirty: boolean;
  missingOnDisk: boolean;
  pendingClose: boolean;
  pendingTarget: Target | null;
  /** Still leader-tagged — see `errorMessage` — so `canReload` below can
   * classify it before `failureMessage` strips it for display. */
  saveError: string | null;
  staleOnDisk: boolean;
  target: Target;
}): FileViewerNotice[] {
  const notices: FileViewerNotice[] = [];
  const guard = guardNotice(pendingClose, pendingTarget, target);
  if (guard) {
    notices.push(guard);
  }
  if (saveError !== null) {
    // The one place a save failure's leader is ever stripped: `isConflictError`
    // above needs the raw form, this notice is the only thing that renders the
    // text.
    notices.push({
      canReload: isConflictError(saveError),
      kind: "saveError",
      message: failureMessage(saveError),
    });
  }
  if (staleOnDisk) {
    notices.push({ kind: "staleOnDisk" });
  }
  if (missingOnDisk) {
    notices.push({ dirty, kind: "missingOnDisk" });
  }
  return notices;
}

/**
 * The whole editable-file state machine behind one interface, so `FileViewer`
 * is left as chrome that only renders. Owns loading, the edit draft, save/
 * revert/reload, the `(mtime, len)` conflict guard, dirty tracking, and the
 * close/switch dirty guard — everything that can be exercised without
 * rendering any UI, which is what makes it testable on its own.
 */
export function useFileEditorSession(
  cwd: string,
  path: string,
  onClose: () => void,
  sessionId?: string
) {
  const [pendingClose, setPendingClose] = useState(false);

  // Written every render (below, once `edit` is known) rather than inside an
  // effect, so `useTarget`'s switch-guard effect — which may run before this
  // render's `dirty` would otherwise reach it — always sees the latest flag.
  const dirtyRef = useRef(false);
  // Set synchronously by `discardClose` — see there for why it can't be state.
  const discardedRef = useRef(false);
  const { pendingTarget, setPendingTarget, setTarget, target } = useTarget(
    cwd,
    path,
    dirtyRef
  );
  const {
    baseline,
    edit,
    missingOnDisk,
    reload,
    revert,
    save,
    saveError,
    saving,
    setEdit,
    staleOnDisk,
    state,
  } = useLoadedFile(target, sessionId, discardedRef);

  const dirty = computeDirty(edit);
  dirtyRef.current = dirty;

  // Publish the live dirty path to the store so `FileBrowserTree` can show
  // the unsaved-changes dot without importing this hook — see
  // `ChangesState.dirtyFiles`.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    useChanges.getState().setDirtyFile(sessionId, dirty ? target.path : null);
  }, [dirty, sessionId, target.path]);
  // Clear the live flag on unmount — a stashed draft (see `useLoadedFile`'s
  // own unmount effect above) stays visible via `fileDrafts` regardless.
  useEffect(
    () => () => {
      if (sessionId) {
        useChanges.getState().setDirtyFile(sessionId, null);
      }
    },
    [sessionId]
  );

  // The × button only ever sets `pendingClose` while `dirty` (see
  // `closeClick`), but nothing else cleared it once the file stopped being
  // dirty by another route ("Discard edits", or a successful Save) — so a
  // click-×-then-discard left the "Discard and close?" banner on screen with
  // nothing left to discard. Clearing it here reacts uniformly to whatever
  // made `dirty` go false.
  useEffect(() => {
    if (!dirty) {
      setPendingClose(false);
    }
  }, [dirty]);

  const guard = useDirtyGuardHandlers({
    dirty,
    discardedRef,
    onClose,
    pendingTarget,
    sessionId,
    setPendingClose,
    setPendingTarget,
    setTarget,
    target,
  });

  // `saveError` (from `useLoadedFile`) is deliberately still leader-tagged
  // here — see `errorMessage`'s doc comment — so `fileViewerNotices` can
  // classify Rust's `"kind:save-conflict: "` tag before stripping it.
  const notices = fileViewerNotices({
    dirty,
    missingOnDisk,
    pendingClose,
    pendingTarget,
    saveError,
    staleOnDisk,
    target,
  });

  return {
    baseline,
    dirty,
    edit,
    guard,
    notices,
    reload,
    revert,
    save,
    saving,
    setEdit,
    state,
    target,
  };
}
