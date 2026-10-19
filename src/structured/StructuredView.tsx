import {
  ArrowDown,
  Bell,
  CircleCheck,
  CircleSlash,
  CircleX,
  Lightbulb,
  LoaderCircle,
  type LucideIcon,
  Radio,
} from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type CompanionStatus,
  noteTurnEnded,
  onCompanionChanged,
  type PartialReply,
  type StructuredTurn,
  structuredPartial,
  structuredTurns,
  type TurnItem,
  type WorkReport,
} from "../ipc/bridge.ts";
import { onEvent } from "../ipc/onEvent.ts";
import { companionChip } from "../layout/companionChip.ts";
import { useCompanionStatus } from "../layout/useCompanionStatus.ts";
import { useIntegration } from "../state/integration.ts";
import { useLayout } from "../state/layout.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { sessionWorkingDir, useSessions } from "../state/sessions.ts";
import { type ShownUsageCard, useUsageCards } from "../state/usageCards.ts";
import { openFileToken } from "../terminal/links.ts";
import { screenText } from "../terminal/screenText.ts";
import {
  type SpinnerTip,
  spinnerTask,
  spinnerTip,
} from "../terminal/spinnerTip.ts";
import { button, chip } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import { ImageLightbox } from "../ui/ImageLightbox.tsx";
import { useImagePreview } from "../ui/imagePreview.ts";
import {
  CopyButton,
  InlineText,
  LinkCwd,
  Markdown,
  replyStyle,
} from "../ui/Markdown.tsx";
import { companionHint } from "../welcome/integrationCopy.ts";
import { useCliDialog } from "./cliDialog.ts";
import { interruptSession } from "./interrupt.ts";
import { liveText } from "./liveReply.ts";
import { Mascot } from "./Mascot.tsx";
import {
  clockLabel,
  didSummary,
  durationLabel,
  stepInProgress,
  stepVerb,
  thoughtLabel,
  turnSections,
} from "./plainWords.ts";
import { linkText } from "./replyMarkdown.ts";
import { matchingTurn, recordedEnd, shownPrompt } from "./sentPrompt.ts";
import { UsageCard } from "./UsageCard.tsx";
import { usageCardSlot } from "./usageRules.ts";
import { summaryParts } from "./workReport.ts";

/** The fewest milliseconds between two reads while the companion posts. */
const REFRESH_GAP_MS = 1500;

/** How often the turns are read while Claude works. */
const LIVE_REFRESH_MS = 1200;

/** How often the streaming reply is read while Claude works. */
const PARTIAL_POLL_MS = 300;

/** How long the streamed reply stays after the turn ends, waiting for its
 *  row to replace it. */
const PARTIAL_LINGER_MS = 6000;

/** When the turns are read again after Claude stops working: at once, and
 *  once more for a row the companion was slow to hand over. */
const SETTLE_READS_MS = [0, 1500, 4000];

