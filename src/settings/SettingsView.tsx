import {
  Children,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useState,
} from "react";
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
import { isNestedCap, NESTED_CAP_RANGE, useLayout } from "../state/layout.ts";
import { useUpdates } from "../state/updates.ts";
import { button, card, inputBox, sectionLabel } from "../theme/recipes.ts";
import { THEMES } from "../theme/themes/index.ts";
import { tokens } from "../theme/tokens.ts";
import type { NotifySound } from "../types.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { showToast } from "../ui/Toast.tsx";
import {
  companionHint,
  hooksHint,
  liveUsageHint,
  removalLines,
} from "../welcome/integrationCopy.ts";
import { MascotPicker } from "./MascotPicker.tsx";
import {
  AUTO_SLEEP_OPTIONS,
  MEMORY_BUDGET_OPTIONS,
  MEMORY_WARN_OPTIONS,
  MENU_BAR_OPTIONS,
  NOTIFY_OPTIONS,
  NOTIFY_SOUND_OPTIONS,
  ON_OFF_OPTIONS,
  SIDEBAR_MODE_OPTIONS,
  UPDATE_CHANNEL_OPTIONS,
} from "./settingsOptions.ts";

const THEME_OPTIONS = THEMES.map((theme) => ({
  label: theme.label,
  value: theme.id,
}));

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
  overflowY: "auto",
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "22px",
  // A comfortable reading column rather than full-bleed rows on a wide window.
  maxWidth: "640px",
  padding: "20px 24px",
  width: "100%",
};

const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const groupLabelStyle: CSSProperties = sectionLabel();

