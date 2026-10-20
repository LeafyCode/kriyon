import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { keptFor } from "../inspector/activityLog/activityLog.ts";
import {
  activityStats,
  DEFAULT_INTEGRATION_PREFS,
  FALLBACK_RETENTION_DAYS,
  quitApp,
} from "../ipc/bridge.ts";
import { ON_OFF_OPTIONS } from "../settings/settingsOptions.ts";
import { useIntegration } from "../state/integration.ts";
import { type SessionView, useLayout } from "../state/layout.ts";
import { button, card, overlayPanel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Segmented } from "../ui/Segmented.tsx";
import { companionHint, hooksHint, liveUsageHint } from "./integrationCopy.ts";

/**
 * The first-run consent screen: plainly what Kriyon adds to Claude Code, before
 * any of it is written. Continue gives consent with the choices made; Cancel
 * quits, leaving Claude Code exactly as it was.
 */

const pageStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.window,
  display: "flex",
  height: "100%",
  justifyContent: "center",
  overflowY: "auto",
  padding: tokens.space.xl,
};

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: tokens.space.lg,
  maxWidth: "560px",
  padding: tokens.space.xl,
  width: "100%",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "18px",
  fontWeight: 700,
  margin: 0,
};

const textStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  lineHeight: 1.55,
  margin: 0,
};

const itemStyle: CSSProperties = {
  ...card(),
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xs,
  padding: tokens.space.md,
};

const itemHeadStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.md,
  justifyContent: "space-between",
};

const itemTitleStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "13px",
  fontWeight: 600,
};

const tagStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  whiteSpace: "nowrap",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  gap: tokens.space.sm,
  justifyContent: "flex-end",
};

const errorStyle: CSSProperties = {
  ...textStyle,
  color: tokens.color.status.error,
};

/** One thing Kriyon adds: its name, its switch (or why there is none), what it does. */
function Item({
  children,
  control,
  title,
}: {
  children: ReactNode;
  control?: ReactNode;
  title: string;
}) {
  return (
    <div style={itemStyle}>
      <div style={itemHeadStyle}>
        <span style={itemTitleStyle}>{title}</span>
        {control}
      </div>
      <p style={textStyle}>{children}</p>
    </div>
  );
}

