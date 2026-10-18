import type { CSSProperties, ReactNode } from "react";
import { formatCpu, formatMb } from "../sidebar/memoryChip.ts";
import { button, iconButton, sectionLabel } from "../theme/recipes.ts";
import { statusDotStyle, statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import type { TrayGroups, TrayRow } from "./trayRows.ts";

export interface TrayPanelProps {
  /** Total [Session footprint] across sessions (MB); 0 hides the readout. */
  /** Whole-app CPU percent, or null before the second sample. */
  cpuTotalPct?: number | null;
  /** True when the live snapshot poll is failing, so an empty list reads as
   *  "can't reach the app" rather than a misleading "no sessions running". */
  degraded?: boolean;
  groups: TrayGroups;
  memoryTotalMb?: number;
  mode: "compact" | "grouped";
  onNewSession: () => void;
  onOpenApp: () => void;
  onOpenSession: (id: string) => void;
  onPreferences: () => void;
}

/**
 * A tray row on the app's own rhythm: 46px when it carries a second line,
 * 30px when it is just a dot, a title and a time.
 */
function rowButtonStyle(height: 30 | 46): CSSProperties {
  return {
    alignItems: "center",
    background: "transparent",
    border: "none",
    borderRadius: tokens.radius.md,
    cursor: "pointer",
    display: "flex",
    gap: tokens.space.sm,
    height: `${height}px`,
    padding: `0 ${tokens.space.md}`,
    textAlign: "left",
    width: "100%",
  };
}

/** Rich row for grouped mode: dot, title + branch, activity line, ago, chevron. */
function RichRow({
  row,
  onOpen,
}: {
  row: TrayRow;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      className="kr-hover-surface"
      onClick={() => onOpen(row.sessionId)}
      style={rowButtonStyle(46)}
      type="button"
    >
      <span style={statusDotStyle(row.status, 7)} />
      <span
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
        }}
      >
        <span
          style={{
            alignItems: "center",
            display: "flex",
            gap: tokens.space.xs,
          }}
        >
          <span
            style={{
              color: tokens.color.ink.bright,
              fontSize: 12.5,
              fontWeight: 500,
            }}
          >
            {row.title}
          </span>
          {row.branch ? (
            <span
              style={{
                color: tokens.color.ink.muted,
                fontFamily: tokens.font.mono,
                fontSize: 10.5,
              }}
            >
              ⎇ {row.branch}
            </span>
          ) : null}
        </span>
        <span
          style={{
            color: tokens.color.textMuted,
            fontSize: 11.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.line}
        </span>
      </span>
      <span
        style={{
          alignItems: "center",
          color: tokens.color.ink.muted,
          display: "flex",
          flexShrink: 0,
          gap: tokens.space.xs,
        }}
      >
        <span style={{ fontFamily: tokens.font.mono, fontSize: 10.5 }}>
          {row.ago}
        </span>
        <span
          aria-hidden
          style={{ color: tokens.color.ink.faint, fontSize: 12 }}
        >
          ›
        </span>
      </span>
    </button>
  );
}

/** Dense row for compact mode: dot, title, and a pill (needs-you) or ago (running). */
function CompactRow({
  row,
  onOpen,
}: {
  row: TrayRow;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      className="kr-hover-surface"
      onClick={() => onOpen(row.sessionId)}
      style={rowButtonStyle(30)}
      type="button"
    >
      <span style={statusDotStyle(row.status, 7)} />
      <span
        style={{
          color: tokens.color.ink.bright,
          flex: 1,
          fontSize: 12.5,
          fontWeight: 500,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.title}
      </span>
      {row.pill ? (
        <span
          style={{
            background: statusMeta("waiting").soft,
            borderRadius: tokens.radius.sm,
            // The lifted amber *ink*: `#d29922` reads as a dot, not as 9.5px
            // caps on a tinted chip.
            color: statusMeta("waiting").ink,
            flexShrink: 0,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.04em",
            padding: "3px 7px",
          }}
        >
          {row.pill}
        </span>
      ) : (
        <span
          style={{
            color: tokens.color.ink.muted,
            flexShrink: 0,
            fontFamily: tokens.font.mono,
            fontSize: 10.5,
          }}
        >
          {row.ago}
        </span>
      )}
    </button>
  );
}

function SectionLabel({
  text,
  count,
  color,
}: {
  color: string;
  count: number;
  text: string;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: tokens.space.xs,
        padding: `0 ${tokens.space.sm} 7px`,
      }}
    >
      <span style={{ ...sectionLabel(), color }}>{text}</span>
      <span
        style={{
          color,
          fontFamily: tokens.font.mono,
          fontSize: 9.5,
          fontWeight: 500,
        }}
      >
        {count}
      </span>
    </div>
  );
}

const iconBtnStyle: CSSProperties = { ...iconButton(), fontSize: 13 };

