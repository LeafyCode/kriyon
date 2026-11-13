import { Minus, Play, Plus, Search } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { keptFor } from "../inspector/activityLog/activityLog.ts";
import {
  type ActivityStats,
  activityDeleteAll,
  activityStats,
  previewNotifySound,
  type UpdateSnapshot,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { ViewHeader } from "../layout/ViewHeader.tsx";
import { useIntegration } from "../state/integration.ts";
import {
  isNestedCap,
  NESTED_CAP_RANGE,
  type SidebarMode,
  useLayout,
} from "../state/layout.ts";
import { useTour } from "../state/tour.ts";
import { useUpdates } from "../state/updates.ts";
import {
  button,
  inputBox,
  pickerOption,
  row30,
  searchInput,
  sectionLabel,
} from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { NotifySound } from "../types.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Switch } from "../ui/Switch.tsx";
import { showToast } from "../ui/Toast.tsx";
import {
  companionHint,
  hooksHint,
  liveUsageHint,
  removalLines,
} from "../welcome/integrationCopy.ts";
import { MascotPicker } from "./MascotPicker.tsx";
import { RemoteSection } from "./RemoteSection.tsx";
import {
  errorTextStyle,
  groupLabelStyle,
  groupStyle,
  rowHintStyle,
  rowLabelStyle,
  rowTextStyle,
  SectionPage,
  SettingGroup,
  SettingRow,
} from "./SettingParts.tsx";
import {
  AUTO_SLEEP_OPTIONS,
  MEMORY_BUDGET_OPTIONS,
  MENU_BAR_OPTIONS,
  NOTIFY_OPTIONS,
  NOTIFY_SOUND_OPTIONS,
  SIDEBAR_MODE_OPTIONS,
  UPDATE_CHANNEL_OPTIONS,
} from "./settingsOptions.ts";
import {
  matchingSections,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "./settingsSections.ts";
import { ThemePicker } from "./ThemePicker.tsx";

const containerStyle: CSSProperties = {
  background: tokens.color.chrome.window,
  color: tokens.color.text,
  display: "flex",
  // The shell is a row since ADR-0023, so this view is a flex child of it:
  // `height: 100%` covers the cross axis, and `flex: 1` the main one. Without
  // the grow the view sizes to max-content and stops at the reading column.
  flex: 1,
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  height: "100%",
  minHeight: 0,
  minWidth: 0,
};

/** The side menu and the open section, side by side; the menu stacks on top
 *  when the column is too narrow for both. */
const bodyStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexWrap: "wrap",
  minHeight: 0,
  overflowY: "auto",
};

const navStyle: CSSProperties = {
  background: tokens.color.chrome.sidebar,
  borderRight: `1px solid ${tokens.color.border}`,
  display: "flex",
  flex: "1 1 180px",
  flexDirection: "column",
  gap: tokens.space.lg,
  maxWidth: "220px",
  padding: `${tokens.space.lg} ${tokens.space.sm}`,
};

const navGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const navGroupLabelStyle: CSSProperties = {
  ...sectionLabel(),
  padding: "0 10px 6px",
};

const navButtonStyle = (active: boolean): CSSProperties => ({
  ...row30({ active }),
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
});

const mainStyle: CSSProperties = {
  flex: "999 1 480px",
  minWidth: 0,
  padding: "28px 40px 56px",
};

const codeStyle: CSSProperties = {
  color: tokens.color.accentInk,
  fontFamily: tokens.font.mono,
  fontSize: "12px",
};

const emptyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "13px",
};

const searchBoxStyle: CSSProperties = {
  ...inputBox(),
  display: "flex",
  width: "240px",
};

/** Two groups side by side when the column has room for both. */
const groupGridStyle: CSSProperties = {
  alignItems: "start",
  display: "grid",
  gap: "20px",
  gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
};

const controlRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  flexWrap: "wrap",
  gap: tokens.space.sm,
};

const selectStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.primary,
  display: "inline-block",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  minWidth: "140px",
};