function OnOff({
  label,
  lockedOff,
  on,
  onChange,
}: {
  label: string;
  /** Why "On" can't be picked right now, if it can't. */
  lockedOff?: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const options = lockedOff
    ? ON_OFF_OPTIONS.map((option) =>
        option.value === "on"
          ? { ...option, disabled: true, title: lockedOff }
          : option
      )
    : ON_OFF_OPTIONS;
  return (
    <Segmented
      ariaLabel={label}
      onChange={(value) => onChange(value === "on")}
      options={options}
      value={on ? "on" : "off"}
    />
  );
}

function QuitButton() {
  return (
    <button
      className="kr-focusable kr-hover-surface"
      onClick={() => {
        quitApp("stopAll").catch(() => {
          // The app is going away either way; nothing to recover.
        });
      }}
      style={button("secondary")}
      type="button"
    >
      Cancel and quit
    </button>
  );
}

/** The integration couldn't be read: say why, and offer a way forward. */
function LoadFailed({ error }: { error: string }) {
  const load = useIntegration((state) => state.load);
  return (
    <div style={pageStyle}>
      <div
        aria-labelledby="welcome-title"
        role="alertdialog"
        style={panelStyle}
      >
        <h1 id="welcome-title" style={titleStyle}>
          Kriyon couldn't read its settings
        </h1>
        <p style={errorStyle}>{error}</p>
        <div style={actionsStyle}>
          <QuitButton />
          <button
            className="kr-focusable kr-hover-accent"
            onClick={() => {
              load().catch(() => {
                // A failed retry is recorded on the store as `error`.
              });
            }}
            style={button("primary")}
            type="button"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

/** The [Activity log]'s retention as the backend sets it, or the fallback. */
function useRetentionDays(): number {
  const [days, setDays] = useState(FALLBACK_RETENTION_DAYS);
  useEffect(() => {
    let alive = true;
    activityStats()
      .then((stats) => {
        if (alive) {
          setDays(stats.retentionDays);
        }
      })
      .catch(() => {
        // The fallback stands; the welcome screen must not block on stats.
      });
    return () => {
      alive = false;
    };
  }, []);
  return days;
}

export function WelcomeScreen() {
  const status = useIntegration((state) => state.status);
  const error = useIntegration((state) => state.error);
  const update = useIntegration((state) => state.update);
  const [statusHooks, setStatusHooks] = useState(
    status?.prefs.statusHooks ?? true
  );
  const [liveUsage, setLiveUsage] = useState(status?.prefs.liveUsage ?? true);
  const [companion, setCompanion] = useState(
    status?.prefs.companion ?? DEFAULT_INTEGRATION_PREFS.companion
  );
  const [sessionView, setSessionView] = useState<SessionView>(
    () => useLayout.getState().layout.preferredSessionView
  );
  const [busy, setBusy] = useState(false);
  const retentionDays = useRetentionDays();
  if (!status) {
    return error ? <LoadFailed error={error} /> : <div style={pageStyle} />;
  }
  // The Structured view is exact only from the companion's rows (ADR-0035).
  const companionOn = companion && statusHooks && status.companionAvailable;
  const opensIn: SessionView = companionOn ? sessionView : "raw";
  const agree = () => {
    setBusy(true);
    useLayout.getState().setTranscriptView(opensIn);
    update({
      ...status.prefs,
      // The companion rides on the hooks' plugin; without them it can't run.
      companion: companionOn,
      consented: true,
      liveUsage,
      statusHooks,
    }).finally(() => setBusy(false));
  };
  return (
    <div data-testid="welcome-screen" style={pageStyle}>
      <div aria-labelledby="welcome-title" role="dialog" style={panelStyle}>
        <h1 id="welcome-title" style={titleStyle}>
          Welcome to Kriyon
        </h1>
        <p style={textStyle}>
          Kriyon runs your own Claude Code in a real terminal and shows what
          each session is doing. To see that, it adds a few things to Claude
          Code. Choose what to add below — nothing is added until you continue,
          and you can change or remove any of it later in Settings.
        </p>
        <Item
          control={
            <OnOff
              label="Status hooks"
              on={statusHooks}
              onChange={setStatusHooks}
            />
          }
          title="Status hooks"
        >
          A small script Claude Code runs at each step — a prompt, a tool call,
          the end of a turn. It writes to ~/.claude/kriyon/ and does nothing in
          sessions Kriyon didn't start. {hooksHint(status.plannedReason)}
        </Item>
        <Item
          control={
            <OnOff label="Live usage" on={liveUsage} onChange={setLiveUsage} />
          }
          title="Live usage and plan limits"
        >
          {liveUsageHint(status)}
        </Item>
        <Item
          control={
            status.companionAvailable ? (
              <OnOff
                label="Kriyon Companion"
                lockedOff={
                  statusHooks ? undefined : "Needs status hooks turned on."
                }
                on={companion && statusHooks}
                onChange={setCompanion}
              />
            ) : null
          }
          title="Kriyon Companion"
        >
          {companionHint(status.companionAvailable)}
        </Item>
        <Item
          control={
            <Segmented
              ariaLabel="Open sessions in"
              onChange={setSessionView}
              options={[
                { label: "Terminal", value: "raw" },
                {
                  disabled: !companionOn,
                  label: "Structured",
                  title: companionOn
                    ? undefined
                    : "Needs Kriyon Companion turned on.",
                  value: "structured",
                },
              ]}
              value={opensIn}
            />
          }
          title="Open sessions in"
        >
          The terminal shows Claude Code exactly as it runs. The Structured view
          shows each turn as your prompt, what Claude did, and its reply, with
          images and files you attach — it needs Kriyon Companion. Switch any
          time from the session's header; Kriyon remembers your choice.
        </Item>
        <Item
          control={<span style={tagStyle}>Comes with status hooks</span>}
          title="Activity log"
        >
          What Claude did in each session — commands, file changes, web use.{" "}
          {keptFor(retentionDays)}, only on this Mac. Known secrets are hidden
          on a best-effort basis.
          {statusHooks ? null : " It stays empty while status hooks are off."}
        </Item>
        <p style={textStyle}>
          Sessions use your own Claude plan and its usage limits. Kriyon is not
          affiliated with Anthropic; Claude and Claude Code are trademarks of
          Anthropic, PBC.
        </p>
        {error ? <p style={errorStyle}>{error}</p> : null}
        <div style={actionsStyle}>
          <QuitButton />
          <button
            className="kr-focusable kr-hover-accent"
            disabled={busy}
            onClick={agree}
            style={button("primary")}
            type="button"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
