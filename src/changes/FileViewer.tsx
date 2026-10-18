import { type CSSProperties, useMemo, useState } from "react";
import { discardFileChanges, openInEditor, openPath } from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import type { EditState } from "../state/changes.ts";
import { requestRefresh } from "../state/changesRefresh.ts";
import { button, iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { showToast } from "../ui/Toast.tsx";
import { banner, bannerDot } from "./banner.ts";
import { CodeEditor } from "./CodeEditor.tsx";
import { FileIcon } from "./fileIcon.tsx";
import { langForPath } from "./highlighter.ts";
import { ReadOnlyFileView } from "./ReadOnlyFileView.tsx";
import {
  type FileViewerNotice,
  useFileEditorSession,
} from "./useFileEditorSession.ts";

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
};

/** A 46px column header on the shared rhythm, hairline below, flat — the
 * same bar the session column and the Details rail wear, so the viewer reads
 * as a third column rather than a panel that opened inside one. */
const headerRowStyle: CSSProperties = {
  alignItems: "center",
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  fontFamily: tokens.font.sans,
  gap: tokens.space.sm,
  height: "46px",
  padding: `0 ${tokens.space.md}`,
};

/**
 * The header's path block: filename first and legible, directory behind it as
 * muted context.
 *
 * It used to be the whole repo-relative path in one flat mono run at one
 * weight, which put `src/changes/` and `FileViewer.tsx` at equal visual
 * priority — so the one thing you actually need to read (which file is this?)
 * had to be picked out of a string, and on a deep path the filename was the
 * part the ellipsis ate.
 */
const pathBlockStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  flex: 1,
  gap: "6px",
  minWidth: 0,
  overflow: "hidden",
};

const fileNameStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  flex: "none",
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  // 500, not 600: the UI face ships 400/500/700, and a 600 is synthesized.
  fontWeight: 500,
};

/** The directory, truncated from the *left* (`…/changes/`) rather than the
 * right: a path's tail is what locates it, so clipping the front keeps the
 * useful end and drops the redundant repo-root prefix. */
const fileDirStyle: CSSProperties = {
  // `muted`, not `faint`: the directory is context but it is still read, and
  // `faint` is below AA on this plane (ADR-0023).
  color: tokens.color.ink.muted,
  direction: "rtl",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  minWidth: 0,
  overflow: "hidden",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** The header's and the banners' shared control: the 24px secondary button
 * from `recipes.ts`, so a `Reload` inside a banner and an `Open in editor`
 * in the header are visibly the same kind of thing. */
const actionButtonStyle: CSSProperties = button("secondary", "sm");

/**
 * The one "you can't press this" treatment the header's action buttons share:
 * faint ink, no pointer, and the same 0.6 wash.
 *
 * Save already had it; the discard buttons did not, so a clean buffer offered
 * a `Revert` that looked exactly as pressable as a dirty one's and did
 * nothing. Spread LAST, after each button's own colours, so it overrides them
 * — which is also why the enabled half restores only `cursor`/`opacity` and
 * leaves the caller's ink alone.
 */
function disabledLook(disabled: boolean): CSSProperties {
  return disabled
    ? { color: tokens.color.ink.faint, cursor: "default", opacity: 0.6 }
    : { cursor: "pointer", opacity: 1 };
}

function saveButtonStyle(disabled: boolean): CSSProperties {
  return {
    ...(disabled ? actionButtonStyle : button("primary", "sm")),
    ...disabledLook(disabled),
  };
}

/** A plain-surface header action that can be unavailable — the two discard
 * buttons. Same chrome as {@link actionButtonStyle}, plus the shared
 * {@link disabledLook}. */
function discardButtonStyle(disabled: boolean): CSSProperties {
  return { ...actionButtonStyle, ...disabledLook(disabled) };
}

const dirtyDotStyle: CSSProperties = {
  background: tokens.color.status.waiting,
  borderRadius: "50%",
  display: "inline-block",
  height: "6px",
  width: "6px",
};

const closeButtonStyle: CSSProperties = {
  ...iconButton(),
  fontSize: "15px",
  lineHeight: 1,
};

const noticeStyle: CSSProperties = {
  // `muted` rather than `faint`: this is the only thing in the pane, so it
  // is by definition being read (ADR-0023's AA note).
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  padding: tokens.space.lg,
};

const errorStyle: CSSProperties = {
  color: tokens.color.status.error,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  padding: tokens.space.lg,
};

/** The read-only reasons (truncated, not UTF-8) — advisory, so the warn
 * banner, same as every other "the view isn't showing you everything". */
const truncatedNoticeStyle: CSSProperties = banner("warn");

const conflictBannerStyle: CSSProperties = banner("error");

const guardBannerStyle: CSSProperties = banner("warn");

const conflictDotStyle: CSSProperties = bannerDot("error");

const guardDotStyle: CSSProperties = bannerDot("warn");

const bannerMessageStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

/** A repo-relative path's filename. */
function fileBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A repo-relative path's directory, or `""` for a file at the repo root. */
function fileDirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

const editorWrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
};

