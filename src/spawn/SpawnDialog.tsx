import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  type BootstrapReport,
  pickDirectory,
  worktreePathFor,
} from "../ipc/bridge.ts";
import { spawnFollowUpSession } from "../state/actions.ts";
import { detectCollision } from "../state/collision.ts";
import { startNestedSession } from "../state/nestedSessions.ts";
import {
  sessionWorkingDir,
  type UiSession,
  useSessions,
} from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { button, card, inputBox, overlayPanel } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import { Overlay } from "../ui/Overlay.tsx";
import { validateBranchName } from "./branchName.ts";
import { buildHandoffPrompt } from "./handoffPrompt.ts";

/** Last path segment of an absolute path, e.g. `/a/b/c` → `c`. */
function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: tokens.space.sm,
  maxHeight: "72vh",
  overflow: "auto",
  padding: tokens.space.lg,
  width: "min(560px, 92vw)",
};

const promptStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  display: "block",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  height: "auto",
  lineHeight: 1.5,
  minHeight: "84px",
  outline: "none",
  padding: tokens.space.sm,
  resize: "vertical",
};

/** Quiet label above the folder/worktree choice. */
const sectionLabelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  fontWeight: 500,
  marginTop: tokens.space.xs,
};

/** One selectable run-mode card; the accent border *and* an 8% accent fill
 *  carry the selection — on a plane this flat a border alone is too quiet. */
function modeCardStyle(selected: boolean): CSSProperties {
  return {
    ...card(),
    background: selected ? accentAlpha(0.08) : "transparent",
    border: `1px solid ${selected ? tokens.color.accent : tokens.color.border}`,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    fontFamily: tokens.font.sans,
    gap: "3px",
    padding: "10px 12px",
    textAlign: "left",
  };
}

const modeTitleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "12.5px",
  fontWeight: 500,
};

const modeBodyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  lineHeight: 1.5,
};

/** The in-card caution when another session already occupies the folder. */
const modeCautionStyle: CSSProperties = {
  color: tokens.color.status.waiting,
  fontSize: "11.5px",
  lineHeight: 1.5,
  marginTop: "4px",
};

const fieldStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  display: "block",
  fontFamily: tokens.font.mono,
  fontSize: "12.5px",
  outline: "none",
};

/** The field once validation failed — the border carries the state. */
const fieldErrorStyle: CSSProperties = {
  ...fieldStyle,
  border: `1px solid ${tokens.color.status.error}`,
};

/** Small label above a worktree field; the red * marks a required one. */
const fieldLabelStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontSize: "11.5px",
  fontWeight: 500,
  marginTop: "2px",
};

const requiredStyle: CSSProperties = {
  color: tokens.color.status.error,
  fontWeight: 700,
};

const optionalStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontWeight: 400,
};

/** Inline validation message under a field that failed to validate. */
const fieldErrorTextStyle: CSSProperties = {
  color: tokens.color.status.error,
  fontSize: "11.5px",
  lineHeight: 1.4,
};

const locationRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.sm,
};

const locationPathStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: 1,
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const chooseButtonStyle: CSSProperties = button("secondary", "sm");

const resetLocationStyle: CSSProperties = button("ghost", "sm");

