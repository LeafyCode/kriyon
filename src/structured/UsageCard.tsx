import { Gauge, Terminal, X } from "lucide-react";
import { type CSSProperties, useId } from "react";
import { usePlanLimitsView } from "../state/planLimits.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { useSessions } from "../state/sessions.ts";
import {
  formatTokens,
  LIMIT_NOTE,
  type LimitReading,
  sessionUsageView,
  type UsageTone,
  usageTone,
} from "../state/usage.ts";
import { useUsageCards } from "../state/usageCards.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { useCliDialog } from "./cliDialog.ts";
import { sendPrompt } from "./send.ts";

/**
 * The [Usage card]: Kriyon's own answer to `/usage` in the [Structured view] —
 * the session's context window and the account's [Plan limits], live, from
 * what Claude reported (ADR-0038). Claude's own pane has more (per-model
 * limits, cost); the footer opens it in the terminal.
 */

const ONE_MILLION = 1_000_000;

/** "1M", "200k": a context window's size, the way Claude names it. */
function windowSize(n: number): string {
  return n % ONE_MILLION === 0 ? `${n / ONE_MILLION}M` : formatTokens(n);
}

const TONE: Record<UsageTone, { fill: string; ink: string }> = {
  full: { fill: tokens.color.status.error, ink: tokens.color.status.error },
  high: {
    fill: tokens.color.status.waiting,
    ink: tokens.color.status.waitingInk,
  },
  normal: { fill: tokens.color.accent, ink: tokens.color.ink.bright },
};

const ALERT_FILL: Record<Exclude<UsageTone, "normal">, string> = {
  full: tokens.color.status.errorSoft,
  high: tokens.color.status.waitingSoft,
};

const cardStyle: CSSProperties = {
  background: tokens.color.raised,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  alignItems: "center",
  borderBottom: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  gap: tokens.space.sm,
  height: "46px",
  padding: `0 ${tokens.space.sm} 0 ${tokens.space.lg}`,
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "14px",
  fontWeight: 500,
  margin: 0,
};

const pillStyle: CSSProperties = {
  borderRadius: tokens.radius.pill,
  fontSize: "11px",
  padding: "2px 8px",
  whiteSpace: "nowrap",
};

const closeStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  height: "28px",
  justifyContent: "center",
  marginLeft: "auto",
  width: "28px",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.lg,
  padding: tokens.space.lg,
};

const sectionLabelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const dividerStyle: CSSProperties = {
  background: tokens.color.line.base,
  height: "1px",
  margin: `0 ${tokens.space.lg}`,
};

const limitsStyle: CSSProperties = {
  display: "grid",
  gap: tokens.space.xl,
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
};

const meterHeadStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  gap: tokens.space.sm,
};

const meterLabelStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontSize: "13px",
  marginRight: "auto",
};

const detailStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "12px",
};

const percentStyle: CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: "20px",
  fontWeight: 500,
};

const trackStyle: CSSProperties = {
  background: tokens.color.inputWell,
  borderRadius: tokens.radius.pill,
  height: "6px",
  overflow: "hidden",
};

const captionStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12px",
};

const footerStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.sidebar,
  borderTop: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.lg,
  padding: `${tokens.space.md} ${tokens.space.lg}`,
};

const noteStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "1 1 280px",
  fontSize: "12px",
  lineHeight: 1.5,
};

/** One figure: its label, a reading, the bar, and a line under it. */
function Meter({
  caption,
  detail,
  label,
  percent,
  testId,
}: {
  caption: string;
  detail?: string;
  label: string;
  percent: number | null;
  testId: string;
}) {
  const level = usageTone(percent);
  const tone = TONE[level];
  const shown = percent === null ? null : Math.round(percent);
  return (
    <div
      data-testid={testId}
      style={{ display: "flex", flexDirection: "column", gap: tokens.space.sm }}
    >
      <div style={meterHeadStyle}>
        <span style={meterLabelStyle}>{label}</span>
        {detail ? <span style={detailStyle}>{detail}</span> : null}
        <span
          style={{
            ...percentStyle,
            color: shown === null ? tokens.color.ink.muted : tone.ink,
          }}
        >
          {shown === null ? "—" : `${shown}%`}
        </span>
      </div>
      <div style={trackStyle}>
        <div
          style={{
            background: tone.fill,
            borderRadius: tokens.radius.pill,
            height: "100%",
            width: `${Math.min(100, shown ?? 0)}%`,
          }}
        />
      </div>
      <span
        style={{
          ...captionStyle,
          color: level === "normal" ? tokens.color.ink.muted : tone.ink,
        }}
      >
        {caption}
      </span>
    </div>
  );
}