const stepperStyle: CSSProperties = {
  ...inputBox(),
  display: "inline-flex",
  gap: 0,
  overflow: "hidden",
  padding: 0,
};

const stepButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "inline-flex",
  height: "100%",
  justifyContent: "center",
  width: "30px",
};

function capInputStyle(off: boolean): CSSProperties {
  return {
    background: "transparent",
    borderBottom: "none",
    borderLeft: `1px solid ${tokens.color.line.base}`,
    borderRight: `1px solid ${tokens.color.line.base}`,
    borderTop: "none",
    color: tokens.color.ink.primary,
    fontFamily: tokens.font.mono,
    fontSize: "12.5px",
    height: "100%",
    opacity: off ? 0.5 : 1,
    textAlign: "center",
    width: "44px",
  };
}

const capNoteStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12px",
};

const capNoneStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "flex",
  fontSize: "12.5px",
  gap: tokens.space.xs,
};

/** The [Nested session cap]: a number, stepped or typed, or no limit. A typed
 *  number out of range is put back on blur rather than saved; turning the
 *  limit back on restores the last number. */
function NestedCapControl({
  onChange,
  value,
}: {
  onChange: (cap: number | null) => void;
  value: number | null;
}) {
  const [last, setLast] = useState(value ?? 4);
  const [draft, setDraft] = useState(String(value ?? last));
  const save = (cap: number) => {
    setLast(cap);
    setDraft(String(cap));
    onChange(cap);
  };
  const commit = () => {
    const cap = Number(draft);
    if (isNestedCap(cap)) {
      save(cap);
    } else {
      setDraft(String(last));
    }
  };
  const off = value === null;
  return (
    <div style={controlRowStyle}>
      <div style={stepperStyle}>
        <button
          aria-label="Fewer"
          className="kr-focusable kr-hover-surface"
          disabled={off || last <= NESTED_CAP_RANGE.min}
          onClick={() => save(last - 1)}
          style={stepButtonStyle}
          type="button"
        >
          <Minus size={13} strokeWidth={1.75} />
        </button>
        <input
          aria-label="Most busy at once"
          disabled={off}
          max={NESTED_CAP_RANGE.max}
          min={NESTED_CAP_RANGE.min}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
            }
          }}
          style={capInputStyle(off)}
          type="number"
          value={off ? "" : draft}
        />
        <button
          aria-label="More"
          className="kr-focusable kr-hover-surface"
          disabled={off || last >= NESTED_CAP_RANGE.max}
          onClick={() => save(last + 1)}
          style={stepButtonStyle}
          type="button"
        >
          <Plus size={13} strokeWidth={1.75} />
        </button>
      </div>
      <span style={capNoteStyle}>
        {NESTED_CAP_RANGE.min} to {NESTED_CAP_RANGE.max}
      </span>
      <label style={capNoneStyle}>
        <input
          checked={off}
          onChange={(event) => onChange(event.target.checked ? null : last)}
          type="checkbox"
        />
        No limit
      </label>
    </div>
  );
}

/**
 * What Kriyon adds to Claude Code — the [Integration] — with a switch for each
 * part and one button that takes it all out. Changes reach sessions started
 * after them.
 */
