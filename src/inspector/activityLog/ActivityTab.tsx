/**
 * The [Activity tab]: one session's [Activity log] as a turn-grouped
 * timeline (design A). Filter chips on top, turns newest first, a retention
 * footer. Clicking a step opens its [Step detail].
 */
import {
  Bot,
  FilePlus,
  FileText,
  Globe,
  type LucideIcon,
  Pencil,
  Plug,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import type { ActivityStep, ActivityTurn, StepKind } from "../../ipc/bridge.ts";
import { useSessions } from "../../state/sessions.ts";
import { tokens } from "../../theme/tokens.ts";
import {
  ACTIVITY_FILTERS,
  type ActivityFilter,
  type ChipTone,
  changesPathFor,
  changesUnavailableReason,
  filterCounts,
  groupSteps,
  retentionNote,
  type StatTone,
  type StepRowView,
  stepChips,
  stepRow,
  turnHeading,
  turnTimeLabel,
  visibleTurns,
} from "./activityLog.ts";
import { StepDetailDialog } from "./StepDetailDialog.tsx";
import { useActivityLog } from "./useActivityLog.ts";

const KIND_ICON: Record<StepKind, LucideIcon> = {
  agent: Bot,
  command: Terminal,
  edit: Pencil,
  mcp: Plug,
  other: Wrench,
  read: FileText,
  search: Search,
  web: Globe,
  write: FilePlus,
};

const rootStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minHeight: 0,
};

// Design A: small square mono chips, no outline; the lit one sits on a
// surface, and "Needs a look" keeps its amber while it has anything in it.
const chipRowStyle: CSSProperties = {
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  flexWrap: "wrap",
  gap: "6px",
  padding: `${tokens.space.md} ${tokens.space.lg}`,
};

function filterChipStyle(active: boolean, warn: boolean): CSSProperties {
  let background = "transparent";
  let color = tokens.color.ink.muted;
  if (active) {
    background = tokens.color.surface.active;
    color = tokens.color.ink.primary;
  } else if (warn) {
    background = tokens.color.status.waitingSoft;
    color = tokens.color.status.waitingInk;
  }
  return {
    alignItems: "center",
    background,
    border: "none",
    borderRadius: tokens.radius.sm,
    color,
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: tokens.font.mono,
    fontSize: "11px",
    gap: "5px",
    padding: "3px 7px",
  };
}

const listStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minHeight: 0,
  overflowY: "auto",
  padding: `${tokens.space.xs} ${tokens.space.lg} ${tokens.space.lg}`,
};

function turnStyle(first: boolean): CSSProperties {
  return first
    ? { paddingTop: tokens.space.md }
    : {
        borderTop: `1px solid ${tokens.color.line.soft}`,
        marginTop: tokens.space.sm,
        paddingTop: tokens.space.lg,
      };
}

const metaStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "12px",
};

const turnMetaStyle: CSSProperties = {
  ...metaStyle,
  display: "flex",
  justifyContent: "space-between",
};

const promptStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  display: "-webkit-box",
  fontSize: "13px",
  fontWeight: 500,
  lineHeight: 1.45,
  margin: `${tokens.space.xs} 0 6px`,
  overflow: "hidden",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
};

const sourceStyle: CSSProperties = {
  ...promptStyle,
  color: tokens.color.ink.muted,
  fontStyle: "italic",
};

// The steps hang off a thin rail under their prompt.
const stepsStyle: CSSProperties = {
  borderLeft: `1px solid ${tokens.color.line.base}`,
  marginLeft: tokens.space.sm,
  paddingLeft: tokens.space.sm,
};

const stepButtonStyle: CSSProperties = {
  alignItems: "start",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.primary,
  columnGap: "10px",
  cursor: "pointer",
  display: "grid",
  fontFamily: tokens.font.sans,
  gridTemplateColumns: "18px minmax(0, 1fr)",
  padding: `6px ${tokens.space.xs}`,
  textAlign: "left",
  width: "100%",
};

// A folded row's own steps, set in under it like the turn's steps are.
const foldStyle: CSSProperties = {
  ...stepsStyle,
  marginLeft: "17px",
};

const STAT_INK: Record<StatTone, string> = {
  added: tokens.color.diffAddInk,
  error: tokens.color.status.error,
  ok: tokens.color.diffAddInk,
  removed: tokens.color.diffDelInk,
};

