import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChanges } from "../state/changes.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";

vi.mock("./highlighter.ts", () => ({
  highlightLines: vi.fn().mockReturnValue(new Promise(() => undefined)),
  // Synchronous cache peek; `undefined` keeps these tests on the async path.
  peekHighlight: vi.fn(),
  langForPath: () => "text",
}));

import { DiffFeed } from "./DiffFeed.tsx";

const EDIT_FILE_RE = /edit file/i;

/** A rendered file card, found by the `data-diff-path` DiffFeed stamps on
 * every card it mounts. */
function findDiffCard(path: string): Element | null {
  return document.querySelector(`[data-diff-path="${path}"]`);
}

function file(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: [{ kind: "context", text: "line" }],
      },
    ],
    oldPath: null,
    path,
    status: "modified",
    ...overrides,
  };
}

/**
 * A controllable IntersectionObserver stand-in: jsdom has no real one, and a
 * stub that always reports "intersecting" would make the viewed/active
 * tests vacuous (they'd pass against a broken implementation too). Tests
 * fire `trigger` by hand with an explicit `isIntersecting`/ratio, the same
 * shape a real browser callback delivers, so DiffFeed's own logic — not the
 * stub — decides whether a file counts as viewed/active.
 */
class FakeIntersectionObserver {
  /** DiffFeed constructs exactly one observer per mount (see its effect), so
   * the most-recently-constructed instance is always the current one — no
   * need for an array (and the last-index access that would invite). */
  static current: FakeIntersectionObserver | null = null;
  callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
  observed = new Set<Element>();

  constructor(
    callback: (entries: Partial<IntersectionObserverEntry>[]) => void
  ) {
    this.callback = callback;
    FakeIntersectionObserver.current = this;
  }

  observe(el: Element): void {
    this.observed.add(el);
  }

  unobserve(el: Element): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.observed.clear();
  }

  trigger(
    el: Element,
    isIntersecting: boolean,
    intersectionRatio?: number
  ): void {
    this.callback([
      {
        intersectionRatio: intersectionRatio ?? (isIntersecting ? 1 : 0),
        isIntersecting,
        target: el,
      },
    ]);
  }
}

