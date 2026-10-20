import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useActiveSection } from "./useActiveSection.ts";

const IDS = ["name", "synopsis", "contribute", "install"] as const;

/** Where each section's top sits in the viewport, by id. */
let tops: Record<string, number> = {};

function layOut(next: Record<string, number>) {
  tops = next;
}

function scroll(y: number, pageHeight = 5000) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: pageHeight,
  });
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  for (const id of IDS) {
    const el = document.createElement("section");
    el.id = id;
    el.getBoundingClientRect = () => ({ top: tops[id] ?? 9999 }) as DOMRect;
    document.body.append(el);
  }
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  tops = {};
  vi.restoreAllMocks();
});

test("starts at the first section, so the server and first render agree", () => {
  const { result } = renderHook(() => useActiveSection(IDS));
  expect(result.current).toBe("name");
});

test("the current section is the last one whose top has passed under the nav", () => {
  const { result } = renderHook(() => useActiveSection(IDS));

  layOut({ name: -800, synopsis: 40, contribute: 600, install: 1400 });
  scroll(800);

  expect(result.current).toBe("synopsis");
});

test("a short section reached by a link still becomes current", () => {
  // A jump lands the heading just under the nav (scroll-padding-top); that
  // must count, even though the next section's top is already on screen.
  const { result } = renderHook(() => useActiveSection(IDS));

  layOut({ name: -2000, synopsis: -1200, contribute: 64, install: 400 });
  scroll(2000);

  expect(result.current).toBe("contribute");
});

test("at the bottom of the page the last section is current", () => {
  const { result } = renderHook(() => useActiveSection(IDS));

  layOut({ name: -4000, synopsis: -3000, contribute: -900, install: 300 });
  // innerHeight (jsdom 768) + scrollY reaches the page height.
  scroll(4232, 5000);

  expect(result.current).toBe("install");
});