/** The group's card; its rows are hairline-separated, not boxed one by one. */
const groupCardStyle: CSSProperties = {
  ...card(),
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const dividerStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.soft}`,
};

/**
 * A 46px preference row — `minHeight`, not `height`: a couple of the hints run
 * to a sentence or two, and clipping the explanation to hold the rhythm would
 * cost more than the rhythm is worth.
 */
const rowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.lg,
  justifyContent: "space-between",
  minHeight: "46px",
  padding: `${tokens.space.sm} 14px`,
};

const rowTextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
};

const rowLabelStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "12.5px",
  fontWeight: 500,
};

const rowHintStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  lineHeight: 1.45,
};

const soundControlStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: tokens.space.sm,
};

const selectStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.primary,
  display: "inline-block",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
};

const previewButtonStyle: CSSProperties = button("secondary");

/** The [Nested session cap]: a typed number, or no limit. A number out of
 *  range is put back on blur rather than saved; turning the limit back on
 *  restores the last number. */
function NestedCapControl({
  onChange,
  value,
}: {
  onChange: (cap: number | null) => void;
  value: number | null;
}) {
  const [last, setLast] = useState(value ?? 4);
  const [draft, setDraft] = useState(String(value ?? last));
  const commit = () => {
    const cap = Number(draft);
    if (isNestedCap(cap)) {
      setLast(cap);
      onChange(cap);
    } else {
      setDraft(String(last));
    }
  };
  return (
    <div style={soundControlStyle}>
      <input
        aria-label="Most busy at once"
        disabled={value === null}
        max={NESTED_CAP_RANGE.max}
        min={NESTED_CAP_RANGE.min}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          }
        }}
        style={capInputStyle(value === null)}
        type="number"
        value={value === null ? "" : draft}
      />
      <label style={capNoneStyle}>
        <input
          checked={value === null}
          onChange={(event) => onChange(event.target.checked ? null : last)}
          type="checkbox"
        />
        No limit
      </label>
    </div>
  );
}

function capInputStyle(off: boolean): CSSProperties {
  return {
    ...selectStyle,
    opacity: off ? 0.5 : 1,
    textAlign: "center",
    width: "64px",
  };
}

const capNoneStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "flex",
  fontSize: "12.5px",
  gap: tokens.space.xs,
};

/** One labelled preference row: a name (with optional hint) and its control. */
function SettingRow({
  label,
  hint,
  control,
}: {
  control: ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    <div style={rowStyle}>
      <div style={rowTextStyle}>
        <span style={rowLabelStyle}>{label}</span>
        {hint ? <span style={rowHintStyle}>{hint}</span> : null}
      </div>
      {control}
    </div>
  );
}

/**
 * A titled group of related preference rows: a section label over one card,
 * with a hairline between rows (never after the last — a trailing rule under
 * the card's own border reads as a doubled edge).
 */
function SettingGroup({
  label,
  children,
}: {
  children: ReactNode;
  label: string;
}) {
  const rows = Children.toArray(children);
  return (
    <section aria-label={label} style={groupStyle}>
      <span style={groupLabelStyle}>{label}</span>
      <div style={groupCardStyle}>
        {rows.map((row, index) => (
          <div
            key={typeof row === "object" && "key" in row ? row.key : label}
            style={index === 0 ? undefined : dividerStyle}
          >
            {row}
          </div>
        ))}
      </div>
    </section>
  );
}

const errorTextStyle: CSSProperties = {
  ...rowHintStyle,
  color: tokens.color.status.error,
  padding: `${tokens.space.sm} 14px`,
};

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
          <Segmented
            ariaLabel="Status hooks"
            onChange={(value) => {
              ignoreResult(update({ ...prefs, statusHooks: value === "on" }));
            }}
            options={ON_OFF_OPTIONS}
            value={prefs.statusHooks ? "on" : "off"}
          />
        }
        hint={`${hooksHint(status.routeReason)} Applies to sessions started after a change.`}
        label="Status hooks"
      />
      <SettingRow
        control={
          <Segmented
            ariaLabel="Live usage"
            onChange={(value) => {
              ignoreResult(update({ ...prefs, liveUsage: value === "on" }));
            }}
            options={ON_OFF_OPTIONS}
            value={prefs.liveUsage ? "on" : "off"}
          />
        }
        hint={liveUsageHint(status)}
        label="Live usage"
      />
      <SettingRow
        control={
          status.companionAvailable ? (
            <Segmented
              ariaLabel="Kriyon Companion"
              onChange={(value) => {
                ignoreResult(update({ ...prefs, companion: value === "on" }));
              }}
              options={ON_OFF_OPTIONS}
              value={prefs.companion ? "on" : "off"}
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
      <SettingGroup label="Updates">
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
    <SettingGroup label="Updates">
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
          <Segmented
            ariaLabel="Check for updates automatically"
            onChange={(value) => {
              ignoreResult(setPrefs(prefs.channel, value === "on"));
            }}
            options={ON_OFF_OPTIONS}
            value={prefs.autoCheck ? "on" : "off"}
          />
        }
        hint="Check quietly at launch and every 6 hours. Kriyon never installs without asking."
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
    <SettingGroup label="Activity log">
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

/**
 * The dedicated Settings page: one canonical home for the preferences otherwise
 * scattered across the ⌘K palette and the command-center header. A thin view
 * over {@link useLayout} — every control reads and writes the persisted layout,
 * so a change here round-trips exactly like the palette shortcuts.
 */
export function SettingsView() {
  const themeId = useLayout((state) => state.layout.themeId);
  const setThemeId = useLayout((state) => state.setThemeId);
  const sidebarMode = useLayout((state) => state.layout.sidebarMode);
  const setSidebarMode = useLayout((state) => state.setSidebarMode);
  const notifyPreference = useLayout((state) => state.layout.notifyPreference);
  const setNotifyPreference = useLayout((state) => state.setNotifyPreference);
  const menuBarMode = useLayout((state) => state.layout.menuBarMode);
  const setMenuBarMode = useLayout((state) => state.setMenuBarMode);
  const notifySound = useLayout((state) => state.layout.notifySound);
  const setNotifySound = useLayout((state) => state.setNotifySound);
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
    <div data-testid="settings-view" style={containerStyle}>
      <ViewHeader testId="settings-header" title="Settings" />
      <div style={bodyStyle}>
        <SettingGroup label="Appearance">
          <SettingRow
            control={
              <Segmented
                ariaLabel="Theme"
                onChange={setThemeId}
                options={THEME_OPTIONS}
                value={themeId}
              />
            }
            label="Theme"
          />
          <SettingRow
            control={<MascotPicker />}
            hint="Shown at the top of the Structured view. It hops while Claude works."
            label="Mascot"
          />
        </SettingGroup>

        <SettingGroup label="Sidebar">
          <SettingRow
            control={
              <Segmented
                ariaLabel="Sidebar mode"
                onChange={setSidebarMode}
                options={SIDEBAR_MODE_OPTIONS}
                value={sidebarMode}
              />
            }
            hint="Calm keeps the current list; Triage floats active work up and folds read Done away."
            label="Layout"
          />
        </SettingGroup>

        <SettingGroup label="Notifications">
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
              <div style={soundControlStyle}>
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
                  style={previewButtonStyle}
                  type="button"
                >
                  ▶ Preview
                </button>
              </div>
            }
            hint="Plays when a session needs you or finishes. ▶ to preview."
            label="Notification sound"
          />
        </SettingGroup>

        <SettingGroup label="Memory">
          <SettingRow
            control={
              <Segmented
                ariaLabel="Memory warnings"
                onChange={(value) => setMemoryWarnEnabled(value === "on")}
                options={MEMORY_WARN_OPTIONS}
                value={memoryWarnEnabled ? "on" : "off"}
              />
            }
            hint="Warn when all sessions together use more memory than the budget."
            label="Warnings"
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
            hint="Total memory across sessions before a warning fires."
            label="Budget"
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
            hint="Stop an idle session's Claude to free its memory; the row stays and clicking it resumes where it left off. Sessions that are busy or running something are never slept."
            label="Sleep idle sessions"
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
            hint="When you ask Claude to start a session and this many other sessions are already working, waiting on you or starting, Kriyon shows it as a suggestion you start yourself instead."
            label="Most busy at once"
          />
        </SettingGroup>

        <IntegrationGroup />

        <ActivityGroup />

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
            label="Layout"
          />
        </SettingGroup>

        <UpdatesGroup />
      </div>
    </div>
  );
}