/**
 * The "Loading…" notice fills the editor's slot rather than sitting above a
 * collapsed one.
 *
 * Opening a file used to visibly lurch: `edit` clears while the read is in
 * flight, so the editor's `flex: 1` box vanished, the pane collapsed to a
 * single line of text, and the box sprang back once content arrived — a full
 * reflow of the column on every file open. Holding the same geometry makes the
 * read a quiet swap instead.
 */
const loadingPaneStyle: CSSProperties = {
  ...noticeStyle,
  flex: 1,
  minHeight: 0,
};

/** The header row's "Discard edits"/Save buttons (only for an editable file)
 * and the dirty dot — factored out of `FileViewer` purely to keep its own
 * cognitive complexity within this repo's Biome budget; no independent
 * state. */
function HeaderActions({
  dirty,
  edit,
  onRevert,
  onSave,
  saving,
}: {
  dirty: boolean;
  edit: EditState | null;
  onRevert: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <>
      {dirty ? (
        <span
          aria-label="Unsaved changes"
          data-testid="dirty-indicator"
          role="status"
          style={dirtyDotStyle}
        />
      ) : null}
      {edit ? (
        <button
          className="kr-hover-surface"
          disabled={!dirty}
          onClick={onRevert}
          style={discardButtonStyle(!dirty)}
          type="button"
        >
          Discard edits
        </button>
      ) : null}
      {edit ? (
        <button
          className="kr-hover-accent"
          disabled={!dirty || saving}
          onClick={onSave}
          style={saveButtonStyle(!dirty || saving)}
          type="button"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      ) : null}
    </>
  );
}

/**
 * The header's *other* discard: back to HEAD, not back to the last read.
 *
 * Owns its own confirm state so `FileViewer` stays a layout shell (the same
 * reason {@link HeaderActions} exists) — and because this is the one control
 * in the viewer that destroys work irrecoverably, the confirm is not optional
 * chrome to be threaded in from outside.
 *
 * Rendered only for a file that is genuinely tracked, and enabled only when it
 * genuinely differs from HEAD; see {@link FileViewer} for where those two come
 * from. The restored content is adopted by the ordinary clean-buffer
 * revalidation that the refresh triggers, not written into the editor here —
 * so a dirty draft keeps its existing stale-banner flow instead of being
 * silently replaced.
 */
