import type { UpdateChannel } from "../ipc/bridge.ts";
import type {
  AutoSleepAfter,
  MenuBarMode,
  NestedSessionCap,
  SidebarMode,
} from "../state/layout.ts";
import type { NotifyPreference, NotifySound } from "../types.ts";

/**
 * The single source of the selectable values for each enum preference. Both the
 * Settings page and the command palette render from these, so a new mode is
 * added in one place (plus the union in layout.ts / types.ts and the persisted
 * parser) rather than re-typed per surface.
 */
export interface SettingOption<V extends string> {
  label: string;
  value: V;
}

export const SIDEBAR_MODE_OPTIONS: readonly SettingOption<SidebarMode>[] = [
  { label: "Calm", value: "calm" },
  { label: "Triage", value: "triage" },
];

export const MENU_BAR_OPTIONS: readonly SettingOption<MenuBarMode>[] = [
  { label: "Grouped", value: "grouped" },
  { label: "Compact", value: "compact" },
];

export const NOTIFY_OPTIONS: readonly SettingOption<NotifyPreference>[] = [
  { label: "All", value: "all" },
  { label: "Only blocked", value: "only_blocked" },
  { label: "Off", value: "none" },
];

/**
 * Selectable [Memory budget] values. String-valued (MB) because Segmented and
 * selects trade in string options; the setter parses back to a number.
 */
export const MEMORY_BUDGET_OPTIONS: readonly SettingOption<string>[] = [
  { label: "4 GB", value: "4096" },
  { label: "6 GB", value: "6144" },
  { label: "8 GB", value: "8192" },
  { label: "12 GB", value: "12288" },
];

export const MEMORY_WARN_OPTIONS: readonly SettingOption<"on" | "off">[] = [
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
];

export const AUTO_SLEEP_OPTIONS: readonly SettingOption<AutoSleepAfter>[] = [
  { label: "Off", value: "off" },
  { label: "After 1h", value: "1h" },
  { label: "After 3h", value: "3h" },
  { label: "After 6h", value: "6h" },
];

export const NESTED_CAP_OPTIONS: readonly SettingOption<NestedSessionCap>[] = [
  { label: "No cap", value: "off" },
  { label: "2", value: "2" },
  { label: "4", value: "4" },
  { label: "6", value: "6" },
];

export const NOTIFY_SOUND_OPTIONS: readonly SettingOption<NotifySound>[] = [
  { label: "Default", value: "default" },
  { label: "Silent", value: "silent" },
  { label: "Marimba", value: "marimba" },
  { label: "Music box", value: "music_box" },
  { label: "Vibraphone", value: "vibraphone" },
  { label: "Kalimba", value: "kalimba" },
  { label: "Bell", value: "bell" },
];

/** A plain on/off switch. */
export const ON_OFF_OPTIONS: readonly SettingOption<"on" | "off">[] = [
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
];

/** The [Update channel] picker. Calmest first. */
export const UPDATE_CHANNEL_OPTIONS: readonly SettingOption<UpdateChannel>[] = [
  { label: "Stable", value: "stable" },
  { label: "Beta", value: "beta" },
  { label: "Nightly", value: "nightly" },
];