const statsStyle: CSSProperties = {
  display: "flex",
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "12px",
  gap: "6px",
  lineHeight: 1.45,
  whiteSpace: "nowrap",
};

function stepIconColor(step: ActivityStep): string {
  if (step.flags !== 0) {
    return tokens.color.status.waitingInk;
  }
  return step.kind === "edit" || step.kind === "write"
    ? tokens.color.accent
    : tokens.color.ink.muted;
}

const stepBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
};

// Title and chips share a line when they fit and the chips drop under the
// title when they don't, so a narrow panel never cuts the title short.
const stepHeadStyle: CSSProperties = {
  alignItems: "start",
  columnGap: tokens.space.sm,
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  rowGap: "4px",
};

const stepLabelStyle: CSSProperties = {
  flex: "1 1 120px",
  fontSize: "13px",
  lineHeight: 1.45,
  minWidth: 0,
  overflowWrap: "anywhere",
};

const targetStyle: CSSProperties = {
  ...metaStyle,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const chipsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.xs,
  paddingTop: "1px",
};

const CHIP_COLORS: Record<ChipTone, { background: string; color: string }> = {
  error: {
    background: tokens.color.status.errorSoft,
    color: tokens.color.status.error,
  },
  flag: {
    background: tokens.color.status.waitingSoft,
    color: tokens.color.status.waitingInk,
  },
  live: {
    background: tokens.color.status.runningSoft,
    color: tokens.color.status.runningInk,
  },
  muted: { background: tokens.color.chip, color: tokens.color.ink.muted },
};

function stepChipStyle(tone: ChipTone): CSSProperties {
  return {
    ...CHIP_COLORS[tone],
    borderRadius: tokens.radius.sm,
    fontFamily: tokens.font.mono,
    fontSize: "11px",
    padding: "3px 7px",
    whiteSpace: "nowrap",
  };
}

const quietStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  lineHeight: 1.45,
  padding: tokens.space.lg,
};

const footerStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.soft}`,
  color: tokens.color.ink.faint,
  display: "flex",
  flex: "none",
  flexDirection: "column",
  fontSize: "11px",
  gap: "2px",
  lineHeight: 1.4,
  padding: `${tokens.space.md} ${tokens.space.lg}`,
};

function FilterChips({
  counts,
  onChange,
  value,
}: {
  counts: Record<ActivityFilter, number>;
  onChange: (filter: ActivityFilter) => void;
  value: ActivityFilter;
}) {
  return (
    <div style={chipRowStyle}>
      {ACTIVITY_FILTERS.map((filter) => (
        <button
          aria-label={`${filter.label} ${counts[filter.value]}`}
          aria-pressed={filter.value === value}
          className="kr-hover-surface"
          key={filter.value}
          onClick={() => onChange(filter.value)}
          style={filterChipStyle(
            filter.value === value,
            filter.value === "flagged" && counts.flagged > 0
          )}
          type="button"
        >
          {filter.label} {counts[filter.value]}
        </button>
      ))}
    </div>
  );
}

function StepRow({
  onOpen,
  row,
  toplevel,
  turnEnded,
}: {
  onOpen: (step: ActivityStep) => void;
  row: StepRowView;
  toplevel: string | null | undefined;
  turnEnded: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [lead] = row.steps;
  const folded = row.steps.length > 1;
  const Icon = KIND_ICON[lead.kind];
  const chips = folded ? [] : stepChips(lead, turnEnded);
  return (
    <>
      <button
        aria-expanded={folded ? open : undefined}
        className="kr-hover-surface"
        onClick={() => (folded ? setOpen(!open) : onOpen(lead))}
        style={stepButtonStyle}
        type="button"
      >
        <Icon
          color={stepIconColor(lead)}
          size={14}
          strokeWidth={2}
          style={{ marginTop: "3px" }}
        />
        <span style={stepBodyStyle}>
          <span style={stepHeadStyle}>
            <span style={stepLabelStyle}>{row.label}</span>
            {chips.length > 0 ? (
              <span style={chipsStyle}>
                {chips.map((chip) => (
                  <span key={chip.text} style={stepChipStyle(chip.tone)}>
                    {chip.text}
                  </span>
                ))}
              </span>
            ) : null}
            {row.stats.length > 0 ? (
              <span style={statsStyle}>
                {row.stats.map((stat) => (
                  <span key={stat.text} style={{ color: STAT_INK[stat.tone] }}>
                    {stat.text}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
          {row.lines.map((line, index) => (
            // A chain may repeat a command, so the position is part of the key.
            // biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder
            <span key={`${index}:${line}`} style={targetStyle} title={line}>
              {line}
            </span>
          ))}
        </span>
      </button>
      {folded && open ? (
        <div style={foldStyle}>
          {row.steps.map((step) => (
            <StepRow
              key={step.id}
              onOpen={onOpen}
              row={stepRow(step, toplevel)}
              toplevel={toplevel}
              turnEnded={turnEnded}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function TurnBlock({
  first,
  number,
  onOpen,
  toplevel,
  turn,
}: {
  first: boolean;
  number: number;
  onOpen: (step: ActivityStep) => void;
  toplevel: string | null | undefined;
  turn: ActivityTurn;
}) {
  const heading = turnHeading(turn);
  return (
    <section style={turnStyle(first)}>
      <div style={turnMetaStyle}>
        <span>{turnTimeLabel(turn, Date.now())}</span>
        <span>turn {number}</span>
      </div>
      <p
        style={heading.quoted ? promptStyle : sourceStyle}
        title={heading.text}
      >
        {heading.quoted ? `“${heading.text}”` : heading.text}
      </p>
      {turn.steps.length > 0 ? (
        <div style={stepsStyle}>
          {groupSteps(turn.steps, toplevel).map((row) => (
            <StepRow
              key={row.steps[0].id}
              onOpen={onOpen}
              row={row}
              toplevel={toplevel}
              turnEnded={turn.endedMs !== null}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Timeline({
  filter,
  onOpen,
  toplevel,
  turns,
}: {
  filter: ActivityFilter;
  onOpen: (step: ActivityStep) => void;
  toplevel: string | null | undefined;
  turns: ActivityTurn[];
}) {
  if (turns.length === 0) {
    return (
      <p style={quietStyle}>
        No activity yet. Steps appear here as Claude works.
      </p>
    );
  }
  const shown = visibleTurns(turns, filter);
  if (shown.length === 0) {
    return <p style={quietStyle}>Nothing here for this filter.</p>;
  }
  // Numbered from the oldest loaded turn, so "turn 1" is the first one kept.
  const numberOf = new Map(turns.map((t, i) => [t.id, turns.length - i]));
  return (
    <div data-testid="activity-timeline" style={listStyle}>
      {shown.map((turn, index) => (
        <TurnBlock
          first={index === 0}
          key={turn.id}
          number={numberOf.get(turn.id) ?? 0}
          onOpen={onOpen}
          toplevel={toplevel}
          turn={turn}
        />
      ))}
    </div>
  );
}

export function ActivityTab({
  onOpenInChanges,
  sessionId,
}: {
  /** Show a repo-relative path in the Changes view. */
  onOpenInChanges: (path: string) => void;
  sessionId: string;
}) {
  const { error, stats, turns } = useActivityLog(sessionId);
  const toplevel = useSessions((state) => state.repoToplevel[sessionId]);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [open, setOpen] = useState<ActivityStep | null>(null);

  let body: ReactNode;
  if (error) {
    body = <p style={quietStyle}>Couldn't read the activity log: {error}</p>;
  } else if (turns === null) {
    body = <p style={quietStyle}>Loading…</p>;
  } else {
    body = (
      <Timeline
        filter={filter}
        onOpen={setOpen}
        toplevel={toplevel}
        turns={turns}
      />
    );
  }

  const changesPath = open ? changesPathFor(open, toplevel) : null;
  return (
    <div data-testid="activity-tab" style={rootStyle}>
      <FilterChips
        counts={filterCounts(turns ?? [])}
        onChange={setFilter}
        value={filter}
      />
      {body}
      <footer style={footerStyle}>
        <span>{stats ? retentionNote(stats) : "Only on this Mac"}</span>
        <span>Secrets are hidden on a best-effort basis.</span>
      </footer>
      {open ? (
        <StepDetailDialog
          onClose={() => setOpen(null)}
          onOpenInChanges={
            changesPath === null
              ? null
              : () => {
                  setOpen(null);
                  onOpenInChanges(changesPath);
                }
          }
          sessionId={sessionId}
          step={open}
          unavailableReason={changesUnavailableReason(open, toplevel)}
        />
      ) : null}
    </div>
  );
}