function DiscardFileChanges({
  cwd,
  disabled,
  path,
  sessionId,
}: {
  cwd: string;
  disabled: boolean;
  path: string;
  sessionId?: string;
}) {
  const [asking, setAsking] = useState(false);
  // A destructive call in flight: the button stays down until it settles, so
  // an impatient second click can't issue a second discard. Idempotent either
  // way, but a confirmed destructive action should look like it is happening.
  const [discarding, setDiscarding] = useState(false);
  const name = fileBaseName(path);

  const commit = () => {
    setAsking(false);
    setDiscarding(true);
    discardFileChanges(cwd, path)
      .then(() => {
        if (sessionId) {
          // "manual", not "saved": this is the user reaching for the working
          // tree directly, and `manual` is the reason that refreshes even for
          // a session whose last diff was refused by the [Working-tree
          // budget] — which is precisely a session where discarding a file is
          // a plausible way out.
          requestRefresh(sessionId, "manual");
        }
      })
      .catch((error: unknown) => {
        // A destructive action that quietly fails is worse than one that
        // fails loudly: the file would still be modified while the user
        // believed it restored. A toast rather than one of the session
        // banners — those describe the *editing session*'s state, and this
        // failure leaves that state exactly as it was.
        showToast(failureMessage(error), "error");
      })
      .finally(() => setDiscarding(false));
  };

  return (
    <>
      <button
        className="kr-hover-surface"
        disabled={disabled || discarding}
        onClick={() => setAsking(true)}
        style={discardButtonStyle(disabled || discarding)}
        // `disabled` drops the button out of the tab order, so the reason has
        // to travel with the control rather than only being implied by its
        // wash — otherwise the one state that needs explaining is the one
        // state nobody can reach to read.
        title={
          disabled ? "This file already matches its committed version" : ""
        }
        type="button"
      >
        Discard file changes
      </button>
      {asking ? (
        <ConfirmDialog
          backdropTestId="discard-file-changes-backdrop"
          body="This restores the committed version and cannot be undone."
          confirmLabel="Discard changes"
          confirmTestId="confirm-discard-file-changes"
          label={`Keep the changes to ${name}`}
          onCancel={() => setAsking(false)}
          onConfirm={commit}
          title={`Discard changes to ${name}?`}
        />
      ) : null}
    </>
  );
}

/** The dirty-close banner: × pressed while the draft is unsaved. */
function CloseGuardBanner({
  onCancelClose,
  onDiscardClose,
  path,
}: {
  onCancelClose: () => void;
  onDiscardClose: () => void;
  path: string;
}) {
  return (
    <div data-testid="file-viewer-close-guard" style={guardBannerStyle}>
      <span style={guardDotStyle} />
      <span style={bannerMessageStyle}>
        Unsaved changes to {path}. Discard them and close?
      </span>
      <button
        className="kr-hover-surface"
        onClick={onDiscardClose}
        style={actionButtonStyle}
        type="button"
      >
        Discard &amp; close
      </button>
      <button
        className="kr-hover-surface"
        onClick={onCancelClose}
        style={actionButtonStyle}
        type="button"
      >
        Cancel
      </button>
    </div>
  );
}

/** The dirty-switch banner: a different file selected elsewhere while the
 * draft is unsaved. */
function SwitchGuardBanner({
  from,
  onDiscardSwitch,
  onKeepEditing,
  to,
}: {
  from: string;
  onDiscardSwitch: () => void;
  onKeepEditing: () => void;
  to: string;
}) {
  return (
    <div data-testid="file-viewer-switch-guard" style={guardBannerStyle}>
      <span style={guardDotStyle} />
      <span style={bannerMessageStyle}>
        Unsaved changes to {from}. Discard them and switch to {to}?
      </span>
      <button
        className="kr-hover-surface"
        onClick={onDiscardSwitch}
        style={actionButtonStyle}
        type="button"
      >
        Discard &amp; switch
      </button>
      <button
        className="kr-hover-surface"
        onClick={onKeepEditing}
        style={actionButtonStyle}
        type="button"
      >
        Keep editing
      </button>
    </div>
  );
}

/** A failed save. Only the on-disk-conflict failure has a recovery action
 * (`canReload`); every other one is a plain message. */
function SaveErrorBanner({
  canReload,
  message,
  onReload,
}: {
  canReload: boolean;
  message: string;
  onReload: () => void;
}) {
  return (
    <div data-testid="file-viewer-save-error" style={conflictBannerStyle}>
      <span style={conflictDotStyle} />
      <span style={bannerMessageStyle}>{message}</span>
      {canReload ? (
        <button
          className="kr-hover-surface"
          onClick={onReload}
          style={actionButtonStyle}
          type="button"
        >
          Reload
        </button>
      ) : null}
    </div>
  );
}

