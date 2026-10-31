import {
  BookMarked,
  Inbox,
  Maximize2,
  MessagesSquare,
  PanelLeft,
  Search,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { TOP_BAND_HEIGHT, TRAFFIC_LIGHT_CLEARANCE } from "../layout/topBand.ts";
import { useLayout } from "../state/layout.ts";
import { isPutAway, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { iconButton, inputBox, kbd, row30 } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { needsYouSectionItems } from "./needsYouItems.ts";

/**
 * The 46px band every column's header shares — and, here, the brand's home.
 *
 * The native traffic lights force this strip to reserve 96px on the left no
 * matter what it contains, so the wordmark is the one thing that can sit
 * there for free. The canvas draws a separate brand block below it (an accent
 * tile plus the wordmark); we don't, for two reasons: it spent a whole 50px
 * row restating what the Dock icon and the window title already say, and the
 * mark on a coloured tile was the single loudest object in a chrome whose
 * entire premise is that nothing shouts.
 */
const topStripStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: "2px",
  height: `${TOP_BAND_HEIGHT}px`,
  paddingLeft: `${TRAFFIC_LIGHT_CLEARANCE}px`,
  paddingRight: "10px",
};

const wordmarkStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  flex: 1,
  fontSize: "13px",
  fontWeight: 700,
  letterSpacing: "-0.008em",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// A frame, not a field: an icon, the input and the ⌘K chip sit side by side
// inside the well, so this is the one `inputBox` caller that wants flex.
const searchRowStyle: CSSProperties = {
  ...inputBox(),
  display: "flex",
  flex: "none",
  margin: "4px 12px 12px",
};

const searchInputStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: tokens.color.ink.primary,
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  minWidth: 0,
  outline: "none",
  padding: 0,
};

const paletteChipStyle: CSSProperties = {
  ...kbd(),
  cursor: "pointer",
};

const navStyle: CSSProperties = {
  display: "flex",
  flex: "none",
  flexDirection: "column",
  gap: "2px",
  padding: "0 8px",
};

const navIconStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  justifyContent: "center",
  width: "14px",
};

function navCountStyle(attention: boolean): CSSProperties {
  return {
    color: attention ? tokens.color.status.waiting : tokens.color.ink.muted,
    fontFamily: tokens.font.mono,
    fontSize: "11px",
  };
}

/** One destination in the sidebar's nav block — see [Nav row] in CONTEXT.md. */
function NavRow({
  count,
  countNeedsYou,
  icon,
  label,
  onSelect,
  selected,
}: {
  count?: number;
  countNeedsYou?: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      // Visible label and accessible name are the same string: a control
      // called "Studio" that reads "Sessions" is worse than either alone.
      aria-current={selected ? "page" : undefined}
      // Unconditional: the class is what *paints* the row's fill, so dropping
      // it on the selected row left the one row with something to show with
      // nothing showing it. `row30({ active: true })` hands the hover the same
      // fill as the rest, so the selected row sits still under the pointer
      // rather than darkening — which is why it can keep the class.
      className="kr-hover-surface"
      onClick={onSelect}
      style={{
        ...row30({ active: selected }),
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
      }}
      type="button"
    >
      <span
        style={{
          ...navIconStyle,
          color: selected ? tokens.color.ink.secondary : tokens.color.ink.muted,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {count === undefined || count === 0 ? null : (
        <span style={navCountStyle(countNeedsYou ?? false)}>{count}</span>
      )}
    </button>
  );
}

export interface SidebarHeaderProps {
  /** The session filter's current text, owned by {@link Sidebar}. */
  query: string;
  setQuery: (value: string) => void;
}

/**
 * Everything above the project tree: the traffic-light strip (which carries
 * the wordmark), the search box, and the nav rows. There is no separate brand
 * block — see the note on `topStripStyle` for why the canvas's was dropped.
 *
 * This is where the deleted title bar's contents landed (ADR-0023). The strip
 * is a `data-tauri-drag-region` because the window has no other handle in its
 * top-left corner any more.
 */
export function SidebarHeader({ query, setQuery }: SidebarHeaderProps) {
  const view = useLayout((state) => state.layout.view);
  const setView = useLayout((state) => state.setView);
  const toggleSidebar = useLayout((state) => state.toggleSidebarCollapsed);
  const openPalette = useUi((state) => state.openPalette);

  const openSessions = useSessions(
    (state) =>
      Object.values(state.sessions).filter((session) => !isPutAway(session))
        .length
  );
  // The Command centre's count is the same "how many want me" number the
  // needs-you section renders, so the two can never disagree. The selector
  // returns the *length*, not the list: `needsYouSectionItems` builds fresh
  // objects on every call, so selecting the array — even shallowly — compares
  // unequal every time and re-renders forever.
  const needsYouCount = useSessions(
    (state) => needsYouSectionItems(state).length
  );

  const navRows = useMemo(
    () =>
      [
        {
          count: openSessions,
          icon: <MessagesSquare size={12} strokeWidth={1.75} />,
          label: "Sessions",
          needsYou: false,
          value: "studio",
        },
        {
          count: needsYouCount,
          icon: <Inbox size={12} strokeWidth={1.75} />,
          label: "Command center",
          needsYou: true,
          value: "command",
        },
        {
          count: undefined,
          icon: <BookMarked size={12} strokeWidth={1.75} />,
          label: "Prompts",
          needsYou: false,
          value: "prompts",
        },
      ] as const,
    [needsYouCount, openSessions]
  );

  return (
    <>
      <div
        data-tauri-drag-region
        data-testid="sidebar-top-strip"
        style={topStripStyle}
      >
        <span data-tauri-drag-region style={wordmarkStyle}>
          Kriyon
        </span>
        <button
          aria-label="Focus mode"
          className="kr-hover-surface"
          onClick={() => setView("focus")}
          style={iconButton()}
          title="Focus mode — hide the chrome"
          type="button"
        >
          <Maximize2 size={13} strokeWidth={1.75} />
        </button>
        <button
          aria-label="Collapse sidebar"
          className="kr-hover-surface"
          onClick={toggleSidebar}
          style={iconButton()}
          title="Collapse sidebar"
          type="button"
        >
          <PanelLeft size={13} strokeWidth={1.75} />
        </button>
      </div>

      <div className="kr-filter-box" style={searchRowStyle}>
        <Search
          size={12}
          strokeWidth={1.75}
          style={{ color: tokens.color.ink.faint, flex: "none" }}
        />
        <input
          aria-label="Filter sessions"
          className="kr-filter-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
            }
          }}
          placeholder="Search…"
          spellCheck={false}
          style={searchInputStyle}
          type="text"
          value={query}
        />
        {/* The box filters the rail; the chip opens the palette. Two jobs in
            one frame, as the canvas draws it — and the only ⌘K affordance
            left now that the title bar's Search button is gone. */}
        <button
          aria-label="Open command palette"
          onClick={openPalette}
          style={paletteChipStyle}
          title="Command palette (⌘K)"
          type="button"
        >
          ⌘K
        </button>
      </div>

      <nav aria-label="Views" style={navStyle}>
        {navRows.map((row) => (
          <NavRow
            count={row.count}
            countNeedsYou={row.needsYou}
            icon={row.icon}
            key={row.value}
            label={row.label}
            onSelect={() => setView(row.value)}
            selected={view === row.value}
          />
        ))}
      </nav>
    </>
  );
}