function GroupedBody({
  groups,
  onOpenSession,
  waitingInk,
}: {
  groups: TrayGroups;
  onOpenSession: (id: string) => void;
  waitingInk: string;
}) {
  return (
    <>
      {groups.needsYou.length > 0 ? (
        <section style={{ paddingTop: tokens.space.sm }}>
          <SectionLabel
            color={waitingInk}
            count={groups.needsYou.length}
            text="NEEDS YOU"
          />
          {groups.needsYou.map((row) => (
            <RichRow key={row.sessionId} onOpen={onOpenSession} row={row} />
          ))}
        </section>
      ) : null}
      {groups.running.length > 0 ? (
        <section style={{ paddingTop: tokens.space.sm }}>
          <SectionLabel
            color={tokens.color.ink.faint}
            count={groups.running.length}
            text="RUNNING"
          />
          {groups.running.map((row) => (
            <RichRow key={row.sessionId} onOpen={onOpenSession} row={row} />
          ))}
        </section>
      ) : null}
    </>
  );
}

function CompactBody({
  groups,
  onOpenSession,
}: {
  groups: TrayGroups;
  onOpenSession: (id: string) => void;
}) {
  return (
    <>
      {groups.needsYou.map((row) => (
        <CompactRow key={row.sessionId} onOpen={onOpenSession} row={row} />
      ))}
      {groups.running.map((row) => (
        <CompactRow key={row.sessionId} onOpen={onOpenSession} row={row} />
      ))}
    </>
  );
}

function DegradedState() {
  return (
    <div
      style={{
        alignItems: "center",
        color: tokens.color.textMuted,
        display: "flex",
        flexDirection: "column",
        fontSize: 12.5,
        gap: tokens.space.sm,
        padding: tokens.space.xl,
        textAlign: "center",
      }}
    >
      <span style={{ color: tokens.color.status.waiting, fontSize: 18 }}>
        ⚠
      </span>
      <span>Can't reach Kriyon — retrying…</span>
    </div>
  );
}

function EmptyState({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div
      style={{
        alignItems: "center",
        color: tokens.color.textMuted,
        display: "flex",
        flexDirection: "column",
        fontSize: 12.5,
        gap: tokens.space.md,
        padding: tokens.space.xl,
        textAlign: "center",
      }}
    >
      <span>No sessions running</span>
      <button
        className="kr-hover-accent"
        onClick={onNewSession}
        style={button("primary", "sm")}
        type="button"
      >
        New session
      </button>
    </div>
  );
}

export default function TrayPanel(props: TrayPanelProps) {
  const {
    degraded,
    groups,
    cpuTotalPct,
    memoryTotalMb,
    mode,
    onNewSession,
    onOpenApp,
    onOpenSession,
    onPreferences,
  } = props;
  const total = groups.needsYou.length + groups.running.length;
  const waitingInk = statusMeta("waiting").ink;

  let body: ReactNode;
  if (total === 0 && degraded) {
    body = <DegradedState />;
  } else if (total === 0) {
    body = <EmptyState onNewSession={onNewSession} />;
  } else if (mode === "grouped") {
    body = (
      <GroupedBody
        groups={groups}
        onOpenSession={onOpenSession}
        waitingInk={waitingInk}
      />
    );
  } else {
    body = <CompactBody groups={groups} onOpenSession={onOpenSession} />;
  }

  return (
    <div
      style={{
        background: tokens.color.chrome.overlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.lg,
        color: tokens.color.text,
        display: "flex",
        flexDirection: "column",
        fontFamily: tokens.font.sans,
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${tokens.color.line.base}`,
          display: "flex",
          flex: "none",
          height: 46,
          justifyContent: "space-between",
          padding: `0 ${tokens.space.md}`,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: tokens.space.sm,
          }}
        >
          <span
            style={{
              alignItems: "center",
              background: tokens.color.accent,
              borderRadius: tokens.radius.lg,
              color: tokens.color.onAccent,
              display: "flex",
              flex: "none",
              fontFamily: tokens.font.mono,
              fontSize: 10,
              height: 24,
              justifyContent: "center",
              width: 24,
            }}
          >
            {">_"}
          </span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span
              style={{
                color: tokens.color.ink.bright,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              Kriyon
            </span>
            <span style={{ color: tokens.color.textMuted, fontSize: 10.5 }}>
              {groups.needsYou.length} need you · {groups.running.length}{" "}
              running
              {memoryTotalMb
                ? ` · ${formatMb(memoryTotalMb)} · ${formatCpu(cpuTotalPct)} CPU`
                : ""}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: tokens.space.xs }}>
          <button
            aria-label="Preferences"
            className="kr-hover-surface"
            onClick={onPreferences}
            style={iconBtnStyle}
            type="button"
          >
            ⚙
          </button>
          <button
            aria-label="Open Kriyon"
            className="kr-hover-surface"
            onClick={onOpenApp}
            style={iconBtnStyle}
            type="button"
          >
            ⤢
          </button>
        </div>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: tokens.space.xs }}>
        {body}
      </div>

      <footer
        style={{
          alignItems: "center",
          borderTop: `1px solid ${tokens.color.line.base}`,
          display: "flex",
          flex: "none",
          justifyContent: "space-between",
          padding: `${tokens.space.sm} ${tokens.space.md}`,
        }}
      >
        <button
          className="kr-hover-surface"
          onClick={onOpenApp}
          style={button("ghost", "sm")}
          type="button"
        >
          Open Kriyon
        </button>
        <button
          className="kr-hover-accent"
          onClick={onNewSession}
          style={button("primary", "sm")}
          type="button"
        >
          New session{" "}
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              opacity: 0.75,
            }}
          >
            ⌘N
          </span>
        </button>
      </footer>
    </div>
  );
}
