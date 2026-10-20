import { useEffect, useRef, useState } from "react";
import {
  NAV_SECTIONS,
  SECTION_IDS,
  type SectionId,
  sectionLabel,
} from "../lib/sections.ts";
import { APP_VERSION, LATEST_RELEASE_URL } from "../lib/site.ts";
import { currentTheme, pinTheme, type Theme } from "../lib/theme.ts";
import { useActiveSection } from "../lib/useActiveSection.ts";

function index(i: number): string {
  return `[ ${String(i).padStart(2, "0")} ]`;
}

/** The menu button names where you are: an indexed nav section, or a `§`
    section past the listed ones (install, origin). */
function menuLabel(active: SectionId): string {
  const i = NAV_SECTIONS.findIndex((s) => s.id === active);
  return i === -1
    ? `§ ${sectionLabel(active)}`
    : `${index(i)} ${sectionLabel(active)}`;
}

export function Nav() {
  const active = useActiveSection(SECTION_IDS);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);

  // An open menu closes on Escape (focus back on its button) or on any press
  // outside the nav, like every other disclosure on the web.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        menuRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <nav aria-label="Sections" className="nav" ref={navRef}>
      <a className="nav-brand" href="#top">
        KRIYON(1)
      </a>
      <button
        aria-controls="nav-sections"
        aria-expanded={open}
        className="nav-menu"
        onClick={() => setOpen(!open)}
        ref={menuRef}
        type="button"
      >
        {menuLabel(active)}
        <span aria-hidden="true" className="nav-menu-caret">
          {open ? "▴" : "▾"}
        </span>
      </button>
      <ul className="nav-links" data-open={open} id="nav-sections">
        {NAV_SECTIONS.map((s, i) => (
          <li key={s.id}>
            <a
              aria-current={s.id === active ? "location" : undefined}
              href={`#${s.id}`}
              onClick={() => setOpen(false)}
            >
              {index(i)} {s.label}
            </a>
          </li>
        ))}
      </ul>
      <a
        className="nav-status"
        href={LATEST_RELEASE_URL}
        rel="noreferrer"
        target="_blank"
        title="Latest release on GitHub"
      >
        <span aria-hidden="true" className="pulse-dot" />
        {APP_VERSION} <span className="nav-status-word">STABLE ↗</span>
      </a>
      <ThemeToggle />
    </nav>
  );
}

function ThemeToggle() {
  // `null` until mounted: the server cannot know the visitor's theme.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setTheme(currentTheme());
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  return (
    <button
      aria-label="Dark mode"
      aria-pressed={theme === "dark"}
      className="nav-theme"
      onClick={() => {
        const next = currentTheme() === "dark" ? "light" : "dark";
        pinTheme(next);
        setTheme(next);
      }}
      type="button"
    >
      <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
        <circle cx="8" cy="8" fill="none" r="6.5" stroke="currentColor" />
        <path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" />
      </svg>
    </button>
  );
}