/** The file moved on disk while this draft was unsaved — Claude edited it, or
 * the user did elsewhere. Purely an offer: the draft is never touched (see
 * `useFileEditorSession`'s revalidation), so Reload is the user's decision,
 * not something that happens to them. A clean buffer never raises this; it
 * just follows the file silently. */
function StaleOnDiskBanner({ onReload }: { onReload: () => void }) {
  return (
    <div data-testid="file-viewer-stale-notice" style={guardBannerStyle}>
      <span style={guardDotStyle} />
      <span style={bannerMessageStyle}>
        This file changed on disk. Your unsaved edits are kept.
      </span>
      <button
        className="kr-hover-surface"
        onClick={onReload}
        style={actionButtonStyle}
        type="button"
      >
        Reload
      </button>
    </div>
  );
}

/** The deleted-on-disk banner: the file could no longer be read at all
 * (deleted or moved), not merely changed, so there is nothing left to Reload
 * into — Close is the only way out, and it still routes through the existing
 * dirty guard (`onClose` is `guard.closeClick`) rather than closing
 * unconditionally, so a dirty draft isn't silently thrown away just because
 * the file underneath it vanished. */
function MissingOnDiskBanner({
  dirty,
  onClose,
}: {
  dirty: boolean;
  onClose: () => void;
}) {
  return (
    <div data-testid="file-viewer-missing-notice" style={guardBannerStyle}>
      <span style={guardDotStyle} />
      <span style={bannerMessageStyle}>
        This file can no longer be read from disk (deleted or moved).
        {dirty ? " Your unsaved edits are kept." : ""}
      </span>
      <button
        className="kr-hover-surface"
        onClick={onClose}
        style={actionButtonStyle}
        type="button"
      >
        Close
      </button>
    </div>
  );
}

/**
 * The compile-time exhaustiveness check behind {@link NoticeBanner}'s
 * `default` clause: a [File viewer notice] kind added without a case there
 * stops being assignable to `never` and fails to build.
 *
 * It renders nothing rather than returning the value it was handed — the
 * check is the whole point, and a `never`-typed value reaching React would
 * be an "Objects are not valid as a React child" crash on the one path that
 * is meant to be the safe fallback.
 */
function unhandledNotice(_notice: never): null {
  return null;
}

/**
 * One [File viewer notice] → its banner. The whole of the viewer's
 * banner logic: which notices are raised, and in which order, is
 * {@link useFileEditorSession}'s call — this only draws what it is handed.
 *
 * `actions` is passed whole rather than as six sibling props: every banner
 * needs a different two of them, and threading each one individually through
 * the switch below was the bulk of the code this replaced.
 */
function NoticeBanner({
  actions,
  notice,
}: {
  actions: {
    cancelClose: () => void;
    closeClick: () => void;
    discardClose: () => void;
    discardSwitch: () => void;
    keepEditing: () => void;
    reload: () => void;
  };
  notice: FileViewerNotice;
}) {
  switch (notice.kind) {
    case "closeGuard":
      return (
        <CloseGuardBanner
          onCancelClose={actions.cancelClose}
          onDiscardClose={actions.discardClose}
          path={notice.path}
        />
      );
    case "switchGuard":
      return (
        <SwitchGuardBanner
          from={notice.from}
          onDiscardSwitch={actions.discardSwitch}
          onKeepEditing={actions.keepEditing}
          to={notice.to}
        />
      );
    case "saveError":
      return (
        <SaveErrorBanner
          canReload={notice.canReload}
          message={notice.message}
          onReload={actions.reload}
        />
      );
    case "staleOnDisk":
      return <StaleOnDiskBanner onReload={actions.reload} />;
    case "missingOnDisk":
      return (
        <MissingOnDiskBanner
          dirty={notice.dirty}
          onClose={actions.closeClick}
        />
      );
    default:
      // Unreachable: every `FileViewerNotice` kind has a case above. The
      // clause exists because Biome's `useDefaultSwitchClause` demands one,
      // and {@link unhandledNotice}'s `never` parameter is what turns a kind
      // added later without a case here into a compile error rather than a
      // silently missing banner.
      return unhandledNotice(notice);
  }
}

