import { type CSSProperties, type ReactNode, useEffect } from "react";
import { About } from "../about/About.tsx";
import { CommandCenter } from "../commandCenter/CommandCenter.tsx";
import { Inspector, inspectorWidth } from "../inspector/Inspector.tsx";
import {
  INSPECTOR_RAIL_WIDTH,
  InspectorRail,
} from "../inspector/InspectorRail.tsx";
import { NeedsYouOverlay } from "../needsYou/NeedsYouOverlay.tsx";
import { CommandPalette } from "../palette/CommandPalette.tsx";
import { PromptEditor } from "../prompts/PromptEditor.tsx";
import { PromptPicker } from "../prompts/PromptPicker.tsx";
import { PromptsView } from "../prompts/PromptsView.tsx";
import { SettingsView } from "../settings/SettingsView.tsx";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import { HandoffCards } from "../spawn/HandoffCard.tsx";
import { SpawnDialog } from "../spawn/SpawnDialog.tsx";
import { useLayout } from "../state/layout.ts";
import { useUi } from "../state/ui.ts";
import { tokens } from "../theme/tokens.ts";
import { CollapsePanel } from "../ui/CollapsePanel.tsx";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { OutsideOpenConfirm } from "../ui/OutsideOpenConfirm.tsx";
import { Toast } from "../ui/Toast.tsx";
import { UpdateDialog } from "../update/UpdateDialog.tsx";
import { FocusRail } from "./FocusRail.tsx";
import { PromptBar } from "./PromptBar.tsx";
import { SessionHeader } from "./SessionHeader.tsx";
import { TaskStrip } from "./TaskStrip.tsx";
import { TerminalDock } from "./TerminalDock.tsx";

export interface ShellProps {
  children: ReactNode;
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
}

/**
 * The whole app fills the native OS window edge-to-edge. macOS owns the frame
 * — rounded corners, drop shadow, and the traffic lights (drawn as a native
 * overlay via `titleBarStyle: "Overlay"`), the way Warp does it — so the shell
 * no longer fakes any of that in CSS.
 *
 * Since ADR-0023 there is no global title bar either: the shell is one row of
 * three columns, each owning its own 46px header, and the window is dragged by
 * whichever of those headers is under the pointer.
 */
const shellStyle: CSSProperties = {
  background: tokens.color.chrome.window,
  display: "flex",
  height: "100vh",
  overflow: "hidden",
  position: "relative",
  width: "100vw",
};

/**
 * Everything right of the sidebar. The session workspace and the three full
 * views are siblings here, so the sidebar stays put while they swap.
 */
const mainAreaStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
  position: "relative",
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
};

const centerStyle: CSSProperties = {
  background: tokens.color.chrome.content,
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minHeight: 0,
  minWidth: 0,
  position: "relative",
};

const contentStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
};

/**
 * The sidebar's collapse panel with its own width subscription: drag-resize
 * fires setSidebarWidth per mousemove, and subscribing up in Shell would
 * re-render the whole app (session body, header, composer, inspector) per
 * event.
 */
function SidebarPanel({ children }: { children: ReactNode }) {
  const collapsed = useLayout((state) => state.layout.sidebarCollapsed);
  const width = useLayout((state) => state.layout.sidebarWidth);
  return (
    <CollapsePanel
      open={!collapsed}
      side="left"
      testId="sidebar-panel"
      width={width}
    >
      {children}
    </CollapsePanel>
  );
}

/**
 * The always-mounted session workspace: one stable center column (header,
 * session panes, terminal dock, prompt bar) plus the Details rail. Mounted
 * once by {@link Shell} and display-toggled per view — never unmounted,
 * because `children` and the dock host every live xterm terminal, and a
 * remount disposes them all.
 *
 * The center column is this component's FIRST child in every mode. The
 * sidebar used to sit before it and swap with the focus rail, which made the
 * center column's index depend on the mode; lifting the sidebar to `Shell`
 * (ADR-0023) removed that hazard rather than relying on React to reconcile
 * around it.
 */