/** A clock that ticks every second while `on`, for checks that age. */
function useClockWhile(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** The session's reply as it streams, read on a short beat while `live`. */
function usePartialReply(
  sessionId: string,
  live: boolean
): PartialReply | null {
  const [partial, setPartial] = useState<PartialReply | null>(null);
  useEffect(() => {
    if (!live) {
      // Kept a moment after the turn ends, so the reply stays on screen until
      // its row is read in and takes its place — never a blank in between.
      const timer = window.setTimeout(
        () => setPartial(null),
        PARTIAL_LINGER_MS
      );
      return () => window.clearTimeout(timer);
    }
    let alive = true;
    const read = () =>
      structuredPartial(sessionId)
        .then((next) => {
          if (alive) {
            setPartial(next);
          }
        })
        .catch(() => undefined);
    read();
    const timer = window.setInterval(read, PARTIAL_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [live, sessionId]);
  return partial;
}

const caretStyle: CSSProperties = {
  animation: "kr-blink 1s steps(1) infinite",
  background: tokens.color.accentBright,
  display: "inline-block",
  height: "1em",
  marginLeft: "2px",
  verticalAlign: "text-bottom",
  width: "2px",
};

/** The reply as it streams: drawn like a reply, with a caret at its end. */
function LiveReply({ text }: { text: string }) {
  return (
    <div aria-live="polite" data-testid="live-reply">
      <Markdown text={text} />
      <span aria-hidden style={caretStyle} />
    </div>
  );
}

/**
 * The session's turns, re-read when its companion posts: the first post at
 * once, then at most once per {@link REFRESH_GAP_MS}, since a busy turn posts
 * many rows a second.
 */
function useStructuredTurns(
  sessionId: string,
  live: boolean
): StructuredTurn[] | null {
  const [turns, setTurns] = useState<StructuredTurn[] | null>(null);
  // Reads overlap (the beat, the settle reads, a post's read): only a read
  // started after the one shown may replace it, so a slow one never puts
  // older turns back.
  const order = useRef({ shown: 0, started: 0 });
  const read = useCallback(
    (alive: () => boolean) => {
      order.current.started += 1;
      const n = order.current.started;
      structuredTurns(sessionId)
        .then((next) => {
          if (alive() && n > order.current.shown) {
            order.current.shown = n;
            setTurns(next);
          }
        })
        .catch(() => {
          // Keep what is shown; the next read heals it.
        });
    },
    [sessionId]
  );
  // While Claude works, read on a beat too: each read pulls the companion's
  // newest rows in first, so steps show as they happen. When it stops, read
  // again at once, so the finished reply lands without waiting for a post.
  useEffect(() => {
    let alive = true;
    const isAlive = () => alive;
    if (!live) {
      const timers = SETTLE_READS_MS.map((ms) =>
        window.setTimeout(() => read(isAlive), ms)
      );
      return () => {
        alive = false;
        for (const timer of timers) {
          window.clearTimeout(timer);
        }
      };
    }
    const timer = window.setInterval(() => read(isAlive), LIVE_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [live, read]);
  useEffect(() => {
    let alive = true;
    const isAlive = () => alive;
    let timer: number | undefined;
    // When a post last caused a read; the first post is never held back.
    let lastPostRead = Number.NEGATIVE_INFINITY;
    read(isAlive);
    const stop = onEvent(onCompanionChanged, (update) => {
      if (update.sessionId !== sessionId || timer !== undefined) {
        return;
      }
      const wait = lastPostRead + REFRESH_GAP_MS - Date.now();
      const postRead = () => {
        timer = undefined;
        lastPostRead = Date.now();
        read(isAlive);
      };
      if (wait <= 0) {
        postRead();
      } else {
        timer = window.setTimeout(postRead, wait);
      }
    });
    return () => {
      alive = false;
      stop();
      window.clearTimeout(timer);
    };
  }, [read, sessionId]);
  return turns;
}

const rootStyle: CSSProperties = {
  background: tokens.color.chrome.content,
  color: tokens.color.text,
  display: "flex",
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  height: "100%",
  overflowY: "auto",
};

const columnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xl,
  margin: "0 auto",
  maxWidth: "760px",
  padding: "20px 24px",
  width: "100%",
};

/** The user's side of a turn: held to the right, so it reads as theirs at
 *  a glance and Claude's side keeps the full column. */
const youStyle: CSSProperties = {
  alignItems: "flex-end",
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
};

/** The prompt as a speech card in a wash of the accent, its corner nearest
 *  the user's edge tucked in like a bubble's tail. */
const promptStyle: CSSProperties = {
  background: accentAlpha(0.1),
  border: `1px solid ${accentAlpha(0.22)}`,
  // One shorthand, so no later corner key can undo the tail.
  borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} ${tokens.radius.sm} ${tokens.radius.xl}`,
  color: tokens.color.ink.bright,
  fontSize: "14px",
  lineHeight: 1.5,
  margin: 0,
  maxWidth: "85%",
  overflowWrap: "anywhere",
  padding: "10px 14px",
  whiteSpace: "pre-wrap",
};

const claudeStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  minWidth: 0,
};

const speakerStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.secondary,
  display: "flex",
  fontSize: "12px",
  fontWeight: 500,
  gap: "6px",
};

const workingStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  display: "flex",
  fontSize: "12.5px",
  gap: tokens.space.sm,
};

const mutedStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12px",
};

const monoStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const summaryStyle: CSSProperties = {
  ...mutedStyle,
  cursor: "pointer",
  display: "flex",
  gap: tokens.space.sm,
};

const didListStyle: CSSProperties = {
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xs,
  marginTop: tokens.space.sm,
  paddingLeft: tokens.space.md,
};

const footerStyle: CSSProperties = {
  ...mutedStyle,
  borderTop: `1px solid ${tokens.color.line.soft}`,
  padding: "10px 24px",
};

const bannerStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.md,
};

/** A flat tile behind the [Mascot], so a dark one still reads on the dark
 *  canvas. */
const mascotTileStyle: CSSProperties = {
  alignItems: "center",
  // A trick that ducks or hops out of the tile is clipped by it, so a peek
  // reads as ducking behind its edge.
  overflow: "hidden",
  background: tokens.color.surface.s3,
  border: `1px solid ${tokens.color.line.soft}`,
  borderRadius: tokens.radius.xl,
  display: "flex",
  flex: "none",
  height: "58px",
  justifyContent: "center",
  width: "58px",
};

const bannerTitleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "13px",
  fontWeight: 600,
};

const metaLineStyle: CSSProperties = {
  ...mutedStyle,
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.sm,
};

const thumbsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.sm,
};

const THUMB_HEIGHT = 96;

const jumpStyle: CSSProperties = {
  ...button("secondary", "sm"),
  borderRadius: tokens.radius.pill,
  bottom: "52px",
  boxShadow: tokens.shadow.pop,
  left: "50%",
  position: "absolute",
  transform: "translateX(-50%)",
};

/** Within this many pixels of the bottom counts as reading the latest. */
const FOLLOW_SLACK_PX = 48;

const noticeStyle: CSSProperties = {
  ...columnStyle,
  alignItems: "flex-start",
  gap: tokens.space.md,
};

function Item({ item }: { item: TurnItem }) {
  switch (item.kind) {
    case "text":
      return <p style={{ ...mutedStyle, margin: 0 }}>“{item.text}”</p>;
    case "thought":
      return <span style={mutedStyle}>{thoughtLabel(item.durationMs)}</span>;
    case "compacted":
      return (
        <span style={mutedStyle}>
          Compacted here: earlier turns were summarized for Claude
        </span>
      );
    default:
      return (
        <div title={item.result ?? undefined}>
          <span
            style={{
              ...mutedStyle,
              color: item.isError
                ? tokens.color.status.error
                : tokens.color.ink.primary,
            }}
          >
            {stepVerb(item.stepKind)} {item.name}
            {item.isError ? " · failed" : ""}
          </span>
          <div style={monoStyle}>
            <InlineText pieces={linkText(item.input)} />
          </div>
        </div>
      );
  }
}

/** One prompt image: a thumbnail that opens full size. */
function Thumb({ path }: { path: string }) {
  const url = useImagePreview(path);
  const cwd = useContext(LinkCwd);
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() ?? path;
  if (url === null) {
    return <span style={chip()}>{name} (gone)</span>;
  }
  return (
    <>
      <button
        aria-label={`View ${name}`}
        className="kr-focusable"
        onClick={() => setOpen(true)}
        style={{
          background: tokens.color.blockWell,
          border: `1px solid ${tokens.color.line.soft}`,
          borderRadius: tokens.radius.md,
          cursor: "zoom-in",
          height: THUMB_HEIGHT,
          minWidth: THUMB_HEIGHT,
          overflow: "hidden",
          padding: 0,
        }}
        title={path}
        type="button"
      >
        {url ? (
          <img
            alt={name}
            height={THUMB_HEIGHT}
            src={url}
            style={{ display: "block", height: THUMB_HEIGHT, width: "auto" }}
            width={THUMB_HEIGHT}
          />
        ) : null}
      </button>
      {open ? (
        <ImageLightbox
          name={name}
          onClose={() => setOpen(false)}
          onOpen={() => {
            // A picture outside the project opens with the user's leave.
            openFileToken(cwd, path, false);
          }}
          path={path}
        />
      ) : null}
    </>
  );
}

/** How often the terminal is read for the spinner's lines while Claude works. */
const TIP_POLL_MS = 1500;

/** What the CLI's spinner shows while Claude works. */
interface SpinnerLines {
  /** The todo task it names, when it names one. */
  task: string | null;
  tip: SpinnerTip | null;
}

const NO_SPINNER: SpinnerLines = { task: null, tip: null };

/**
 * The task and tip Claude Code shows at its spinner, read off the session's
 * own terminal while Claude works. A tip is kept for the turn once seen (the
 * CLI picks one a turn); both are gone when Claude stops.
 */
function useSpinner(sessionId: string, busy: boolean): SpinnerLines {
  const [lines, setLines] = useState<SpinnerLines>(NO_SPINNER);
  useEffect(() => {
    if (!busy) {
      setLines(NO_SPINNER);
      return;
    }
    const read = () => {
      const rows = screenText(sessionId);
      const task = spinnerTask(rows);
      const seen = spinnerTip(rows);
      setLines((last) => {
        const tip =
          seen === null ||
          (last.tip?.text === seen.text && last.tip.label === seen.label)
            ? last.tip
            : seen;
        return last.task === task && last.tip === tip ? last : { task, tip };
      });
    };
    read();
    const timer = window.setInterval(read, TIP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, sessionId]);
  return lines;
}

const oneLineStyle: CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tipStyle: CSSProperties = {
  ...mutedStyle,
  alignItems: "flex-start",
  display: "flex",
  gap: tokens.space.sm,
  lineHeight: 1.5,
  marginLeft: "21px",
};

function Working({
  spinner,
  step,
}: {
  spinner: SpinnerLines;
  /** The step Claude is in now, in plain words. */
  step: string | null;
}) {
  const { task, tip } = spinner;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div aria-live="polite" role="status" style={workingStyle}>
        <LoaderCircle
          aria-hidden
          size={13}
          style={{ animation: "kr-spin 0.7s linear infinite", flex: "none" }}
        />
        {task ?? "Claude is working…"}
      </div>
      {step === null ? null : (
        <div style={{ ...tipStyle, ...oneLineStyle }} title={step}>
          {step}
        </div>
      )}
      {tip === null ? null : (
        <div style={tipStyle}>
          <Lightbulb
            aria-hidden
            size={12}
            style={{ flex: "none", marginTop: "2px" }}
          />
          <span>
            <span style={{ color: tokens.color.ink.secondary }}>
              {tip.label}:
            </span>{" "}
            {tip.text}
          </span>
        </div>
      )}
    </div>
  );
}

/** The line that ends a turn: copy the reply, when it was sent, how long it
 *  took, and whether it was stopped or came from the transcript. At the end,
 *  so a long reply never has to be scrolled back over to see it. */
function TurnMeta({ turn }: { turn: StructuredTurn }) {
  const took = durationLabel(turn.startedMs, turn.endedMs);
  const pieces: ReactNode[] = [];
  if (turn.startedMs !== null) {
    pieces.push(
      <time
        dateTime={new Date(turn.startedMs).toISOString()}
        key="at"
        title={new Date(turn.startedMs).toLocaleString()}
      >
        {clockLabel(turn.startedMs)}
      </time>
    );
  }
  if (took !== null && (turn.reply !== null || turn.did.length > 0)) {
    pieces.push(<span key="took">took {took}</span>);
  }
  if (turn.interrupted) {
    pieces.push(
      <span
        key="stopped"
        style={{
          ...chip(),
          color: tokens.color.status.waiting,
          fontSize: "11px",
        }}
      >
        Interrupted
      </span>
    );
  }
  if (turn.source === "transcript") {
    pieces.push(
      <span key="src" style={{ ...chip(), fontSize: "11px" }}>
        From transcript
      </span>
    );
  }
  if (pieces.length === 0 && turn.reply === null) {
    return null;
  }
  return (
    <div className="kr-copy-host" style={metaLineStyle}>
      {turn.reply === null ? null : (
        <CopyButton label="Copy reply" text={turn.reply} />
      )}
      {pieces}
    </div>
  );
}

/** A run of steps between two of Claude's messages, folded to one line. A
 *  run with no step in it (Claude only thought, or the conversation was
 *  compacted) has nothing to fold: it shows as is. */
function Steps({ items }: { items: TurnItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items.some((item) => item.kind === "step")) {
    return (
      <div style={didListStyle}>
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
          <Item item={item} key={index} />
        ))}
      </div>
    );
  }
  return (
    <div>
      <button
        aria-expanded={open}
        className="kr-focusable"
        onClick={() => setOpen(!open)}
        style={{
          ...summaryStyle,
          background: "none",
          border: "none",
          padding: 0,
        }}
        type="button"
      >
        <span>
          {open ? "▾" : "▸"} What Claude did · {didSummary(items)}
        </span>
      </button>
      {open ? (
        <div style={didListStyle}>
          {items.map((item, index) => (
            // Items have no id of their own and never reorder.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
            <Item item={item} key={index} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const reportsStyle: CSSProperties = {
  alignSelf: "flex-start",
  background: tokens.color.surface.s1,
  border: `1px solid ${tokens.color.line.soft}`,
  borderRadius: tokens.radius.lg,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xs,
  maxWidth: "100%",
  padding: `${tokens.space.sm} ${tokens.space.md}`,
};

const reportLineStyle: CSSProperties = {
  alignItems: "flex-start",
  color: tokens.color.ink.secondary,
  display: "flex",
  fontSize: "12.5px",
  gap: tokens.space.sm,
  lineHeight: 1.5,
};

/** Room the icon and its gap take, so a monitor's event lines up under the
 *  summary. */
const REPORT_ICON_PX = 14;

/** How each outcome looks, and the word a screen reader says for its icon. */
const REPORT_LOOK: Record<
  WorkReport["outcome"],
  { color: string; Icon: LucideIcon; label: string }
> = {
  completed: {
    color: tokens.color.status.done,
    Icon: CircleCheck,
    label: "Completed",
  },
  event: {
    color: tokens.color.status.running,
    Icon: Radio,
    label: "Monitor event",
  },
  failed: { color: tokens.color.status.error, Icon: CircleX, label: "Failed" },
  stopped: {
    color: tokens.color.ink.muted,
    Icon: CircleSlash,
    label: "Stopped",
  },
  update: { color: tokens.color.ink.muted, Icon: Bell, label: "Update" },
};

/** One [Work report]: an icon for how the work came out, Claude Code's
 *  summary with the work's name standing out, and what a monitor saw. */
function Report({ report }: { report: WorkReport }) {
  const { color, Icon, label } = REPORT_LOOK[report.outcome];
  const { after, before, name } = summaryParts(report.summary);
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={reportLineStyle}>
        <span
          aria-label={label}
          role="img"
          style={{ color, display: "flex", flex: "none", marginTop: "3px" }}
          title={label}
        >
          <Icon aria-hidden size={REPORT_ICON_PX} />
        </span>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          {before}
          {name === null ? null : (
            <span style={{ color: tokens.color.ink.bright, fontWeight: 500 }}>
              {name}
            </span>
          )}
          {after}
        </span>
      </div>
      {report.event === null ? null : (
        <span
          style={{
            ...monoStyle,
            paddingLeft: `calc(${REPORT_ICON_PX}px + ${tokens.space.sm})`,
          }}
          title={report.event}
        >
          {report.event}
        </span>
      )}
    </div>
  );
}

/** What woke Claude for a turn no one prompted: background work reporting
 *  back. A quiet card, so it never reads as something the user typed. */
function Reports({ reports }: { reports: WorkReport[] }) {
  return (
    <div style={reportsStyle}>
      {reports.map((report, index) => (
        // Reports have no id of their own and never reorder.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <Report key={index} report={report} />
      ))}
    </div>
  );
}

/** The user's prompt, with any images they sent beside it. */
function Prompt({
  children,
  images = [],
}: {
  children: ReactNode;
  images?: string[];
}) {
  return (
    <section aria-label="Your prompt" style={youStyle}>
      <p style={promptStyle}>{children}</p>
      {images.length === 0 ? null : (
        <div style={{ ...thumbsStyle, justifyContent: "flex-end" }}>
          {images.map((path) => (
            <Thumb key={path} path={path} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Claude's side of a turn, under its name and the CLI's own ✻ mark. */
function Claude({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Claude" style={claudeStyle}>
      <span aria-hidden style={speakerStyle}>
        <span style={{ color: tokens.color.accentBright, fontSize: "13px" }}>
          ✻
        </span>
        Claude
      </span>
      {children}
    </section>
  );
}

function Turn({
  live = null,
  turn,
}: {
  /** The reply as it streams, while this is the newest turn. */
  live?: string | null;
  turn: StructuredTurn;
}) {
  return (
    <article
      style={{ display: "flex", flexDirection: "column", gap: tokens.space.sm }}
    >
      {turn.prompt === null ? null : (
        <Prompt images={turn.images}>
          <InlineText
            pieces={linkText(shownPrompt(turn.prompt, turn.images.length))}
          />
        </Prompt>
      )}
      {turn.reports.length === 0 ? null : <Reports reports={turn.reports} />}
      {turn.did.length === 0 && (turn.reply ?? live) === null ? null : (
        <Claude>
          {turnSections(turn.did).map((section, index) =>
            // Sections have no id of their own and only append.
            section.kind === "text" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              <Markdown key={index} text={section.text} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              <Steps items={section.items} key={index} />
            )
          )}
          {/* One slot for the reply: the stream fills it, then the kept reply
              takes it over in the same element — no blank, no jump. */}
          {(turn.reply ?? live) === null ? null : (
            <Markdown text={turn.reply ?? live ?? ""} />
          )}
          {live !== null && turn.reply === null ? (
            <span aria-hidden style={caretStyle} />
          ) : null}
          {live !== null && turn.reply !== null ? (
            <LiveReply text={live} />
          ) : null}
        </Claude>
      )}
      <TurnMeta turn={turn} />
    </article>
  );
}

/**
 * The session's turns, and whether Claude is working. A status that missed
 * its `Stop` would say "working" forever: the transcript's own record of the
 * turn's end overrules it, and settles it.
 */
function useTurnsAndWork(sessionId: string): {
  running: boolean;
  turns: StructuredTurn[] | null;
} {
  const statusRunning = useSessions(
    (state) => state.sessions[sessionId]?.status === "running"
  );
  const turns = useStructuredTurns(sessionId, statusRunning);
  const now = useClockWhile(statusRunning);
  // Evidence only: the backend settles the status if that end came after the
  // newest prompt (the turn read may be the one before a prompt just sent).
  const end = statusRunning ? recordedEnd(turns ?? [], now) : null;
  const endedMs = end?.endedMs ?? null;
  const interrupted = end?.interrupted ?? false;
  useEffect(() => {
    if (endedMs !== null) {
      noteTurnEnded(sessionId, endedMs, interrupted).catch(() => undefined);
    }
  }, [endedMs, interrupted, sessionId]);
  return { running: statusRunning, turns };
}

/**
 * The [Sent prompt] to show before its turn arrives, or `null`. The stand-in
 * goes once the real turn is read; the sent prompt itself settles on its own
 * (see `send.ts`), whichever view is on screen.
 */
function useSentStandIn(
  sessionId: string,
  turns: StructuredTurn[] | null
): string | null {
  const sent = useSentPrompts((state) => state.sent[sessionId]);
  if (
    sent === undefined ||
    matchingTurn(turns ?? [], sent.text, sent.at) !== null
  ) {
    return null;
  }
  return sent.text || "(images)";
}

/**
 * Follow the newest turn while the user is at the bottom; stop following
 * once they scroll up to read, and offer a way back.
 */
function useFollowBottom(
  turns: StructuredTurn[] | null,
  pending: string | null,
  busy: boolean | string,
  card: ShownUsageCard | undefined
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: turns, pending, busy and the card are the signals that there is something new to follow.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && following) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns, pending, busy, card, following]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) {
      setFollowing(
        el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
      );
    }
  };
  const jump = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ behavior: "smooth", top: el.scrollHeight });
    }
    setFollowing(true);
  };
  return { following, jump, onScroll, scrollRef };
}

/**
 * Esc in the view stops Claude, as the CLI's own Esc does — when the press
 * is in the view or on nothing in particular (the page itself), and nothing
 * else on screen took it (a dialog, the image viewer, a menu). The composer
 * handles its own Esc; a text field elsewhere keeps its own.
 */
function useEscToInterrupt(
  sessionId: string,
  active: boolean,
  view: { current: HTMLElement | null }
) {
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const { target } = event;
      const inView =
        target === document.body ||
        target === document.documentElement ||
        (target instanceof Node && view.current?.contains(target) === true);
      if (!inView) {
        return;
      }
      // Overlays listen on `window` too; let every listener of this press
      // have its say first. A task, not a microtask: for a real key press
      // the browser runs microtasks between listeners, so a microtask would
      // look before a later overlay's listener had taken the key.
      window.setTimeout(() => {
        if (!event.defaultPrevented) {
          interruptSession(sessionId).catch(() => undefined);
        }
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, sessionId, view]);
}

/** The turns read so far, the newest with its reply as it streams (`live`),
 *  and the [Usage card] among them where it was asked for. */
function Turns({
  card,
  live,
  sessionId,
  turns,
}: {
  card: ShownUsageCard | undefined;
  live: string | null;
  sessionId: string;
  turns: StructuredTurn[];
}) {
  const slot = usageCardSlot(turns, card);
  const asked = card ? <UsageAnswer card={card} sessionId={sessionId} /> : null;
  return (
    <>
      {turns.map((turn, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: turns only append
        <Fragment key={index}>
          {index === slot ? asked : null}
          <Turn live={index === turns.length - 1 ? live : null} turn={turn} />
        </Fragment>
      ))}
      {slot === turns.length ? asked : null}
    </>
  );
}

/** The [Usage card] under the command it answers, as a turn of its own. */
function UsageAnswer({
  card,
  sessionId,
}: {
  card: ShownUsageCard;
  sessionId: string;
}) {
  return (
    <article
      style={{ display: "flex", flexDirection: "column", gap: tokens.space.sm }}
    >
      <Prompt>{card.command}</Prompt>
      <UsageCard sessionId={sessionId} />
    </article>
  );
}

function Banner({
  busy,
  cwd,
  version,
}: {
  busy: boolean;
  cwd: string;
  version: string | null;
}) {
  const mascot = useLayout((state) => state.layout.mascot);
  return (
    <header style={bannerStyle}>
      {mascot === "none" ? null : (
        <span style={mascotTileStyle}>
          <Mascot busy={busy} kind={mascot} lively size={46} />
        </span>
      )}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={bannerTitleStyle}>
          Claude Code{version ? ` ${version}` : ""}
        </span>
        <span style={monoStyle} title={cwd}>
          {cwd}
        </span>
      </div>
    </header>
  );
}

/**
 * Why the Structured view can't show this session, and the one thing that
 * fixes it: turn the companion on, or restart the session for it.
 */
function CompanionNotice({
  sessionId,
  state,
}: {
  sessionId: string;
  state: CompanionStatus;
}) {
  // The [Usage card] needs no turns, so `/usage` still answers here.
  const card = useUsageCards((store) => store.shown[sessionId]);
  const setTranscriptView = useLayout((store) => store.setTranscriptView);
  const integration = useIntegration((store) => store.status);
  const update = useIntegration((store) => store.update);
  const canTurnOn =
    state.state === "off" && integration?.companionAvailable === true;
  // Until the setup is read, whether it allows the companion is unknown.
  const setupWhy =
    integration === null ? null : companionHint(integration.companionAvailable);
  const why =
    companionChip(state)?.title ??
    (canTurnOn
      ? "Kriyon Companion is off. Turn it on to see each turn as prompt, steps and reply. Sessions you start after that get it."
      : setupWhy);
  return (
    <div data-testid="structured-view" style={rootStyle}>
      <div style={noticeStyle}>
        <p style={replyStyle}>The Structured view needs Kriyon Companion.</p>
        {why === null ? null : <p style={mutedStyle}>{why}</p>}
        <div style={{ display: "flex", gap: tokens.space.sm }}>
          {canTurnOn && integration ? (
            <button
              className="kr-focusable kr-hover-accent"
              onClick={() => {
                // The companion rides on the hooks' plugin, so it needs them.
                update({
                  ...integration.prefs,
                  companion: true,
                  statusHooks: true,
                }).catch(() => undefined);
              }}
              style={button("primary")}
              type="button"
            >
              Turn on Kriyon Companion
            </button>
          ) : null}
          <button
            className="kr-focusable kr-hover-surface"
            onClick={() => setTranscriptView("raw", false)}
            style={button("secondary")}
            type="button"
          >
            Open the terminal
          </button>
        </div>
      </div>
      {card ? (
        <div style={columnStyle}>
          <UsageAnswer card={card} sessionId={sessionId} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The [Structured view]: each turn as its prompt, a folded "What Claude did",
 * and the reply. Read-only — the terminal stays the source of truth. Exact
 * only while the companion is on; otherwise it says why and points back to
 * the terminal.
 */
export function StructuredView({ sessionId }: { sessionId: string }) {
  const status = useCompanionStatus(sessionId);
  const { running, turns } = useTurnsAndWork(sessionId);
  const partial = usePartialReply(sessionId, running);
  const cwd = useSessions((state) =>
    sessionWorkingDir(state.sessions[sessionId])
  );
  const pending = useSentStandIn(sessionId, turns);
  const busy = running || pending !== null;
  const streaming = liveText(partial, turns ?? []);
  const spinner = useSpinner(sessionId, busy);
  // A prompt not read in yet has no steps: the newest turn read is the one
  // before it.
  const step =
    pending === null ? stepInProgress(turns?.[turns.length - 1]) : null;
  const card = useUsageCards((state) => state.shown[sessionId]);
  const follow = useFollowBottom(turns, pending, streaming ?? busy, card);
  const enabled = !status || status.state === "on";
  // An Esc would reach an open dialog (even one put aside) and cancel it.
  const inDialog = useCliDialog(sessionId);
  useEscToInterrupt(sessionId, enabled && busy && !inDialog, follow.scrollRef);
  if (status && status.state !== "on") {
    return <CompanionNotice sessionId={sessionId} state={status} />;
  }
  return (
    <LinkCwd.Provider value={cwd}>
      <div style={{ height: "100%", position: "relative" }}>
        <div
          data-testid="structured-view"
          onScroll={follow.onScroll}
          ref={follow.scrollRef}
          style={rootStyle}
        >
          <div style={{ ...columnStyle, flex: 1 }}>
            <Banner
              busy={busy}
              cwd={cwd}
              version={status?.claudeVersion ?? null}
            />
            {turns?.length === 0 && pending === null && !card ? (
              <p style={mutedStyle}>
                No turns yet. They appear here as Claude works.
              </p>
            ) : null}
            <Turns
              card={card}
              live={pending === null ? streaming : null}
              sessionId={sessionId}
              turns={turns ?? []}
            />
            {pending === null ? null : <Prompt>{pending}</Prompt>}
            {pending !== null && streaming !== null ? (
              <Claude>
                <LiveReply text={streaming} />
              </Claude>
            ) : null}
            {busy ? <Working spinner={spinner} step={step} /> : null}
          </div>
          <div style={footerStyle}>
            {busy && !inDialog ? "Esc stops Claude · " : ""}Paste or drop files
            to attach them
          </div>
        </div>
        {follow.following ? null : (
          <button
            className="kr-focusable kr-hover-surface"
            onClick={follow.jump}
            style={jumpStyle}
            type="button"
          >
            <ArrowDown size={12} />
            Jump to latest
          </button>
        )}
      </div>
    </LinkCwd.Provider>
  );
}