function IntegrationGroup() {
  const status = useIntegration((state) => state.status);
  const error = useIntegration((state) => state.error);
  const update = useIntegration((state) => state.update);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  if (!status) {
    return null;
  }
  const { prefs } = status;
  const anyOn = prefs.statusHooks || prefs.liveUsage || prefs.companion;
  return (
    <SettingGroup label="What Kriyon adds to Claude Code">
      <SettingRow
        control={
          <Switch
            ariaLabel="Status hooks"
            checked={prefs.statusHooks}
            onChange={(on) => {
              ignoreResult(update({ ...prefs, statusHooks: on }));
            }}
          />
        }
        hint={hooksHint(status.routeReason)}
        label="Status hooks"
      />
      <SettingRow
        control={
          <Switch
            ariaLabel="Live usage"
            checked={prefs.liveUsage}
            onChange={(on) => {
              ignoreResult(update({ ...prefs, liveUsage: on }));
            }}
          />
        }
        hint={liveUsageHint(status)}
        label="Live usage"
      />
      <SettingRow
        control={
          status.companionAvailable ? (
            <Switch
              ariaLabel="Kriyon Companion"
              checked={prefs.companion}
              onChange={(on) => {
                ignoreResult(update({ ...prefs, companion: on }));
              }}
            />
          ) : null
        }
        hint={companionHint(status.companionAvailable)}
        label="Kriyon Companion"
      />
      {prefs.sideloadRefused ? (
        <SettingRow
          control={
            <button
              className="kr-focusable kr-hover-surface"
              onClick={() => {
                ignoreResult(update({ ...prefs, sideloadRefused: false }));
              }}
              style={button("secondary")}
              type="button"
            >
              Try the plugin again
            </button>
          }
          hint="Claude Code refused Kriyon's per-session plugin once (your organization's policy), so the hooks moved to ~/.claude/settings.json. Try again if that policy changed."
          label="Per-session plugin"
        />
      ) : null}
      <SettingRow
        control={
          <button
            className="kr-focusable kr-hover-surface"
            disabled={!anyOn}
            onClick={() => setConfirmingRemove(true)}
            style={button("secondary")}
            type="button"
          >
            Remove from Claude Code
          </button>
        }
        hint="Takes Kriyon's hooks and status line out of Claude Code and puts your status line back."
        label="Remove everything"
      />
      {error ? <span style={errorTextStyle}>{error}</span> : null}
      {confirmingRemove ? (
        <ConfirmDialog
          body="Kriyon takes these out of Claude Code. Open sessions keep them until they restart. The activity log stays, and you can turn any of these back on here."
          confirmLabel="Remove"
          details={removalLines(status)}
          label="Cancel removing"
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => {
            setConfirmingRemove(false);
            ignoreResult(
              update({
                ...prefs,
                companion: false,
                liveUsage: false,
                statusHooks: false,
              })
            );
          }}
          title="Remove Kriyon from Claude Code?"
        />
      ) : null}
    </SettingGroup>
  );
}

/** What the last check found, for the "Check now" row. */
function checkLine(snapshot: UpdateSnapshot): string {
  if (snapshot.checking) {
    return "Checking…";
  }
  if (snapshot.error) {
    return `The last check failed: ${snapshot.error}`;
  }
  if (snapshot.available) {
    return `${snapshot.available.version} is available.`;
  }
  return snapshot.lastCheckedMs === null
    ? `You run ${snapshot.running}.`
    : `You run ${snapshot.running}, the newest on this channel.`;
}

/**
 * The in-app updater: which [Update channel] to follow, quiet checks on or
 * off, and "Check now". Rust does the checking; this only asks.
 */
function UpdatesGroup() {
  const snapshot = useUpdates((state) => state.snapshot);
  const error = useUpdates((state) => state.error);
  const { check, setPrefs } = useUpdates.getState();
  if (!snapshot) {
    return null;
  }
  if (!snapshot.supported) {
    return (
      <SettingGroup hideLabel label="Updates">
        <SettingRow
          control={null}
          hint={`This build (${snapshot.running}) can't update itself. Release builds can.`}
          label="Updates"
        />
      </SettingGroup>
    );
  }
  const { prefs } = snapshot;
  return (
    <SettingGroup hideLabel label="Updates">
      <SettingRow
        control={
          <Segmented
            ariaLabel="Update channel"
            onChange={(channel) => {
              ignoreResult(setPrefs(channel, prefs.autoCheck));
            }}
            options={UPDATE_CHANNEL_OPTIONS}
            value={prefs.channel}
          />
        }
        hint="Stable is tested releases. Beta is the next release early. Nightly is every day's changes, and can break."
        label="Channel"
      />
      <SettingRow
        control={
          <Switch
            ariaLabel="Check for updates automatically"
            checked={prefs.autoCheck}
            onChange={(on) => {
              ignoreResult(setPrefs(prefs.channel, on));
            }}
          />
        }
        hint="Quietly at launch and every 6 hours."
        label="Check automatically"
      />
      <SettingRow
        control={
          <button
            className="kr-focusable kr-hover-surface"
            disabled={snapshot.checking}
            onClick={() => {
              check()
                .then((found) => {
                  if (!(found || useUpdates.getState().snapshot?.error)) {
                    showToast("Kriyon is up to date.");
                  }
                })
                .catch(() => undefined);
            }}
            style={button("secondary")}
            type="button"
          >
            Check now
          </button>
        }
        hint={checkLine(snapshot)}
        label="Check for updates"
      />
      {error ? <span style={errorTextStyle}>{error}</span> : null}
    </SettingGroup>
  );
}