const warnStyle: CSSProperties = {
  background: tokens.color.status.errorSoft,
  border: `1px solid ${tokens.color.status.error}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.status.error,
  fontSize: "12px",
  lineHeight: 1.5,
  padding: "8px 10px",
  whiteSpace: "pre-wrap",
};

const headerStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
};

const hintStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  lineHeight: 1.5,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  gap: tokens.space.sm,
  justifyContent: "flex-end",
  marginTop: tokens.space.xs,
};

const secondaryStyle: CSSProperties = button("secondary");

const primaryStyle: CSSProperties = button("primary");

/** `"My Session Title"` → `wt/my-session-title`, falling back to `wt/followup`. */
function branchFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `wt/${slug || "followup"}`;
}

/**
 * The worktree-mode fields: the required branch name (validated live), the
 * chosen or default [Worktree] location, and the optional setup command. Split
 * out of {@link SpawnDialog} so each stays readable and simple.
 */
function WorktreeFields({
  branch,
  branchError,
  onBranch,
  onChooseLocation,
  onResetLocation,
  onSetup,
  setupCmd,
  worktreeParent,
  worktreePath,
}: {
  branch: string;
  branchError: string | null;
  onBranch: (next: string) => void;
  onChooseLocation: () => void;
  onResetLocation: () => void;
  onSetup: (next: string) => void;
  setupCmd: string;
  worktreeParent: string | null;
  worktreePath: string | null;
}) {
  return (
    <>
      <label htmlFor="spawn-branch-input" style={fieldLabelStyle}>
        Branch name
        <span data-testid="spawn-branch-required" style={requiredStyle}>
          {" "}
          *
        </span>
      </label>
      <input
        aria-invalid={branchError !== null}
        data-testid="spawn-branch"
        id="spawn-branch-input"
        onChange={(e) => onBranch(e.target.value)}
        placeholder="e.g. fix/scroll-jump"
        style={branchError ? fieldErrorStyle : fieldStyle}
        value={branch}
      />
      {branchError ? (
        <span data-testid="spawn-branch-error" style={fieldErrorTextStyle}>
          {branchError}
        </span>
      ) : null}
      <span style={fieldLabelStyle}>Location</span>
      <div style={locationRowStyle}>
        <span
          data-testid="spawn-worktree-location"
          style={locationPathStyle}
          title={worktreePath ?? undefined}
        >
          {worktreePath ?? worktreeParent ?? "next to the repo (default)"}
        </span>
        <button
          className="kr-hover-surface"
          data-testid="spawn-choose-location"
          onClick={onChooseLocation}
          style={chooseButtonStyle}
          type="button"
        >
          Choose…
        </button>
        {worktreeParent ? (
          <button
            className="kr-hover-surface"
            onClick={onResetLocation}
            style={resetLocationStyle}
            type="button"
          >
            Reset
          </button>
        ) : null}
      </div>
      <label htmlFor="spawn-setup-input" style={fieldLabelStyle}>
        Setup command{" "}
        <span style={optionalStyle}>
          (optional — runs once after dependencies install)
        </span>
      </label>
      <input
        data-testid="spawn-setup"
        id="spawn-setup-input"
        onChange={(e) => onSetup(e.target.value)}
        placeholder="e.g. docker compose up -d"
        style={fieldStyle}
        value={setupCmd}
      />
      <span style={hintStyle}>
        When the work is done, Review in the inspector merges the branch back,
        and “Remove worktree” on the session row cleans up the folder.
      </span>
    </>
  );
}

/**
 * The [Spawn dialog]: composes a [Follow-up session] from a predecessor's
 * work, or a fresh project-anchored session (no predecessor — the sidebar's
 * per-project worktree button), optionally in a fresh [Worktree]. Mounted
 * globally; opened via {@link useUi}'s `openSpawn`. Mutually exclusive with
 * the command palette and the Needs-you overlay (see `ui.ts`).
 */
/** The dialog's heading for what it is about to start. */
function spawnHeading(
  nest: boolean,
  predecessorTitle: string | undefined,
  projectName: string
): string {
  if (predecessorTitle === undefined) {
    return `New session in ${projectName}`;
  }
  return nest
    ? `Split off from “${predecessorTitle}”`
    : `Follow-up from “${predecessorTitle}”`;
}

const WHITESPACE = /\s+/;

/** A split-off session's sidebar title: its task's first words. */
export function nestedTitle(prompt: string, parentTitle: string): string {
  const words = prompt.trim().split(WHITESPACE).filter(Boolean).slice(0, 6);
  if (words.length === 0) {
    return `${parentTitle} (split)`;
  }
  const title = words.join(" ");
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

/** Start the [Split off] session the dialog describes, shown at once. */
function splitOff(
  lead: UiSession,
  prompt: string,
  worktree: { branch: string; path: string | undefined; use: boolean }
): Promise<{ error: string | null; ok: boolean }> {
  return startNestedSession(
    lead.id,
    {
      branch: worktree.use ? worktree.branch : null,
      prompt,
      title: nestedTitle(prompt, lead.title),
      worktree: worktree.use,
      worktreePath: worktree.use ? worktree.path : undefined,
    },
    { focus: true }
  );
}

export function SpawnDialog() {
  const open = useUi((s) => s.spawnOpen);
  const predecessorId = useUi((s) => s.spawnPredecessorId);
  const spawnProjectId = useUi((s) => s.spawnProjectId);
  const spawnSeed = useUi((s) => s.spawnSeed);
  const spawnWorktreeDefault = useUi((s) => s.spawnWorktreeDefault);
  const nest = useUi((s) => s.spawnNest);
  const closeSpawn = useUi((s) => s.closeSpawn);

  const predecessor = useSessions((s) =>
    predecessorId ? s.sessions[predecessorId] : undefined
  );
  const project = useSessions((s) => {
    const projectId = predecessor ? predecessor.projectId : spawnProjectId;
    return projectId ? s.projects.find((p) => p.id === projectId) : undefined;
  });
  const events = useSessions((s) =>
    predecessorId ? s.events[predecessorId] : undefined
  );
  const activity = useSessions((s) =>
    predecessorId ? s.activity[predecessorId] : undefined
  );
  const sessions = useSessions((s) => s.sessions);

  const seed = useMemo(() => {
    if (spawnSeed !== null) {
      return spawnSeed;
    }
    return predecessor
      ? buildHandoffPrompt({
          activity,
          events: events ?? [],
          title: predecessor.title,
        })
      : "";
  }, [spawnSeed, predecessor, events, activity]);

  const [prompt, setPrompt] = useState(seed);
  const [useWorktree, setUseWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  const [setupCmd, setSetupCmd] = useState(project?.setupCommand ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a spawn has actually created a session (success, or a
  // bootstrap failure — the worktree/session exist either way). Once true,
  // the dialog must never re-run `confirm()`: a second spawn would re-run
  // `createWorktree` on a path that already exists.
  const [spawned, setSpawned] = useState(false);
  // The branch-name validation message, shown inline; recomputed as the user
  // types and on a failed submit. `null` = valid (or not yet in worktree mode).
  const [branchError, setBranchError] = useState<string | null>(null);
  // The parent directory chosen for the worktree, or `null` for the default
  // sibling location (`<repo>-worktrees/<branch>`).
  const [worktreeParent, setWorktreeParent] = useState<string | null>(null);
  // The default worktree path resolved from the Rust core, shown so the user
  // can see exactly where an un-relocated worktree lands.
  const [defaultPath, setDefaultPath] = useState<string | null>(null);

  // Reset local state each time the dialog (re)opens. A predecessor pre-fills
  // the branch from its title; a project-anchored open leaves it for the user
  // to name (a generated name would collide on the second use).
  useEffect(() => {
    if (open) {
      setPrompt(seed);
      setUseWorktree(spawnWorktreeDefault);
      setBranch(predecessor ? branchFor(predecessor.title) : "");
      setSetupCmd(project?.setupCommand ?? "");
      setError(null);
      setBranchError(null);
      setWorktreeParent(null);
      setSpawned(false);
    }
  }, [open, seed, predecessor, project, spawnWorktreeDefault]);

  // Resolve the default worktree location for the current branch so the
  // Location line can show where it will land. Only while in worktree mode
  // with a git-valid branch; the Rust core owns the sibling-path convention.
  const repoRoot = project?.path;
  useEffect(() => {
    if (!(useWorktree && repoRoot) || validateBranchName(branch) !== null) {
      setDefaultPath(null);
      return;
    }
    let live = true;
    worktreePathFor(repoRoot, branch)
      .then((path) => {
        if (live) {
          setDefaultPath(path);
        }
      })
      .catch(() => {
        if (live) {
          setDefaultPath(null);
        }
      });
    return () => {
      live = false;
    };
  }, [useWorktree, repoRoot, branch]);

  // The resolved worktree path: the chosen parent joined with the default's
  // sanitized directory name, or the default sibling path.
  const worktreePath =
    worktreeParent && defaultPath
      ? `${worktreeParent}/${basename(defaultPath)}`
      : defaultPath;

  // Confirm the dialog: create the follow-up session (in a worktree, if
  // requested), persisting an edited setup command back onto the project.
  // `spawnFollowUpSession` can report failure two ways: it throws/returns an
  // `error` before anything is created (e.g. the worktree itself couldn't be
  // made) — no session exists, so the dialog stays open for a retry — or it
  // returns `ok: false` with `bootstrap.ok === false`, where the worktree
  // *and* the session were already created and activated. That second case
  // must never be retried (a retry would re-run `createWorktree` on a path
  // that now exists), so it marks `spawned` and shows the report instead of
  // silently closing.
  async function confirm() {
    if (busy || spawned || !project) {
      return;
    }
    // A worktree needs a git-valid branch name; explain exactly what is wrong
    // instead of surfacing git's terse error after the fact.
    if (useWorktree) {
      const problem = validateBranchName(branch);
      if (problem !== null) {
        setBranchError(problem);
        return;
      }
    }
    setBusy(true);
    setError(null);
    if (useWorktree && setupCmd !== (project.setupCommand ?? "")) {
      useSessions.setState((s) => ({
        projects: s.projects.map((p) =>
          p.id === project.id ? { ...p, setupCommand: setupCmd || null } : p
        ),
      }));
    }
    if (nest && predecessor) {
      const nested = await splitOff(predecessor, prompt, {
        branch: branch.trim(),
        path: worktreePath ?? undefined,
        use: useWorktree,
      });
      setBusy(false);
      applyResult({ bootstrap: null, ...nested });
      return;
    }
    const result = await spawnFollowUpSession({
      predecessor,
      project: { ...project, setupCommand: setupCmd || null },
      promptText: prompt,
      worktree: useWorktree
        ? { branch: branch.trim(), path: worktreePath ?? undefined }
        : null,
    });
    setBusy(false);
    applyResult(result);
  }

  // Reflect a spawn result: a failed setup shows its report and locks the
  // dialog (the worktree/session already exist); a pre-create failure shows the
  // error and stays open for a retry; success closes.
  function applyResult(result: {
    bootstrap: BootstrapReport | null;
    error: string | null;
    ok: boolean;
  }): void {
    if (result.bootstrap && !result.bootstrap.ok) {
      setError(`Setup command failed:\n${result.bootstrap.output}`);
      setSpawned(true);
      return;
    }
    if (!result.ok) {
      setError(result.error ?? "Failed to spawn session.");
      return;
    }
    closeSpawn();
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!open) {
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        confirm().catch(() => {
          // confirm() reports failure via `error` state; nothing else to do.
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!(open && project)) {
    return null;
  }

  // Collision only for a same-checkout spawn (worktree off). A fresh worktree
  // path is unique, so it can never collide.
  const spawnDir = predecessor ? sessionWorkingDir(predecessor) : project.path;
  const collision = useWorktree
    ? null
    : detectCollision(spawnDir, sessions, predecessor?.id);

  let confirmLabel = "Start session";
  if (spawned) {
    confirmLabel = "Close";
  } else if (busy) {
    confirmLabel = "Setting up…";
  }

  return (
    <Overlay label="Close spawn dialog" onClose={closeSpawn}>
      <div data-testid="spawn-dialog" style={panelStyle}>
        <span style={headerStyle}>
          {spawnHeading(nest, predecessor?.title, project.name)}
        </span>
        <span style={sectionLabelStyle}>Where should it work?</span>
        <button
          aria-pressed={!useWorktree}
          data-testid="spawn-mode-folder"
          onClick={() => {
            setUseWorktree(false);
            setBranchError(null);
          }}
          style={modeCardStyle(!useWorktree)}
          type="button"
        >
          <span style={modeTitleStyle}>In the project folder</span>
          <span style={modeBodyStyle}>
            Works on the current branch, alongside anything already running
            there.
          </span>
          {collision ? (
            <span data-testid="spawn-collision" style={modeCautionStyle}>
              “{collision.title}” is already working in this folder — two
              sessions editing the same files can clash. Pick the worktree
              option to keep them apart.
            </span>
          ) : null}
        </button>
        <button
          aria-pressed={useWorktree}
          data-testid="spawn-mode-worktree"
          onClick={() => setUseWorktree(true)}
          style={modeCardStyle(useWorktree)}
          type="button"
        >
          <span style={modeTitleStyle}>In its own worktree</span>
          <span style={modeBodyStyle}>
            A separate copy of the repo on a new branch — runs in parallel
            without touching the project folder. Env files are copied and
            dependencies installed for you.
          </span>
        </button>
        {useWorktree ? (
          <WorktreeFields
            branch={branch}
            branchError={branchError}
            onBranch={(next) => {
              setBranch(next);
              // Validate live once there is something to judge, so the field
              // turns green/red as the user types instead of only on submit.
              setBranchError(next === "" ? null : validateBranchName(next));
            }}
            onChooseLocation={() => {
              pickDirectory()
                .then((dir) => dir && setWorktreeParent(dir))
                .catch(() => {
                  // Cancelled or unavailable: keep the current location.
                });
            }}
            onResetLocation={() => setWorktreeParent(null)}
            onSetup={setSetupCmd}
            setupCmd={setupCmd}
            worktreeParent={worktreeParent}
            worktreePath={worktreePath}
          />
        ) : null}
        <label htmlFor="spawn-prompt" style={fieldLabelStyle}>
          First prompt{" "}
          <span style={optionalStyle}>(optional — you can type it later)</span>
        </label>
        <textarea
          data-testid="spawn-prompt"
          id="spawn-prompt"
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask Claude to start on something…"
          style={promptStyle}
          value={prompt}
        />
        {error ? <span style={warnStyle}>{error}</span> : null}
        <div style={actionsStyle}>
          <button
            className="kr-hover-surface"
            onClick={closeSpawn}
            style={secondaryStyle}
            type="button"
          >
            Cancel
          </button>
          <button
            className="kr-hover-accent"
            data-testid="spawn-confirm"
            disabled={busy}
            onClick={() => {
              if (spawned) {
                closeSpawn();
                return;
              }
              confirm().catch(() => {
                // confirm() reports failure via `error` state; nothing else to do.
              });
            }}
            style={primaryStyle}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