function SessionBody({
  children,
  showInspector,
  visible,
}: {
  children: ReactNode;
  showInspector: boolean;
  visible: boolean;
}) {
  const inspectorCollapsed = useLayout(
    (state) => state.layout.inspectorCollapsed
  );
  const inspectorTab = useLayout((state) => state.inspectorTab);
  const dockOpen = useLayout((state) => state.layout.terminalDockOpen);
  const dockFullHeight = useLayout(
    (state) => state.layout.terminalDockFullHeight
  );
  // A maximized dock fills the working column; the Claude content collapses.
  // The sidebar and inspector live outside this column, so they stay visible.
  const contentHidden = dockOpen && dockFullHeight;
  // Changes is a reading view — the composer is dead space there, so it goes
  // away whole rather than shrinking to its reveal strip. `suppressed` rather
  // than unmounting: PromptBar is the only thing that drains the Prompt-picker
  // mailbox, so an unmounted one turns an accepted prompt into a request that
  // splices itself into the draft on some later, unrelated visit.
  const composerHidden =
    useLayout((state) => state.layout.transcriptView) === "changes";

  return (
    <div
      data-testid="session-body"
      style={visible ? bodyStyle : { ...bodyStyle, display: "none" }}
    >
      <div style={centerStyle}>
        <SessionHeader />
        <TaskStrip />
        <div
          style={
            contentHidden ? { ...contentStyle, display: "none" } : contentStyle
          }
        >
          <ErrorBoundary label="This view crashed.">{children}</ErrorBoundary>
        </div>
        {/* The composer stays with the view it writes to; the dock goes under both. */}
        <PromptBar suppressed={contentHidden || composerHidden} />
        <ErrorBoundary label="Terminal dock crashed.">
          <TerminalDock />
        </ErrorBoundary>
      </div>
      {showInspector ? (
        <CollapsePanel
          closedWidth={INSPECTOR_RAIL_WIDTH}
          collapsedChildren={
            <ErrorBoundary label="Inspector unavailable.">
              <InspectorRail />
            </ErrorBoundary>
          }
          open={!inspectorCollapsed}
          side="right"
          testId="inspector-panel"
          width={inspectorWidth(inspectorTab)}
        >
          <ErrorBoundary label="Inspector unavailable.">
            <Inspector />
          </ErrorBoundary>
        </CollapsePanel>
      ) : null}
    </div>
  );
}

export function Shell({ children, onCloseSession, onNewSession }: ShellProps) {
  const view = useLayout((state) => state.layout.view);
  const aboutOpen = useUi((state) => state.aboutOpen);
  const openAbout = useUi((state) => state.openAbout);
  const closeAbout = useUi((state) => state.closeAbout);

  // ⌘, opens Settings — the platform-standard shortcut, matching the gear.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        useLayout.getState().setView("settings");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main data-testid="app-shell" style={shellStyle}>
      {view === "focus" ? (
        <FocusRail />
      ) : (
        <SidebarPanel>
          <ErrorBoundary label="Sidebar unavailable.">
            <Sidebar
              onCloseSession={onCloseSession}
              onNewSession={onNewSession}
              onShowAbout={openAbout}
            />
          </ErrorBoundary>
        </SidebarPanel>
      )}
      <div style={mainAreaStyle}>
        {/* The session workspace is mounted once and display-toggled: its
            children and the terminal dock host every live xterm, and moving
            them under a different parent (or dropping them for other views)
            would remount — and dispose — all of them. */}
        <SessionBody
          showInspector={view !== "focus"}
          visible={view === "studio" || view === "focus"}
        >
          {children}
        </SessionBody>
        {view === "command" ? <CommandCenter /> : null}
        {view === "prompts" ? (
          <ErrorBoundary label="This view crashed.">
            <PromptsView />
          </ErrorBoundary>
        ) : null}
        {view === "settings" ? (
          <ErrorBoundary label="This view crashed.">
            <SettingsView />
          </ErrorBoundary>
        ) : null}
      </div>
      <CommandPalette />
      <PromptPicker />
      <PromptEditor />
      <SpawnDialog />
      <HandoffCards />
      <NeedsYouOverlay />
      <UpdateDialog />
      <About onClose={closeAbout} open={aboutOpen} />
      {/* Global toast host: mounted here (not in `children`) so it shows in
            every view — children are only visible in studio/focus. */}
      <Toast />
      <OutsideOpenConfirm />
    </main>
  );
}
