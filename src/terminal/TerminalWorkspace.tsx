import { type CSSProperties, useState } from "react";
import { useTerminals } from "../state/terminals.ts";
import { button, iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { showToast } from "../ui/Toast.tsx";
import { ensureSession } from "./sessionHost.ts";
import { TabPaneGrid } from "./TabPaneGrid.tsx";
import { TerminalCloseConfirm } from "./TerminalCloseConfirm.tsx";

interface PendingClose {
  paneId?: string;
  tabId: string;
  target: "pane" | "tab";
}

// No fill of its own: the dock already sits on the plane, and a tinted strip
// re-introduced the "one more surface" step the flat chrome removes.
const stripStyle: CSSProperties = {
  alignItems: "center",
  borderBottom: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  flex: "0 0 auto",
  gap: "1px",
  height: "34px",
  padding: "0 6px",
};

// A tab reads like a Segmented pill: the active one carries a faint white fill
// and a hairline top-highlight, the inactive ones are quiet until hovered.
function tabWrapStyle(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: active ? tokens.color.surface.active : "transparent",
    borderRadius: tokens.radius.sm,
    display: "flex",
    transition: `background ${tokens.motion.hover}`,
  };
}

function tabLabelStyle(active: boolean): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: active ? tokens.color.ink.primary : tokens.color.ink.muted,
    cursor: "pointer",
    fontFamily: tokens.font.sans,
    fontSize: "12px",
    fontWeight: active ? 500 : 400,
    maxWidth: "168px",
    overflow: "hidden",
    padding: "5px 3px 5px 10px",
    textOverflow: "ellipsis",
    transition: `color ${tokens.motion.hover}`,
    whiteSpace: "nowrap",
  };
}

const tabCloseStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontSize: "14px",
  height: "17px",
  justifyContent: "center",
  lineHeight: 1,
  margin: "0 5px 0 1px",
  padding: 0,
  width: "17px",
};

// Icon buttons (new tab, split direction, maximize) share the panel-toggle
// vocabulary used across the shell: a quiet faint glyph that lights on hover.
const iconBtnStyle: CSSProperties = {
  ...iconButton(),
  fontSize: "13px",
  height: "24px",
  width: "24px",
};

const dividerStyle: CSSProperties = {
  alignSelf: "center",
  background: tokens.color.line.base,
  height: "16px",
  margin: "0 3px",
  width: "1px",
};

const renameInputStyle: CSSProperties = {
  background: tokens.color.inputWell,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  fontWeight: 500,
  margin: "0 1px",
  outline: "none",
  padding: "4px 8px",
  width: "104px",
};

const emptyStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  display: "flex",
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  gap: "12px",
  height: "100%",
  justifyContent: "center",
};

const emptyButtonStyle: CSSProperties = button("secondary");

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="13"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="13"
    >
      <title>{up ? "Maximize" : "Restore"}</title>
      {up ? (
        <path d="M3.5 9.5 8 5l4.5 4.5" />
      ) : (
        <path d="M3.5 6.5 8 11l4.5-4.5" />
      )}
    </svg>
  );
}

/**
 * The shared Project-terminal surface: a Segmented-style tab strip over the
 * active tab's {@link TabPaneGrid}, hosted by the bottom TerminalDock (which can
 * maximize to full height). `projectId === null` (no active project) renders a
 * disabled empty state. `onToggleFullHeight`, when given, shows a maximize
 * toggle in the strip.
 */