/**
 * Editable (for text files) viewer of one file's current content, opened from
 * the Code Changes View's "All files" tab. This component is now just chrome:
 * the whole load/edit/save/conflict/dirty-guard state machine lives in
 * {@link useFileEditorSession} (testable without rendering), and the read-only
 * rendering path lives in {@link ReadOnlyFileView}. This shell only lays out
 * the header, the guard/error banners and notices, and picks between the
 * editor and the read-only view.
 *
 * **Editing.** A faithfully-read text file (non-binary, non-truncated,
 * non-lossy) renders a `CodeEditor` seeded from the loaded content. Saving is
 * always explicit (`Save`) against the exact `(mtime, len)` signature the file
 * was last read at — never autosave. A `"changed on disk"` save failure
 * surfaces as a banner with a `Reload` action; `Discard edits` throws the
 * draft back to the last loaded/saved baseline without touching disk — the
 * shallower of the header's two discards, and named to stay clearly distinct
 * from `Discard file changes`, which goes all the way back to HEAD.
 *
 * **Discarding to HEAD.** {@link DiscardFileChanges} is the deeper one: it
 * restores the file from its committed version, confirms first, and is only
 * offered for a file whose HEAD version can actually be compared against what
 * is on disk. Its gate is the git gutter's own `baseline`, reused rather than
 * re-derived — see where `comparable` / `differsFromHead` are computed below.
 *
 * **Dirty guard.** Switching to a different file (via `path`/`cwd` changing,
 * or the × button) while the current one has unsaved edits holds the switch
 * behind an inline confirmation banner instead of silently discarding the
 * draft. See {@link useFileEditorSession} for the mechanism.
 *
 * **Read-only.** Binary, truncated, and lossy (non-UTF-8) files are never
 * editable — a save could only fail or corrupt — so they render the read-only
 * {@link ReadOnlyFileView} (binary shows a notice instead, having nothing to
 * display).
 */