/** "12.4 MB" — the log's size, for a person. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The [Activity log]'s retention and size, and the one button that forgets
 * all of it (after a confirm).
 */
function ActivityGroup() {
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [confirming, setConfirming] = useState(false);
  const load = () => {
    activityStats()
      .then(setStats)
      .catch(() => setStats(null));
  };
  useEffect(load, []);
  const hint = stats
    ? `${keptFor(stats.retentionDays)} and up to ${megabytes(stats.sizeCapBytes)}, only on this Mac. Now ${stats.sessions} sessions, ${megabytes(stats.sizeBytes)}. Known secrets are hidden on a best-effort basis.`
    : "Kept only on this Mac.";
  return (
    <SettingGroup hideLabel label="Activity log">
      <SettingRow
        control={
          <button
            className="kr-focusable kr-hover-surface"
            onClick={() => setConfirming(true)}
            style={button("secondary")}
            type="button"
          >
            Delete all…
          </button>
        }
        hint={hint}
        label="Activity log"
      />
      {confirming ? (
        <ConfirmDialog
          body="Kriyon forgets what it logged for every session. Sessions and Claude Code's own transcripts stay."
          confirmLabel="Delete all activity"
          label="Keep the activity log"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            activityDeleteAll()
              .then(() => {
                showToast("Deleted all activity");
                load();
              })
              .catch((err: unknown) =>
                showToast(
                  `Couldn't delete the activity: ${failureMessage(err)}`,
                  "error"
                )
              );
          }}
          title="Delete all activity?"
        />
      ) : null}
    </SettingGroup>
  );
}

/** The store records a failed update as `error`, shown in the group. */
function ignoreResult(promise: Promise<void>): void {
  promise.catch(() => {
    // Recorded on the store as `error`; nothing more to do here.
  });
}

const sidebarCardStyle = (picked: boolean): CSSProperties => ({
  ...pickerOption(picked),
  display: "flex",
  flex: "1 1 240px",
  flexDirection: "column",
  fontSize: "12.5px",
  gap: tokens.space.md,
  minWidth: 0,
  padding: tokens.space.md,
  textAlign: "left",
});

const sketchStyle: CSSProperties = {
  background: tokens.color.chrome.sidebar,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "10px",
};

/** One sidebar row in a layout sketch: a status dot and a title bar. */
interface SketchRow {
  dot: string;
  faded?: boolean;
  width: string;
}

const CALM_SKETCH: SketchRow[] = [
  { dot: tokens.color.status.running, width: "70%" },
  { dot: tokens.color.status.waiting, width: "55%" },
  { dot: tokens.color.status.idle, width: "62%" },
  { dot: tokens.color.status.done, width: "48%" },
  { dot: tokens.color.status.idle, width: "58%" },
];

const TRIAGE_SKETCH: SketchRow[] = [
  { dot: tokens.color.status.waiting, width: "55%" },
  { dot: tokens.color.status.running, width: "70%" },
  { dot: tokens.color.status.idle, width: "62%" },
  { dot: tokens.color.status.done, faded: true, width: "48%" },
  { dot: tokens.color.status.done, faded: true, width: "58%" },
];

/** What each [Sidebar mode] card adds to its option: a hint and a sketch. A
 *  `Record`, so a new mode can't reach the picker without one. */
const SIDEBAR_CARDS: Record<
  SidebarMode,
  { hint: string; sketch: SketchRow[] }