function Limit({ limit }: { limit: LimitReading }) {
  return (
    <Meter
      caption={`Resets ${limit.resets}`}
      label={limit.label}
      percent={limit.percent}
      testId={`usage-card-${limit.id}`}
    />
  );
}

/** "60.8k of 1M": what the context window holds, out of its size. */
function contextDetail(
  tokensNow: number | null,
  size: number | null
): string | undefined {
  if (tokensNow === null) {
    return;
  }
  return size === null
    ? formatTokens(tokensNow)
    : `${formatTokens(tokensNow)} of ${windowSize(size)}`;
}

/** Why Claude's own pane can't be opened now, or `null` when it can. */
function useFullPanelBlocked(sessionId: string): string | null {
  const inDialog = useCliDialog(sessionId);
  const pending = useSentPrompts(
    (state) => state.sent[sessionId] !== undefined
  );
  if (inDialog) {
    // Its Enter would answer the dialog instead.
    return "Claude Code is showing a dialog. Answer or close it first.";
  }
  // Typing now would replace the prompt still waiting to be read.
  return pending ? "Wait until Claude has read your last message." : null;
}

export function UsageCard({ sessionId }: { sessionId: string }) {
  const live = useSessions((state) => state.usage[sessionId]);
  const limits = usePlanLimitsView();
  const close = useUsageCards((state) => state.close);
  const blocked = useFullPanelBlocked(sessionId);
  const titleId = useId();
  const view = sessionUsageView(live);
  const { alert } = limits;
  return (
    <section aria-labelledby={titleId} style={cardStyle}>
      <div style={headerStyle}>
        <Gauge aria-hidden color={tokens.color.accentBright} size={16} />
        <h2 id={titleId} style={titleStyle}>
          Usage
        </h2>
        {alert === null ? (
          <span
            style={{
              ...pillStyle,
              background: tokens.color.surface.s2,
              border: `1px solid ${tokens.color.line.base}`,
              color: tokens.color.ink.muted,
            }}
          >
            Kriyon · not sent to Claude
          </span>
        ) : (
          <span
            data-testid="usage-card-alert"
            style={{
              ...pillStyle,
              background: ALERT_FILL[alert.tone],
              color: TONE[alert.tone].ink,
            }}
          >
            {alert.text}
          </span>
        )}
        <button
          aria-label="Close usage"
          className="kr-focusable kr-hover-surface"
          onClick={() => close(sessionId)}
          style={closeStyle}
          type="button"
        >
          <X aria-hidden size={14} />
        </button>
      </div>

      <div style={sectionStyle}>
        <span style={sectionLabelStyle}>This session</span>
        <Meter
          caption={live?.model ?? "Shows after Claude's next reply"}
          detail={contextDetail(
            view.contextTokens,
            live?.contextWindowSize ?? null
          )}
          label="Context window"
          percent={view.ctxPct}
          testId="usage-card-context"
        />
      </div>

      <div style={dividerStyle} />

      <div style={sectionStyle}>
        <span style={sectionLabelStyle}>Plan · every session</span>
        {limits.windows.length > 0 ? (
          <div style={limitsStyle}>
            {limits.windows.map((limit) => (
              <Limit key={limit.id} limit={limit} />
            ))}
          </div>
        ) : (
          <span style={{ ...captionStyle, color: tokens.color.ink.secondary }}>
            No plan limits reported yet. They show after Claude's next reply in
            any session. A login with an API key has none.
          </span>
        )}
      </div>

      <div style={footerStyle}>
        <span style={noteStyle}>{LIMIT_NOTE}</span>
        <button
          className="kr-focusable kr-hover-surface"
          disabled={blocked !== null}
          onClick={() =>
            sendPrompt(sessionId, {
              at: Date.now(),
              attachments: [],
              draft: "/usage",
              text: "/usage",
            })
          }
          style={{
            ...button("secondary"),
            // The composer's own disabled look.
            ...(blocked === null
              ? {}
              : {
                  color: tokens.color.ink.faint,
                  cursor: "default",
                  opacity: 0.5,
                }),
          }}
          title={blocked ?? undefined}
          type="button"
        >
          <Terminal aria-hidden size={12} />
          Claude's full panel
        </button>
      </div>
    </section>
  );
}
