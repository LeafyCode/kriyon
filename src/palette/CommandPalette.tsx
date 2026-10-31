import type { CSSProperties, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
  MENU_BAR_OPTIONS,
  SIDEBAR_MODE_OPTIONS,
} from "../settings/settingsOptions.ts";
import { sleepIdleSessionsNow, startNewSession } from "../state/actions.ts";
import { useLayout } from "../state/layout.ts";
import { importPromptsFromCommands } from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import {
  kbd,
  overlayEmpty,
  overlayPanel,
  resultLabel,
  resultList,
  resultRow,
  resultSub,
  searchInput,
  searchRow,
} from "../theme/recipes.ts";
import { THEMES } from "../theme/themes/index.ts";
import { tokens } from "../theme/tokens.ts";
import { Overlay } from "../ui/Overlay.tsx";

interface PaletteItem {
  icon: string;
  id: string;
  kind: string;
  label: string;
  run: () => void;
  sub?: string;
}

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  maxHeight: "62vh",
  overflow: "hidden",
  width: "min(580px, 92vw)",
};

const searchRowStyle: CSSProperties = searchRow();

const inputStyle: CSSProperties = searchInput();

const escStyle: CSSProperties = kbd();

const listStyle: CSSProperties = resultList();

const emptyStyle: CSSProperties = overlayEmpty();

function iconStyle(session: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: tokens.color.surface.s2,
    border: `1px solid ${tokens.color.line.base}`,
    borderRadius: tokens.radius.sm,
    color: session ? tokens.color.accentBright : tokens.color.ink.muted,
    display: "flex",
    flex: "none",
    fontSize: "12px",
    height: "24px",
    justifyContent: "center",
    width: "24px",
  };
}

const labelStyle: CSSProperties = resultLabel();

const subStyle: CSSProperties = resultSub();

const kindStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  fontWeight: 500,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

function buildItems(
  sessions: ReturnType<typeof useSessions.getState>["sessions"],
  projects: ReturnType<typeof useSessions.getState>["projects"],
  setActiveSession: (id: string) => void
): PaletteItem[] {
  const projectName = (id: string) =>
    projects.find((project) => project.id === id)?.name ?? "";

  const sessionItems: PaletteItem[] = Object.values(sessions)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((session) => ({
      icon: "◧",
      id: `session:${session.id}`,
      kind: "Session",
      label: session.title,
      run: () => {
        setActiveSession(session.id);
        // Same rule as the sidebar's session rows (`Sidebar.tsx`): jumping to
        // a session shows the session view and lands on the transcript. The
        // palette opens from anywhere, so without the view step this jumped
        // behind whatever full view was up.
        useLayout.getState().revealSessionView();
      },
      // A parked session stays findable here, marked; opening it brings it
      // back (see `setActiveSession`).
      sub:
        (session.parkedAt ?? null) === null
          ? projectName(session.projectId)
          : `${projectName(session.projectId)} · Parked`,
    }));

  const commandItems: PaletteItem[] = [
    {
      icon: "+",
      id: "cmd:new-session",
      kind: "Action",
      label: "New session in folder…",
      run: () => {
        startNewSession();
      },
    },
    {
      icon: "⤳",
      id: "cmd:spawn-followup",
      kind: "Action",
      label: "Spawn follow-up session…",
      run: () => {
        const { activeSessionId } = useSessions.getState();
        if (activeSessionId) {
          useUi.getState().openSpawn({ predecessorId: activeSessionId });
        }
      },
    },
    {
      icon: "⑂",
      id: "cmd:spawn-worktree",
      kind: "Action",
      label: "New worktree session…",
      run: () => {
        const { activeSessionId } = useSessions.getState();
        if (activeSessionId) {
          useUi
            .getState()
            .openSpawn({ predecessorId: activeSessionId }, { worktree: true });
        }
      },
    },
    {
      icon: "☾",
      id: "cmd:sleep-idle",
      kind: "Action",
      // Memory back without quitting. Never touches a session that is busy.
      label: "Sleep idle sessions now",
      run: () => {
        sleepIdleSessionsNow();
      },
    },
    {
      icon: "❯",
      id: "cmd:insert-prompt",
      kind: "Prompts",
      label: "Insert prompt…",
      run: () => useUi.getState().openPromptPicker(),
      sub: "⌘⇧P",
    },
    {
      icon: "✦",
      id: "cmd:save-last-prompt",
      kind: "Prompts",
      label: "Save last prompt…",
      run: () => {
        const { activeSessionId, events } = useSessions.getState();
        const list = activeSessionId ? (events[activeSessionId] ?? []) : [];
        const last = [...list].reverse().find((e) => e.kind === "prompt");
        if (last?.kind === "prompt") {
          useUi.getState().openPromptEditor({
            body: last.text,
            tags: [],
            title: last.text.split("\n")[0].slice(0, 60),
          });
        }
      },
    },
    {
      icon: "⇲",
      id: "cmd:import-commands",
      kind: "Prompts",
      label: "Import prompts from /commands…",
      run: () => {
        importPromptsFromCommands();
      },
    },
    {
      icon: "▦",
      id: "cmd:toggle-view",
      kind: "Layout",
      label: "Toggle Sessions / Focus layout",
      run: useLayout.getState().toggleView,
    },
    {
      icon: "⊟",
      id: "cmd:toggle-transcript",
      kind: "View",
      // The palette's only route into the Changes view.
      label: "Toggle Changes / Session view",
      run: useLayout.getState().toggleTranscriptView,
    },
  ];

  const themeItems: PaletteItem[] = THEMES.map((theme) => ({
    icon: "◐",
    id: `theme:${theme.id}`,
    kind: "Theme",
    label: `Theme: ${theme.label}`,
    run: () => useLayout.getState().setThemeId(theme.id),
  }));

  const menuBarItems: PaletteItem[] = MENU_BAR_OPTIONS.map((option) => ({
    icon: "▤",
    id: `menubar:${option.value}`,
    kind: "Setting",
    label: `Menu bar: ${option.label} view`,
    run: () => useLayout.getState().setMenuBarMode(option.value),
  }));

  const sidebarItems: PaletteItem[] = SIDEBAR_MODE_OPTIONS.map((option) => ({
    icon: "◧",
    id: `sidebar:${option.value}`,
    kind: "Setting",
    label: `Sidebar: ${option.label} view`,
    run: () => useLayout.getState().setSidebarMode(option.value),
  }));

  return [
    ...sessionItems,
    ...commandItems,
    ...themeItems,
    ...menuBarItems,
    ...sidebarItems,
  ];
}

