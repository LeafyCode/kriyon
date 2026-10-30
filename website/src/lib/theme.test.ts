import { afterEach, beforeEach, expect, test } from "vitest";
import {
  currentTheme,
  pinTheme,
  reapplyPinnedTheme,
  THEME_COLORS,
  THEME_KEY,
  THEME_SCRIPT,
} from "./theme.ts";

function addThemeColorTags() {
  for (const scheme of ["light", "dark"] as const) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    // jsdom has no `media` property on meta; the attribute is what counts.
    meta.setAttribute("media", `(prefers-color-scheme: ${scheme})`);
    meta.content = THEME_COLORS[scheme];
    document.head.append(meta);
  }
}

/** The colour the browser uses: the first `theme-color` tag that applies. */
function barColor(): string | undefined {
  const tags = document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]'
  );
  // The test setup's matchMedia matches nothing, so only a tag without a
  // media query (the pinned one) can apply; failing that, report the light
  // tag, which a light system would use.
  return (
    [...tags].find((m) => !m.hasAttribute("media"))?.content ??
    [...tags].find((m) => m.getAttribute("media")?.includes("light"))?.content
  );
}

/** React renders these two; a script rewriting them makes React add a copy. */
function renderedTags() {
  return [
    ...document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"][media]'
    ),
  ].map((m) => m.content);
}

/** Runs the head script exactly as the page ships it. */
function runHeadScript() {
  new Function(THEME_SCRIPT)();
}

beforeEach(() => {
  addThemeColorTags();
});

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

test("the head script restores a stored theme and the browser bar colour", () => {
  localStorage.setItem(THEME_KEY, "dark");

  runHeadScript();

  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(barColor()).toBe(THEME_COLORS.dark);
  expect(renderedTags()).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
});

test("the head script marks the page as scripted, with or without a stored theme", () => {
  runHeadScript();

  expect(document.documentElement.classList.contains("js")).toBe(true);
  expect(document.documentElement.dataset.theme).toBeUndefined();
  // Nothing pinned: the system's own tag decides.
  expect(barColor()).toBe(THEME_COLORS.light);
});

test("the head script ignores a stored value that is not a theme", () => {
  localStorage.setItem(THEME_KEY, "sepia");

  runHeadScript();

  expect(document.documentElement.dataset.theme).toBeUndefined();
});

test("pinning a theme recolours the browser bar, not just the page", () => {
  pinTheme("dark");
  expect(barColor()).toBe(THEME_COLORS.dark);

  pinTheme("light");
  expect(barColor()).toBe(THEME_COLORS.light);
  expect(localStorage.getItem(THEME_KEY)).toBe("light");
  // One pinned tag, reused; the rendered ones are never touched.
  expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(3);
  expect(renderedTags()).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
});

test("with nothing pinned, the current theme follows the system", () => {
  // The test setup's matchMedia reports no match: a light system.
  expect(currentTheme()).toBe("light");

  pinTheme("dark");

  expect(currentTheme()).toBe("dark");
});

test("re-applying the pin after hydration puts its tag back in front", () => {
  // In development React moves the tags it renders to the front of <head>
  // while hydrating; the browser uses the first tag that applies.
  localStorage.setItem(THEME_KEY, "dark");
  runHeadScript();
  const reactTag = document.querySelector('meta[media*="light"]');
  if (reactTag) {
    document.head.prepend(reactTag);
  }

  reapplyPinnedTheme();

  const first = document.head.querySelector('meta[name="theme-color"]');
  expect(first?.hasAttribute("data-pinned-theme")).toBe(true);
  expect(first?.getAttribute("content")).toBe(THEME_COLORS.dark);
});