> = {
  calm: {
    hint: "Shows every session, in the sort you picked.",
    sketch: CALM_SKETCH,
  },
  triage: {
    hint: "Floats active work to the top and folds read Done sessions away.",
    sketch: TRIAGE_SKETCH,
  },
};

const SIDEBAR_CHOICES = SIDEBAR_MODE_OPTIONS.map((option) => ({
  ...option,
  ...SIDEBAR_CARDS[option.value],
}));

/** Settings' choice of [Sidebar mode], each drawn as a small sketch. */
function SidebarModePicker() {
  const sidebarMode = useLayout((state) => state.layout.sidebarMode);
  const setSidebarMode = useLayout((state) => state.setSidebarMode);
  return (
    <fieldset
      aria-label="Sidebar"
      style={{
        border: "none",
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.space.md,
        margin: 0,
        minWidth: 0,
        padding: 0,
      }}
    >
      {SIDEBAR_CHOICES.map((choice) => (
        <button
          aria-describedby={`sidebar-mode-${choice.value}-hint`}
          aria-label={choice.label}
          aria-pressed={sidebarMode === choice.value}
          className="kr-focusable kr-hover-surface"
          key={choice.value}
          onClick={() => setSidebarMode(choice.value)}
          style={sidebarCardStyle(sidebarMode === choice.value)}
          type="button"
        >
          <span aria-hidden style={sketchStyle}>
            {choice.sketch.map((row, index) => (
              <span
                // The sketch is fixed; its order is its identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: a static sketch.
                key={index}
                style={{
                  alignItems: "center",
                  display: "flex",
                  gap: tokens.space.sm,
                  opacity: row.faded ? 0.4 : 1,
                }}
              >
                <span
                  style={{
                    background: row.dot,
                    borderRadius: tokens.radius.pill,
                    height: "7px",
                    width: "7px",
                  }}
                />
                <span
                  style={{
                    background: tokens.color.ink.dim,
                    borderRadius: tokens.radius.sm,
                    height: "4px",
                    width: row.width,
                  }}
                />
              </span>
            ))}
          </span>
          <span style={rowTextStyle}>
            <span style={rowLabelStyle}>{choice.label}</span>
            <span id={`sidebar-mode-${choice.value}-hint`} style={rowHintStyle}>
              {choice.hint}
            </span>
          </span>
        </button>
      ))}
    </fieldset>
  );
}

function AppearanceSection() {
  return (
    <SectionPage
      id="appearance"
      lead={
        <>
          Kriyon's colours and its mascot. Claude's own output follows its{" "}
          <code style={codeStyle}>/theme</code> setting.
        </>
      }
    >
      <ThemePicker />
      <SettingGroup hideLabel label="Mascot">
        <SettingRow
          control={<MascotPicker />}
          hint="Sits at the top of the Structured view and hops while Claude works."
          label="Mascot"
        />
      </SettingGroup>
    </SectionPage>
  );
}

function LayoutSection() {
  const menuBarMode = useLayout((state) => state.layout.menuBarMode);
  const setMenuBarMode = useLayout((state) => state.setMenuBarMode);
  return (
    <SectionPage
      id="layout"
      lead="How sessions are listed in the sidebar and the menu-bar quick view, and a tour of the window."
    >
      <section aria-label="Sidebar layout" style={groupStyle}>
        <span style={groupLabelStyle}>Sidebar</span>
        <SidebarModePicker />
      </section>
      <SettingGroup label="Menu bar">
        <SettingRow
          control={
            <Segmented
              ariaLabel="Menu bar mode"
              onChange={setMenuBarMode}
              options={MENU_BAR_OPTIONS}
              value={menuBarMode}
            />
          }
          hint="How the menu-bar quick view lays out its sessions."
          label="Quick view"
        />
      </SettingGroup>
      <SettingGroup label="Getting around">
        <SettingRow
          control={
            <button
              className="kr-focusable kr-hover-surface"
              onClick={() => useTour.getState().start()}
              style={button("secondary")}
              type="button"
            >
              Take the tour
            </button>
          }
          hint="A one-minute look at every part of the window. Also in Help → Kriyon Tour."
          label="App tour"
        />
      </SettingGroup>
    </SectionPage>
  );
}