describe("DiffFeed", () => {
  beforeEach(() => {
    useChanges.setState({ bySession: {} });
    FakeIntersectionObserver.current = null;
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    // @tanstack/react-virtual (installed 3.17.5) measures both the scroll
    // container and each item via `offsetWidth`/`offsetHeight`, not
    // `getBoundingClientRect` (checked directly against the installed
    // package's source — its own docs describe an older/different
    // behavior). jsdom never computes layout, so both default to 0, which
    // would give the virtualizer a zero-size viewport and render nothing.
    // Stub every element's offsets with a real size so the feed's items
    // land inside the virtualizer's visible range.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 600,
    });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    vi.unstubAllGlobals();
  });

  it("renders a card for each file", () => {
    const files = [file("a.ts"), file("b.ts"), file("c.ts")];
    render(<DiffFeed files={files} sessionId="s1" />);

    expect(screen.getAllByTestId("diff-file-card")).toHaveLength(3);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("c.ts")).toBeInTheDocument();
  });

  it("offers Edit only on the cards that can actually be edited", () => {
    // A deleted file has nothing to open (`read_file` refuses a path that
    // isn't there) and a binary one is read-only in the viewer by
    // construction — a pencil on either is a button whose only outcome is an
    // error banner.
    render(
      <DiffFeed
        files={[
          file("kept.ts"),
          file("gone.ts", { hunks: [], status: "deleted" }),
          file("logo.png", { binary: true, hunks: [] }),
        ]}
        onEditFile={vi.fn()}
        sessionId="s1"
      />
    );

    expect(screen.getAllByRole("button", { name: EDIT_FILE_RE })).toHaveLength(
      1
    );
    expect(
      findDiffCard("kept.ts")?.querySelector('[aria-label="Edit file"]')
    ).toBeInTheDocument();
  });

  it("gives each file card a stable, queryable diff-path marker", () => {
    render(<DiffFeed files={[file("src/x.ts")]} sessionId="sess-1" />);

    expect(findDiffCard("src/x.ts")).not.toBeNull();
  });

  it("reflects the store's user-toggled collapsed state", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "",
          collapsed: { "a.ts": true },
          diff: null,
          fetchedAt: 0,
          hunkHashes: {},
          status: "ready",
          totals: null,
          viewed: {},
        },
      },
    });

    render(<DiffFeed files={[file("a.ts")]} sessionId="s1" />);

    expect(
      screen.getByTestId("diff-file-collapsed-indicator")
    ).toBeInTheDocument();
  });

  it("auto-collapses lockfiles by default", () => {
    render(<DiffFeed files={[file("pnpm-lock.yaml")]} sessionId="s1" />);

    expect(
      screen.getByTestId("diff-file-collapsed-indicator")
    ).toBeInTheDocument();
  });

  it("expanding an auto-collapsed lockfile card takes a single click", () => {
    const lockfile = file("pnpm-lock.yaml");
    // Seed the store's diff.files with the same file the `files` prop
    // renders: toggleCollapsed resolves the clicked path against
    // `bySession[id].diff.files` to compute the auto-collapse default, the
    // same way DiffFeed's `files` prop is always sourced in production.
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "",
          collapsed: {},
          diff: { base: "HEAD", files: [lockfile] },
          fetchedAt: 0,
          hunkHashes: {},
          status: "ready",
          totals: null,
          viewed: {},
        },
      },
    });
    render(<DiffFeed files={[lockfile]} sessionId="s1" />);

    expect(
      screen.getByTestId("diff-file-collapsed-indicator")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("diff-file-header"));

    expect(
      screen.queryByTestId("diff-file-collapsed-indicator")
    ).not.toBeInTheDocument();
  });

  function fileWithChangedLines(count: number) {
    return file("src/big.ts", {
      hunks: [
        {
          header: `@@ -1,${count} +1,${count} @@`,
          lines: Array.from({ length: count }, () => ({
            kind: "added" as const,
            text: "x",
          })),
        },
      ],
    });
  }

  it("auto-collapses files with more than 400 changed lines", () => {
    render(<DiffFeed files={[fileWithChangedLines(401)]} sessionId="s1" />);

    expect(
      screen.getByTestId("diff-file-collapsed-indicator")
    ).toBeInTheDocument();
  });

  it("does not auto-collapse a file at exactly 400 changed lines", () => {
    render(<DiffFeed files={[fileWithChangedLines(400)]} sessionId="s1" />);

    expect(
      screen.queryByTestId("diff-file-collapsed-indicator")
    ).not.toBeInTheDocument();
  });

  it("does not auto-collapse an ordinary small file", () => {
    render(<DiffFeed files={[file("src/small.ts")]} sessionId="s1" />);

    expect(
      screen.queryByTestId("diff-file-collapsed-indicator")
    ).not.toBeInTheDocument();
  });

  it("toggling a card updates the store's collapsed state for that session/path", () => {
    render(<DiffFeed files={[file("a.ts")]} sessionId="s1" />);

    fireEvent.click(screen.getByTestId("diff-file-header"));

    expect(useChanges.getState().bySession.s1?.collapsed["a.ts"]).toBe(true);
  });

  it("bakes the inter-card gap into padding (measured), not margin (invisible on an absolutely-positioned, translated item)", () => {
    render(<DiffFeed files={[file("a.ts"), file("b.ts")]} sessionId="s1" />);

    const item = screen.getByText("a.ts").closest("[data-index]");
    expect(item).not.toBeNull();
    expect(item).toHaveStyle({ paddingBottom: tokens.space.md });
    expect((item as HTMLElement).style.marginBottom).toBe("");
  });

  describe("intersection-driven viewed/active tracking", () => {
    it("marks a file viewed in the store once its card actually intersects the viewport", () => {
      render(<DiffFeed files={[file("a.ts")]} sessionId="s1" />);
      const observer = FakeIntersectionObserver.current;
      const card = findDiffCard("a.ts");
      expect(observer).toBeDefined();
      expect(card).not.toBeNull();

      observer?.trigger(card as Element, true);

      expect(useChanges.getState().bySession.s1?.viewed["a.ts"]).toBe(true);
    });

    it("does not mark a file viewed while its card is reported as not intersecting", () => {
      render(<DiffFeed files={[file("a.ts")]} sessionId="s1" />);
      const observer = FakeIntersectionObserver.current;
      const card = findDiffCard("a.ts");

      observer?.trigger(card as Element, false);

      expect(useChanges.getState().bySession.s1?.viewed?.["a.ts"]).not.toBe(
        true
      );
    });

    it("reports the intersecting file as active via onActiveFileChange", () => {
      const onActiveFileChange = vi.fn();
      render(
        <DiffFeed
          files={[file("a.ts")]}
          onActiveFileChange={onActiveFileChange}
          sessionId="s1"
        />
      );
      const observer = FakeIntersectionObserver.current;
      const card = findDiffCard("a.ts");

      observer?.trigger(card as Element, true, 1);

      expect(onActiveFileChange).toHaveBeenCalledWith("a.ts");
    });

    it("does not report a non-intersecting card's file as active", () => {
      const onActiveFileChange = vi.fn();
      render(
        <DiffFeed
          files={[file("a.ts")]}
          onActiveFileChange={onActiveFileChange}
          sessionId="s1"
        />
      );
      const observer = FakeIntersectionObserver.current;
      const card = findDiffCard("a.ts");

      observer?.trigger(card as Element, false, 0);

      expect(onActiveFileChange).not.toHaveBeenCalledWith("a.ts");
    });

    it("switches the active file when intersection moves from one card to another", () => {
      const onActiveFileChange = vi.fn();
      render(
        <DiffFeed
          files={[file("a.ts"), file("b.ts")]}
          onActiveFileChange={onActiveFileChange}
          sessionId="s1"
        />
      );
      const observer = FakeIntersectionObserver.current;
      const cardA = findDiffCard("a.ts");
      const cardB = findDiffCard("b.ts");

      observer?.trigger(cardA as Element, true, 1);
      expect(onActiveFileChange).toHaveBeenLastCalledWith("a.ts");

      observer?.trigger(cardA as Element, false, 0);
      observer?.trigger(cardB as Element, true, 1);
      expect(onActiveFileChange).toHaveBeenLastCalledWith("b.ts");
    });
  });

  describe("scroll preservation across a silent refresh", () => {
    // The virtualizer clamps any scrollToOffset target to
    // `scrollElement.scrollHeight - clientHeight` (see `getMaxScrollOffset`
    // in @tanstack/virtual-core) — jsdom reports 0 for both by default,
    // which would clamp every restore attempt to 0 and make these tests
    // pass whether or not the restore logic exists at all. A large stub
    // keeps that clamp out of the way, mirroring ChangesView.test.tsx's
    // established pattern for the same reason.
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        value: 100_000,
      });
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value(this: HTMLElement, options?: ScrollToOptions): void {
          const top =
            typeof options === "object" && options ? (options.top ?? 0) : 0;
          this.scrollTop = top;
          this.dispatchEvent(new Event("scroll"));
        },
        writable: true,
      });
    });

    afterEach(() => {
      // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      // biome-ignore lint/performance/noDelete: restores jsdom's (lack of a) own property, a plain `= undefined` would leave a shadowing own-property behind.
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    });

    function manyFiles(count: number): FileDiff[] {
      return Array.from({ length: count }, (_, i) => file(`src/file${i}.ts`));
    }

    /** Puts a freshly-fetched diff in the store for session "s1" — the store
     * side of a refresh landing, which is what actually distinguishes "new
     * content arrived" from a purely local re-slice of the same diff (the
     * "My edits only" filter handing DiffFeed a new array of the same
     * files). Each call makes a new `diff` object, exactly as `doRefresh`
     * does on every successful fetch. */
    function seedFetchedDiff(files: FileDiff[]): void {
      useChanges.setState({
        bySession: {
          s1: {
            baselineLabel: "HEAD · uncommitted",
            collapsed: {},
            diff: { base: "HEAD", files },
            fetchedAt: Date.now(),
            hunkHashes: {},
            status: "ready",
            totals: null,
            viewed: {},
          },
        },
      });
    }

    it("restores the virtualizer's scroll offset when files change while scrolled away from the top", () => {
      const files = manyFiles(30);
      const { rerender } = render(<DiffFeed files={files} sessionId="s1" />);
      const feed = screen.getByTestId("diff-feed");
      fireEvent.scroll(feed, { target: { scrollTop: 3000 } });

      const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");

      // A refresh landing: same paths, but a brand-new array — the exact
      // shape `entry.diff.files` takes after every `doRefresh` in
      // state/changesRefresh.ts, success or not.
      rerender(<DiffFeed files={[...files]} sessionId="s1" />);

      expect(scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 3000 })
      );
    });

    it("calls onSilentRefresh when a refresh lands while scrolled away from the top", () => {
      const onSilentRefresh = vi.fn();
      const files = manyFiles(30);
      seedFetchedDiff(files);
      const { rerender } = render(
        <DiffFeed
          files={files}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );
      const feed = screen.getByTestId("diff-feed");
      fireEvent.scroll(feed, { target: { scrollTop: 3000 } });

      act(() => {
        seedFetchedDiff([...files]);
      });
      rerender(
        <DiffFeed
          files={[...files]}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );

      expect(onSilentRefresh).toHaveBeenCalledTimes(1);
    });

    it("does not report a silent refresh for a purely local view change (the 'My edits only' filter narrowing the same diff)", () => {
      // Toggling the filter hands DiffFeed a brand-new array sliced from the
      // very same store diff — no new content arrived, so the summary bar
      // must not pulse as if a refresh had landed.
      const onSilentRefresh = vi.fn();
      const files = manyFiles(30);
      seedFetchedDiff(files);
      const { rerender } = render(
        <DiffFeed
          files={files}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );
      const feed = screen.getByTestId("diff-feed");
      fireEvent.scroll(feed, { target: { scrollTop: 3000 } });

      rerender(
        <DiffFeed
          files={files.slice(0, 5)}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );

      expect(onSilentRefresh).not.toHaveBeenCalled();
    });

    it("does not restore scroll or report a silent refresh when already at the top", () => {
      const onSilentRefresh = vi.fn();
      const files = manyFiles(30);
      seedFetchedDiff(files);
      const { rerender } = render(
        <DiffFeed
          files={files}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );
      const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");

      act(() => {
        seedFetchedDiff([...files]);
      });
      rerender(
        <DiffFeed
          files={[...files]}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );

      expect(onSilentRefresh).not.toHaveBeenCalled();
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it("does not treat the initial mount as a silent refresh", () => {
      const onSilentRefresh = vi.fn();
      render(
        <DiffFeed
          files={manyFiles(30)}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );

      expect(onSilentRefresh).not.toHaveBeenCalled();
    });

    it("does not restore scroll or report a silent refresh when the files prop is unchanged across a re-render", () => {
      const onSilentRefresh = vi.fn();
      const files = manyFiles(30);
      const { rerender } = render(
        <DiffFeed
          files={files}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );
      const feed = screen.getByTestId("diff-feed");
      fireEvent.scroll(feed, { target: { scrollTop: 3000 } });
      const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");

      // Same array reference — an unrelated re-render (e.g. a collapse
      // toggle), not a refresh.
      rerender(
        <DiffFeed
          files={files}
          onSilentRefresh={onSilentRefresh}
          sessionId="s1"
        />
      );

      expect(onSilentRefresh).not.toHaveBeenCalled();
      expect(scrollToSpy).not.toHaveBeenCalled();
    });
  });
});
