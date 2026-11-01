import { MASCOT_HUES, MASCOTS } from "../structured/Mascot.tsx";
import { THEMES } from "../theme/themes/index.ts";
import {
  AUTO_SLEEP_OPTIONS,
  MEMORY_BUDGET_OPTIONS,
  MENU_BAR_OPTIONS,
  NOTIFY_OPTIONS,
  NOTIFY_SOUND_OPTIONS,
  SIDEBAR_MODE_OPTIONS,
  UPDATE_CHANNEL_OPTIONS,
} from "./settingsOptions.ts";

/** The labels of a list of choices, so search finds a setting by any of its
 *  choices without the list being typed out again here. */
function labels(choices: readonly { label: string }[]): string[] {
  return choices.map((choice) => choice.label);
}

/** The names of a list of named things (themes are labelled, mascots named). */
function names(choices: readonly { name: string }[]): string[] {
  return choices.map((choice) => choice.name);
}

/**
 * The pages of the Settings view, in side-menu order, and the words the
 * Settings search finds each one by. A setting added to a page adds its label
 * here too, or the search can't reach it — `SettingsView.test.tsx` fails when
 * a setting's label, or the name of one of its choices, shown on a page is
 * missing. Choices come from their own lists, never retyped.
 */

const WHITESPACE = /\s+/;

export type SettingsSectionId =
  | "appearance"
  | "layout"
  | "notifications"
  | "sessions"
  | "claude"
  | "updates"
  | "activity";

/** The side-menu headings, in order. */
export const SETTINGS_GROUPS = ["Kriyon", "Claude Code", "App"] as const;

export interface SettingsSection {
  /** The side-menu heading the section sits under. */
  group: (typeof SETTINGS_GROUPS)[number];
  id: SettingsSectionId;
  /** Setting labels and the words a person might type to find them. */
  keywords: readonly string[];
  /** The side-menu entry, and the title of the page it opens. */
  label: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    group: "Kriyon",
    id: "appearance",
    keywords: [
      "theme",
      "dark",
      "light",
      "palette",
      "colour",
      "color",
      "mascot",
      "none",
      ...labels(THEMES),
      ...names(MASCOTS),
      ...names(MASCOT_HUES),
    ],
    label: "Appearance",
  },
  {
    group: "Kriyon",
    id: "layout",
    keywords: [
      "sidebar",
      "menu bar",
      "quick view",
      "app tour",
      "tour",
      "help",
      "getting started",
      ...labels(SIDEBAR_MODE_OPTIONS),
      ...labels(MENU_BAR_OPTIONS),
    ],
    label: "Layout",
  },
  {
    group: "Kriyon",
    id: "notifications",
    keywords: [
      "os notifications",
      "sound",
      "preview",
      ...labels(NOTIFY_OPTIONS),
      ...labels(NOTIFY_SOUND_OPTIONS),
    ],
    label: "Notifications",
  },
  {
    group: "Kriyon",
    id: "sessions",
    keywords: [
      "memory",
      "warnings",
      "warn over budget",
      "sleep idle sessions",
      "nested sessions",
      "most busy at once",
      "limit",
      ...labels(MEMORY_BUDGET_OPTIONS),
      ...labels(AUTO_SLEEP_OPTIONS),
    ],
    label: "Sessions",
  },
  {
    group: "Claude Code",
    id: "claude",
    keywords: [
      "claude code",
      "status hooks",
      "live usage",
      "status line",
      "kriyon companion",
      "per-session plugin",
      "remove everything",
    ],
    label: "Integration",
  },
  {
    group: "App",
    id: "updates",
    keywords: [
      "channel",
      ...labels(UPDATE_CHANNEL_OPTIONS),
      "check automatically",
      "check for updates",
    ],
    label: "Updates",
  },
  {
    group: "App",
    id: "activity",
    keywords: ["activity log", "delete all", "history"],
    label: "Activity log",
  },
];

/** A section's side-menu entry, which is also its page title. */
export function sectionTitle(id: SettingsSectionId): string {
  const section = SETTINGS_SECTIONS.find((entry) => entry.id === id);
  if (!section) {
    throw new Error(`No Settings section "${id}"`);
  }
  return section.label;
}

/** The sections a Settings search keeps: every word of the query appears in
 *  the section's name or one of its keywords. An empty query keeps them all. */
export function matchingSections(query: string): SettingsSectionId[] {
  const words = query.toLowerCase().split(WHITESPACE).filter(Boolean);
  return SETTINGS_SECTIONS.filter((section) => {
    const text = [section.label, ...section.keywords].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  }).map((section) => section.id);
}