export function CommandPalette() {
  const open = useUi((state) => state.paletteOpen);
  const openPalette = useUi((state) => state.openPalette);
  const closePalette = useUi((state) => state.closePalette);

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessions = useSessions((state) => state.sessions);
  const projects = useSessions((state) => state.projects);
  const setActiveSession = useSessions((state) => state.setActiveSession);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey
      ) {
        event.preventDefault();
        setQuery("");
        setHighlight(0);
        openPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPalette]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const items = buildItems(sessions, projects, setActiveSession);
  const needle = query.toLowerCase();
  const filtered = items.filter(
    (item) =>
      item.label.toLowerCase().includes(needle) ||
      (item.sub ?? "").toLowerCase().includes(needle)
  );
  const safeHighlight = Math.min(highlight, Math.max(filtered.length - 1, 0));

  const activate = (item: PaletteItem) => {
    item.run();
    closePalette();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => Math.min(index + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[safeHighlight];
      if (item) {
        activate(item);
      }
    }
  };

  return (
    <Overlay
      backdropTestId="palette-backdrop"
      label="Close command palette"
      onClose={closePalette}
    >
      <div style={panelStyle}>
        <div style={searchRowStyle}>
          <span style={{ color: tokens.color.ink.faint, fontSize: "14px" }}>
            ⌕
          </span>
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Jump to a session or run a command…"
            ref={inputRef}
            style={inputStyle}
            type="text"
            value={query}
          />
          <span style={escStyle}>esc</span>
        </div>
        <div style={listStyle}>
          {filtered.length === 0 ? (
            <div style={emptyStyle}>No matches</div>
          ) : (
            filtered.map((item, index) => (
              <button
                data-active={index === safeHighlight ? "true" : "false"}
                key={item.id}
                onClick={() => activate(item)}
                onMouseEnter={() => setHighlight(index)}
                style={resultRow(index === safeHighlight)}
                type="button"
              >
                <span style={iconStyle(item.kind === "Session")}>
                  {item.icon}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ ...labelStyle, display: "block" }}>
                    {item.label}
                  </span>
                  {item.sub ? (
                    <span style={{ ...subStyle, display: "block" }}>
                      {item.sub}
                    </span>
                  ) : null}
                </span>
                <span style={kindStyle}>{item.kind}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </Overlay>
  );
}
