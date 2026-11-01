/**
 * The pages of the Settings view, in side-menu order, and the words the
 * Settings search finds each one by. A setting added to a page adds its label
 * here too, or the search can't reach it.
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

export interface SettingsSection {
  /** The side-menu heading the section sits under. */
  group: "Kriyon" | "Claude Code" | "App";
  id: SettingsSectionId;
  /** Setting labels and the words a person might type to find them. */
  keywords: readonly string[];
  /** The side-menu entry. */
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
    ],
    label: "Appearance",
  },
  {
    group: "Kriyon",
    id: "layout",
    keywords: ["sidebar", "calm", "triage", "menu bar", "grouped", "compact"],
    label: "Layout",
  },
  {
    group: "Kriyon",
    id: "notifications",
    keywords: ["os notifications", "blocked", "sound", "preview"],
    label: "Notifications",
  },
  {
    group: "Kriyon",
    id: "sessions",
    keywords: [
      "memory",
      "warnings",
      "budget",
      "sleep idle sessions",
      "nested sessions",
      "most busy at once",
      "limit",
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
      "plugin",
      "remove everything",
    ],
    label: "Integration",
  },
  {
    group: "App",
    id: "updates",
    keywords: ["channel", "stable", "beta", "nightly", "check automatically"],
    label: "Updates",
  },
  {
    group: "App",
    id: "activity",
    keywords: ["activity log", "delete", "history"],
    label: "Activity log",
  },
];

/** The sections a Settings search keeps: every word of the query appears in
 *  the section's name or one of its keywords. An empty query keeps them all. */
export function matchingSections(query: string): SettingsSectionId[] {
  const words = query.toLowerCase().split(WHITESPACE).filter(Boolean);
  return SETTINGS_SECTIONS.filter((section) => {
    const text = [section.label, ...section.keywords].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  }).map((section) => section.id);
}
