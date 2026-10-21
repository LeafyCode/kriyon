/**
 * The page's sections, in page order: the one list the nav, each section's
 * own heading (ManSection's rail, and the hero, install and origin titles)
 * and the page layout read, so an id, a name or the order can only change in
 * one place. `routes/index.test.tsx` checks the page keeps this order.
 * `inNav: false` sections are tracked as current (so the nav never claims you
 * are still in the last listed one) but get no nav link of their own.
 */
export const SECTIONS = [
  { id: "name", label: "NAME", inNav: true },
  { id: "synopsis", label: "SYNOPSIS", inNav: true },
  { id: "activity", label: "ACTIVITY", inNav: true },
  { id: "views", label: "VIEWS", inNav: true },
  { id: "sessions", label: "SESSIONS", inNav: true },
  { id: "source", label: "SOURCE", inNav: true },
  { id: "contribute", label: "CONTRIBUTE", inNav: true },
  { id: "install", label: "INSTALL", inNav: false },
  { id: "origin", label: "MADE IN SRI LANKA", inNav: false },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export const SECTION_IDS: readonly SectionId[] = SECTIONS.map((s) => s.id);

export const NAV_SECTIONS = SECTIONS.filter((s) => s.inNav);

export function sectionLabel(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}