export function TerminalWorkspace({
  cwd,
  fullHeight,
  onToggleFullHeight,
  projectId,
  visible,
}: {
  cwd: string;
  fullHeight?: boolean;
  onToggleFullHeight?: () => void;
  projectId: string | null;
  visible: boolean;
}) {
  const project = useTerminals((s) =>
    projectId ? s.byProject[projectId] : undefined
  );
  const deadPanes = useTerminals((s) => s.deadPanes);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingClose | null>(null);

  const t = useTerminals.getState();

  // Revive a dead pane's shell on the same pane id: clear the overlay first so
  // the terminal is usable the moment the fresh pty attaches. ensureSession
  // treats an exited host like a failed one and recreates the pty; the pane's
  // xterm (and its scrollback) stay as they were, with the new prompt painting
  // over via the daemon's attach repaint.
  const restartPane = (tabId: string, paneId: string): void => {
    const cwd2 = project?.tabs
      .find((tab) => tab.id === tabId)
      ?.panes.find((p) => p.id === paneId)?.cwd;
    t.clearPaneExited(paneId);
    ensureSession(paneId, cwd2 ?? cwd, () =>
      showToast("Could not restart the shell", "error")
    ).catch(() => {
      // ensureSession's onError already surfaced the failure.
    });
  };
  const activeTab = project?.tabs.find((tab) => tab.id === project.activeTabId);
  const hasTabs = Boolean(projectId && project && project.tabs.length > 0);

  // Closing a terminal with a foreground process running asks first, so a
  // `pnpm dev` or a build isn't killed by an accidental click.
  const requestCloseTab = (tabId: string): void => {
    if (!projectId) {
      return;
    }
    if (t.isTabBusy(projectId, tabId)) {
      setPending({ tabId, target: "tab" });
    } else {
      t.closeTab(projectId, tabId);
    }
  };

  const requestClosePane = (tabId: string, paneId: string): void => {
    if (!projectId) {
      return;
    }
    if (t.isPaneBusy(paneId)) {
      setPending({ paneId, tabId, target: "pane" });
    } else {
      t.closePane(projectId, tabId, paneId);
    }
  };

  const confirmClose = (): void => {
    if (!(pending && projectId)) {
      return;
    }
    if (pending.target === "tab") {
      t.closeTab(projectId, pending.tabId);
    } else if (pending.paneId) {
      t.closePane(projectId, pending.tabId, pending.paneId);
    }
    setPending(null);
  };

  return (
    <div
      data-terminal-focus-scope=""
      style={{
        background: tokens.color.chrome.content,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div style={stripStyle}>
        {project?.tabs.map((tab) => {
          const isActive = tab.id === project.activeTabId;
          if (editing === tab.id) {
            return (
              <input
                defaultValue={tab.title}
                key={tab.id}
                onBlur={(e) => {
                  if (projectId) {
                    t.renameTab(projectId, tab.id, e.target.value || tab.title);
                  }
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                ref={(el) => el?.focus()}
                style={renameInputStyle}
              />
            );
          }
          return (
            <span
              className={
                isActive
                  ? "kr-reveal-parent"
                  : "kr-reveal-parent kr-hover-surface"
              }
              key={tab.id}
              style={tabWrapStyle(isActive)}
            >
              <button
                onClick={() => projectId && t.setActiveTab(projectId, tab.id)}
                onDoubleClick={() => setEditing(tab.id)}
                style={tabLabelStyle(isActive)}
                type="button"
              >
                {tab.title}
              </button>
              <button
                aria-label={`Close ${tab.title}`}
                className={isActive ? undefined : "kr-reveal"}
                onClick={() => requestCloseTab(tab.id)}
                style={tabCloseStyle}
                type="button"
              >
                ×
              </button>
            </span>
          );
        })}
        {projectId ? (
          <button
            aria-label="New terminal tab"
            className="kr-hover-surface"
            onClick={() => t.openTab(projectId, cwd)}
            style={iconBtnStyle}
            title="New terminal"
            type="button"
          >
            +
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        {activeTab && projectId ? (
          <button
            aria-label="Toggle split direction"
            className="kr-hover-surface"
            onClick={() =>
              t.setDirection(
                projectId,
                activeTab.id,
                activeTab.direction === "row" ? "column" : "row"
              )
            }
            style={iconBtnStyle}
            title={
              activeTab.direction === "row"
                ? "Split direction: side by side"
                : "Split direction: stacked"
            }
            type="button"
          >
            {activeTab.direction === "row" ? "▥" : "▤"}
          </button>
        ) : null}
        {onToggleFullHeight ? (
          <>
            <div style={dividerStyle} />
            <button
              aria-label={
                fullHeight ? "Restore terminal height" : "Maximize terminals"
              }
              className="kr-hover-surface"
              onClick={onToggleFullHeight}
              style={iconBtnStyle}
              title={fullHeight ? "Restore height" : "Maximize"}
              type="button"
            >
              <ChevronIcon up={!fullHeight} />
            </button>
          </>
        ) : null}
      </div>

      {/* Every tab stays mounted; switching only flips which one is visible, so
          a backgrounded tab keeps its live terminal and full scrollback (mirrors
          the always-mounted session panes in App). `position: relative` lets the
          hidden panes stack out of flow without collapsing the active one. */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {hasTabs && project && projectId ? (
          project.tabs.map((tab) => {
            const isActiveTab = tab.id === project.activeTabId;
            return (
              <div
                data-testid={`tab-pane-${tab.id}`}
                key={tab.id}
                style={{
                  display: isActiveTab ? "block" : "none",
                  inset: 0,
                  position: "absolute",
                }}
              >
                <TabPaneGrid
                  isPaneDead={(paneId) => deadPanes[paneId] === true}
                  onClosePane={(paneId) => requestClosePane(tab.id, paneId)}
                  onFocusPane={(paneId) =>
                    t.setActivePane(projectId, tab.id, paneId)
                  }
                  onLayout={(sizes) => t.setLayout(projectId, tab.id, sizes)}
                  onRestartPane={(paneId) => restartPane(tab.id, paneId)}
                  onSplitPane={(paneId) =>
                    t.splitPane(
                      projectId,
                      tab.id,
                      tab.panes.find((p) => p.id === paneId)?.cwd ?? cwd
                    )
                  }
                  tab={tab}
                  visible={visible && isActiveTab}
                />
              </div>
            );
          })
        ) : (
          <div style={emptyStyle}>
            <span>No terminals in this project yet</span>
            <button
              aria-label="New terminal"
              className="kr-hover-surface"
              disabled={projectId === null}
              onClick={() => projectId && t.openTab(projectId, cwd)}
              style={emptyButtonStyle}
              type="button"
            >
              New terminal
            </button>
          </div>
        )}
      </div>
      {pending ? (
        <TerminalCloseConfirm
          onCancel={() => setPending(null)}
          onConfirm={confirmClose}
          target={pending.target}
        />
      ) : null}
    </div>
  );
}