function NotificationsSection() {
  const notifyPreference = useLayout((state) => state.layout.notifyPreference);
  const setNotifyPreference = useLayout((state) => state.setNotifyPreference);
  const notifySound = useLayout((state) => state.layout.notifySound);
  const setNotifySound = useLayout((state) => state.setNotifySound);
  return (
    <SectionPage
      id="notifications"
      lead="When and how Kriyon tells you a session needs you."
    >
      <SettingGroup hideLabel label="Notifications">
        <SettingRow
          control={
            <Segmented
              ariaLabel="Notifications"
              onChange={setNotifyPreference}
              options={NOTIFY_OPTIONS}
              value={notifyPreference}
            />
          }
          hint="Which sessions raise an OS notification."
          label="OS notifications"
        />
        <SettingRow
          control={
            <div style={controlRowStyle}>
              <select
                aria-label="Notification sound"
                className="kr-focusable"
                onChange={(event) =>
                  setNotifySound(event.target.value as NotifySound)
                }
                style={selectStyle}
                value={notifySound}
              >
                {NOTIFY_SOUND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                aria-label="Preview notification sound"
                className="kr-focusable kr-hover-surface"
                disabled={notifySound === "silent"}
                onClick={() => {
                  previewNotifySound(notifySound).catch((error) => {
                    // Best-effort preview: a resolve failure shouldn't crash
                    // the UI, but leave a breadcrumb so a silent failure is
                    // diagnosable rather than indistinguishable from a quiet
                    // sound.
                    // biome-ignore lint/suspicious/noConsole: a swallowed preview failure is worth logging.
                    console.error("preview notification sound failed", error);
                  });
                }}
                style={button("secondary")}
                type="button"
              >
                <Play size={11} strokeWidth={2} />
                Preview
              </button>
            </div>
          }
          hint="Plays when a session needs you or finishes."
          label="Sound"
        />
      </SettingGroup>
    </SectionPage>
  );
}

function SessionsSection() {
  const memoryBudgetMb = useLayout((state) => state.layout.memoryBudgetMb);
  const setMemoryBudgetMb = useLayout((state) => state.setMemoryBudgetMb);
  const memoryWarnEnabled = useLayout(
    (state) => state.layout.memoryWarnEnabled
  );
  const setMemoryWarnEnabled = useLayout((state) => state.setMemoryWarnEnabled);
  const nestedSessionCap = useLayout((state) => state.layout.nestedSessionCap);
  const setNestedSessionCap = useLayout((state) => state.setNestedSessionCap);
  const autoSleepAfter = useLayout((state) => state.layout.autoSleepAfter);
  const setAutoSleepAfter = useLayout((state) => state.setAutoSleepAfter);
  return (
    <SectionPage
      id="sessions"
      lead="Memory limits, sleeping idle sessions, and how many run at once."
    >
      <div style={groupGridStyle}>
        <SettingGroup label="Memory">
          <SettingRow
            control={
              <Switch
                ariaLabel="Memory warnings"
                checked={memoryWarnEnabled}
                onChange={setMemoryWarnEnabled}
              />
            }
            hint="When all sessions together use more memory than the budget."
            label="Warn over budget"
          />
          <SettingRow
            control={
              <Segmented
                ariaLabel="Memory budget"
                onChange={(value) => setMemoryBudgetMb(Number(value))}
                options={MEMORY_BUDGET_OPTIONS}
                value={String(memoryBudgetMb)}
              />
            }
            hint="Total memory across all sessions."
            label="Budget"
            stacked
          />
          <SettingRow
            control={
              <Segmented
                ariaLabel="Sleep idle sessions"
                onChange={setAutoSleepAfter}
                options={AUTO_SLEEP_OPTIONS}
                value={autoSleepAfter}
              />
            }
            hint="Stops an idle session's Claude to free memory. The row stays; click it to pick up where it left off. Busy sessions are never slept."
            label="Sleep idle sessions"
            stacked
          />
        </SettingGroup>
        <SettingGroup label="Nested sessions">
          <SettingRow
            control={
              <NestedCapControl
                onChange={setNestedSessionCap}
                value={nestedSessionCap}
              />
            }
            hint="When Claude starts a session and this many are already working, waiting on you or starting, the new one waits and starts by itself when one finishes."
            label="Most busy at once"
            stacked
          />
        </SettingGroup>
      </div>
    </SectionPage>
  );
}

function ClaudeSection() {
  return (
    <SectionPage
      id="claude"
      lead="Changes apply to sessions started after them."
    >
      <IntegrationGroup />
    </SectionPage>
  );
}

function UpdatesSection() {
  return (
    <SectionPage id="updates" lead="Kriyon never installs without asking.">
      <UpdatesGroup />
    </SectionPage>
  );
}

function ActivitySection() {
  return (
    <SectionPage
      id="activity"
      lead="What Kriyon records about each session, kept on this Mac."
    >
      <ActivityGroup />
    </SectionPage>
  );
}

const SECTION_PAGES: Record<SettingsSectionId, () => ReactNode> = {
  activity: ActivitySection,
  remote: RemoteSection,
  appearance: AppearanceSection,
  claude: ClaudeSection,
  layout: LayoutSection,
  notifications: NotificationsSection,
  sessions: SessionsSection,
  updates: UpdatesSection,
};

/** The side menu: the sections a search keeps, under their headings. */
function SettingsNav({
  active,
  onPick,
  visible,
}: {
  active: SettingsSectionId | null;
  onPick: (id: SettingsSectionId) => void;
  visible: readonly SettingsSectionId[];
}) {
  return (
    <nav aria-label="Settings sections" style={navStyle}>
      {SETTINGS_GROUPS.map((group) => {
        const sections = SETTINGS_SECTIONS.filter(
          (section) => section.group === group && visible.includes(section.id)
        );
        if (sections.length === 0) {
          return null;
        }
        return (
          <div key={group} style={navGroupStyle}>
            <span style={navGroupLabelStyle}>{group}</span>
            {sections.map((section) => (
              <button
                aria-current={section.id === active ? "page" : undefined}
                className="kr-focusable kr-hover-surface"
                key={section.id}
                onClick={() => onPick(section.id)}
                style={navButtonStyle(section.id === active)}
                type="button"
              >
                {section.label}
              </button>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The dedicated Settings page: one canonical home for the preferences otherwise
 * scattered across the ⌘K palette and the command-center header. A side menu
 * picks one section at a time, and a search narrows the menu. Every control
 * reads and writes the persisted layout ({@link useLayout}), so a change here
 * round-trips exactly like the palette shortcuts.
 */
export function SettingsView() {
  const [picked, setPicked] = useState<SettingsSectionId>("appearance");
  const [query, setQuery] = useState("");
  const visible = matchingSections(query);
  // A search that hides the open section opens the first one it kept.
  const active = visible.includes(picked) ? picked : (visible[0] ?? null);
  const Page = active ? SECTION_PAGES[active] : null;

  return (
    <div data-testid="settings-view" style={containerStyle}>
      <ViewHeader
        actions={
          <label className="kr-filter-box" style={searchBoxStyle}>
            <Search
              aria-hidden
              color={tokens.color.ink.muted}
              size={13}
              strokeWidth={1.75}
            />
            <input
              aria-label="Search settings"
              className="kr-filter-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search settings"
              style={searchInput()}
              type="search"
              value={query}
            />
          </label>
        }
        testId="settings-header"
        title="Settings"
      />
      <div style={bodyStyle}>
        <SettingsNav active={active} onPick={setPicked} visible={visible} />
        <main style={mainStyle}>
          {Page ? (
            <Page />
          ) : (
            <p style={emptyStyle}>No settings match “{query.trim()}”.</p>
          )}
        </main>
      </div>
    </div>
  );
}
