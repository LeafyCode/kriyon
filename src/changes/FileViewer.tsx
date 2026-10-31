import { ChevronRight, ExternalLink, Undo2, X } from "lucide-react";
import { type CSSProperties, Fragment, useMemo, useState } from "react";
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
import { useGitAnnotations } from "./useGitAnnotations.ts";

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
 * The header's path, as an editor's breadcrumb: each folder muted, the file
 * name last and bright. Folders give way first when space runs out, so the
 * file name — the one thing you need to read — is the last thing clipped.
 */
const pathBlockStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  gap: "2px",
  minWidth: 0,
  overflow: "hidden",
};

const crumbDirStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flexShrink: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const crumbSeparatorStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  flex: "none",
};

const fileNameStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  flex: "none",
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  // 500, not 600: the UI face ships 400/500/700, and a 600 is synthesized.
  fontWeight: 500,
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** The header's icon actions — open elsewhere, restore from git, close —
 * quiet glyphs with their name on hover, the way an editor's title bar
 * carries them. */
const headerIconStyle: CSSProperties = {
  ...iconButton(),
  height: "26px",
  width: "26px",
};

/** A thin rule between the save pair and the icon actions. */
const headerDividerStyle: CSSProperties = {
  alignSelf: "center",
  background: tokens.color.line.soft,
  flex: "none",
  height: "16px",
  margin: "0 4px",
  width: "1px",
};

/** The header's and the banners' shared control: the 24px secondary button
 * from `recipes.ts`, so a `Reload` inside a banner and an `Open in editor`
 * in the header are visibly the same kind of thing. */
const actionButtonStyle: CSSProperties = button("secondary", "sm");

const saveButtonStyle: CSSProperties = button("primary", "sm");

const dirtyDotStyle: CSSProperties = {
  background: tokens.color.status.waiting,
  borderRadius: "50%",
  display: "inline-block",
  height: "6px",
  width: "6px",
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

/** The folders above `path`, outermost first — the breadcrumb's crumbs. */
function fileDirParts(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).filter((p) => p !== "");
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

/** The header row's dirty dot and its Discard edits / Save pair — shown only
 * while there is something to save, the way an editor offers them. Factored
 * out of `FileViewer` purely to keep its own cognitive complexity within this
 * repo's Biome budget; no independent state. */
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
  if (!(edit && dirty)) {
    return null;
  }
  return (
    <>
      <button
        className="kr-hover-surface"
        onClick={onRevert}
        style={actionButtonStyle}
        title="Throw away the edits made here since the last save"
        type="button"
      >
        Discard edits
      </button>
      <button
        className="kr-hover-accent"
        disabled={saving}
        onClick={onSave}
        style={saveButtonStyle}
        title="Save (⌘S)"
        type="button"
      >
        {saving ? "Saving…" : "Save"}
      </button>
      <span aria-hidden style={headerDividerStyle} />
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
  path,
  sessionId,
}: {
  cwd: string;
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
        aria-label="Discard file changes"
        className="kr-hover-surface"
        disabled={discarding}
        onClick={() => setAsking(true)}
        style={headerIconStyle}
        title="Discard file changes — restore the committed version"
        type="button"
      >
        <Undo2 size={15} strokeWidth={1.75} />
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
  // Session tint and blame — decorations, fetched beside the file, never
  // blocking it.
  const { blame, sessionStart } = useGitAnnotations(
    target.cwd,
    target.path,
    sessionId,
    dirty
  );

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
        {/* `data-testid` stays on one element carrying the full path, so the
            "shows the path" assertions keep meaning what they did. */}
        <span
          data-testid="file-viewer-path"
          style={pathBlockStyle}
          title={target.path}
        >
          {fileDirParts(target.path).map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional; a path can repeat a folder name.
            <Fragment key={i}>
              <span data-testid="file-viewer-crumb" style={crumbDirStyle}>
                {part}
              </span>
              <ChevronRight
                aria-hidden
                size={12}
                strokeWidth={2}
                style={crumbSeparatorStyle}
              />
            </Fragment>
          ))}
          <span data-testid="file-viewer-crumb" style={fileNameStyle}>
            {fileBaseName(target.path)}
          </span>
          {dirty ? (
            <span
              aria-label="Unsaved changes"
              data-testid="dirty-indicator"
              role="status"
              style={dirtyDotStyle}
            />
          ) : null}
        </span>
        <HeaderActions
          dirty={dirty}
          edit={edit}
          onRevert={revert}
          onSave={save}
          saving={saving}
        />
        {/* Offered only when there is something to restore — a file that
            already matches its committed version has nothing to discard. */}
        {differsFromHead ? (
          <DiscardFileChanges
            cwd={target.cwd}
            path={target.path}
            sessionId={sessionId}
          />
        ) : null}
        <button
          aria-label={binary ? "Open" : "Open in editor"}
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
          style={headerIconStyle}
          title={binary ? "Open with its default app" : "Open in editor"}
          type="button"
        >
          <ExternalLink size={14} strokeWidth={1.75} />
        </button>
        <button
          aria-label="Close"
          className="kr-hover-surface"
          onClick={guard.closeClick}
          style={headerIconStyle}
          title="Close"
          type="button"
        >
          <X size={15} strokeWidth={1.75} />
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
            blame={blame}
            key={target.path}
            language={lang}
            onChange={(next) => {
              setEdit((current) =>
                current ? { ...current, draft: next } : current
              );
            }}
            onSave={save}
            sessionStart={sessionStart}
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