export function FileViewer({
  cwd,
  fileDiff,
  onClose,
  path,
  sessionId,
}: {
  cwd: string;
  /** The file's diff in the current changeset, if it has one — drives the
   * changed-line gutter markers on the read-only path. */
  fileDiff?: FileDiff;
  onClose: () => void;
  path: string;
  /** Backs the switch-guard's "Keep editing" store resync (see
   * {@link useFileEditorSession}). Omitted in contexts that don't need it
   * (e.g. a bare unit render); everything else still works without it. */
  sessionId?: string;
}) {
  const {
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
  } = useFileEditorSession(cwd, path, onClose, sessionId);

  // `ReadOnlyFileView` owns its own virtualizer and highlight effect, so none
  // of that runs while an editable file is open — this shell only picks which
  // view to render. `lang` stays here because the editable `CodeEditor` needs
  // it.
  const lang = useMemo(() => langForPath(target.path), [target.path]);

  const binary = state.status === "loaded" && state.content.binary;
  const truncated = state.status === "loaded" && state.content.truncated;
  const lossy = state.status === "loaded" && state.content.lossy;

  // The git-discard gate, read straight off the gutter's own two values
  // rather than derived from anything new. `baseline` is the HEAD blob —
  // `undefined` covers every state where restoring from HEAD is meaningless
  // or impossible (not a repo, untracked, a blob too large/binary to show,
  // the fetch still in flight). `edit.baseline` is what is on disk; both are
  // already LF-normalized, so the comparison is a string compare on values
  // already in memory, not a git spawn.
  //
  // Both halves gate *rendering*, not just enablement. `edit` is null for a
  // binary / truncated / lossy file, and such a file can still have a
  // perfectly fetchable HEAD blob — so gating on `baseline` alone would
  // render the button for one, permanently disabled, since the comparison it
  // needs can never be made. An action that can never fire is worse than one
  // that isn't offered.
  const comparable = baseline !== undefined && edit !== null;
  const differsFromHead = comparable && edit.baseline !== baseline;
  const readOnlyContent =
    state.status === "loaded" && (truncated || lossy) && !binary
      ? state.content.content
      : null;

  return (
    <div data-testid="file-viewer" style={rootStyle}>
      <div style={headerRowStyle}>
        <FileIcon path={target.path} size={15} />
        {/* `data-testid` stays on a single element carrying the full path, so
            the existing "shows the path" assertions keep meaning what they
            did before this was split into name + directory. */}
        <span
          data-testid="file-viewer-path"
          style={pathBlockStyle}
          title={target.path}
        >
          <span style={fileNameStyle}>{fileBaseName(target.path)}</span>
          {fileDirName(target.path) ? (
            <span style={fileDirStyle}>{fileDirName(target.path)}</span>
          ) : null}
        </span>
        <HeaderActions
          dirty={dirty}
          edit={edit}
          onRevert={revert}
          onSave={save}
          saving={saving}
        />
        {comparable ? (
          <DiscardFileChanges
            cwd={target.cwd}
            disabled={!differsFromHead}
            path={target.path}
            sessionId={sessionId}
          />
        ) : null}
        <button
          className="kr-hover-surface"
          onClick={() => {
            // A text file (editable or too-large-to-edit) opens in the user's
            // code editor so an `.html`/`.md` lands in an editor, not a browser
            // or previewer; a binary opens in its type-default app (a PDF in
            // Preview, etc.), where a code editor would only show gibberish.
            // Best-effort: the backend re-validates and rejects a missing
            // path, so a file deleted between listing and click just silently
            // fails to open rather than surfacing as an unhandled rejection.
            const open = binary ? openPath : openInEditor;
            open(target.cwd, target.path).catch(() => {
              // intentionally ignored — see comment above.
            });
          }}
          style={actionButtonStyle}
          type="button"
        >
          {binary ? "Open" : "Open in editor"}
        </button>
        <button
          aria-label="Close"
          className="kr-hover-surface"
          onClick={guard.closeClick}
          style={closeButtonStyle}
          type="button"
        >
          ×
        </button>
      </div>
      {/* One notice, one banner — the list is already in render order, and a
          kind appears at most once, so it doubles as the key. */}
      {notices.map((notice) => (
        <NoticeBanner
          actions={{ ...guard, reload }}
          key={notice.kind}
          notice={notice}
        />
      ))}
      {state.status === "error" ? (
        <div data-testid="file-viewer-error" style={errorStyle}>
          {state.message}
        </div>
      ) : null}
      {binary ? (
        <div data-testid="file-viewer-binary-notice" style={noticeStyle}>
          Binary file — not shown
        </div>
      ) : null}
      {truncated ? (
        <div
          data-testid="file-viewer-truncated-notice"
          style={truncatedNoticeStyle}
        >
          <span style={guardDotStyle} />
          <span style={bannerMessageStyle}>
            File truncated at 1 MB — read-only (too large to edit safely).
          </span>
        </div>
      ) : null}
      {lossy ? (
        <div
          data-testid="file-viewer-lossy-notice"
          style={truncatedNoticeStyle}
        >
          <span style={guardDotStyle} />
          <span style={bannerMessageStyle}>
            Not valid UTF-8 — read-only (editing would corrupt the file's
            original bytes).
          </span>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div data-testid="file-viewer-loading" style={loadingPaneStyle}>
          Loading…
        </div>
      ) : null}
      {edit ? (
        <div data-testid="file-viewer-editor" style={editorWrapStyle}>
          <CodeEditor
            baseline={baseline}
            key={target.path}
            language={lang}
            onChange={(next) => {
              setEdit((current) =>
                current ? { ...current, draft: next } : current
              );
            }}
            onSave={save}
            value={edit.draft}
          />
        </div>
      ) : null}
      {readOnlyContent === null ? null : (
        <ReadOnlyFileView
          content={readOnlyContent}
          fileDiff={fileDiff}
          path={target.path}
        />
      )}
    </div>
  );
}
