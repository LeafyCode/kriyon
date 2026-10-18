import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listPastSessions } = vi.hoisted(() => ({
  listPastSessions: vi.fn(),
}));
const { resumePastSession } = vi.hoisted(() => ({
  resumePastSession: vi.fn(),
}));
vi.mock("../ipc/bridge.ts", () => ({ listPastSessions }));
vi.mock("../state/actions.ts", () => ({ resumePastSession }));

import { useSessions } from "../state/sessions.ts";
import { clearPastSessionsCache, EarlierSessions } from "./EarlierSessions.tsx";

const RE_HISTORY = /^history$/i;
const RE_SHOW_MORE = /show more/i;
const RE_BRANCH_GLYPH = /\u2387/;
const RE_LOAD_FAILED = /couldn't load history/i;
const RE_NO_EARLIER = /no earlier sessions/i;

function page(items: unknown[], total: number) {
  return { items, total };
}

function past(id: string, title: string) {
  return {
    claudeSessionId: id,
    lastActiveMs: 1_700_000_000_000,
    title,
    preview: null,
    cwd: "/work/repo",
    gitBranch: "main",
    version: "2.1.181",
    messageCount: 4,
  };
}

/**
 * The disclosure {@link EarlierSessions} no longer owns. The list is controlled
 * now — its "older · history" row lives on the project group — so these tests
 * supply the same open/close button the group provides, and every assertion
 * about lazy fetching, caching and revalidation keeps driving it exactly as a
 * user does.
 */
function HistorySection() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((wasOpen) => !wasOpen)} type="button">
        History
      </button>
      <EarlierSessions
        open={open}
        projectId="/work/repo"
        projectPath="/work/repo"
      />
    </>
  );
}

describe("EarlierSessions", () => {
  beforeEach(() => {
    listPastSessions.mockReset();
    resumePastSession.mockReset();
    clearPastSessionsCache();
    useSessions.setState({ sessions: {} });
  });
  afterEach(() => {
    // no-op; state reset in beforeEach
  });

  it("fetches lazily on expand, dedupes tracked sessions, and resumes on click", async () => {
    // One of the two past sessions is already tracked by Kriyon and must be hidden.
    useSessions.setState({
      sessions: {
        live: {
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: "tracked",
          createdAt: 1,
          cwd: "/work/repo",
          id: "live",
          projectId: "/work/repo",
          status: "idle",
          summary: "",
          title: "Live",
          titleLocked: false,
          worktreePath: null,
        },
      },
    });
    listPastSessions.mockResolvedValueOnce(
      page([past("tracked", "Tracked"), past("fresh", "Fresh one")], 2)
    );

    render(<HistorySection />);

    // Not fetched until expanded.
    expect(listPastSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));

    await waitFor(() =>
      expect(listPastSessions).toHaveBeenCalledWith("/work/repo", 15)
    );
    expect(await screen.findByText("Fresh one")).toBeInTheDocument();
    expect(screen.queryByText("Tracked")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Fresh one"));
    expect(resumePastSession).toHaveBeenCalledWith(
      expect.objectContaining({ claudeSessionId: "fresh" })
    );
  });

  it("keeps rows to one line: branch in the tooltip, compact time on the right", async () => {
    listPastSessions.mockResolvedValueOnce(
      page([past("a", "Fix reattach")], 1)
    );

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    const row = (await screen.findByText("Fix reattach")).closest("button");

    // The branch no longer eats row width — it moves into the hover tooltip.
    expect(row).toHaveAttribute("title", expect.stringContaining("main"));
    expect(screen.queryByText(RE_BRANCH_GLYPH)).not.toBeInTheDocument();
    // The compact timestamp sits in the row as its own right-column span.
    expect(row?.querySelector("[data-testid=history-time]")).not.toBeNull();
  });

  it("animates the expanded list in", async () => {
    listPastSessions.mockResolvedValueOnce(page([past("a", "A")], 1));

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));

    expect((await screen.findByTestId("history-list")).className).toContain(
      "kr-disclose"
    );
  });

  it("does not show empty-state when all fetched items are deduped but more are fetchable", async () => {
    // The one fetched item is already tracked — visible list is empty.
    // But total > items.length means more are fetchable, so "Show more" must
    // appear and "No earlier sessions" must NOT appear.
    useSessions.setState({
      sessions: {
        live: {
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: "tracked-id",
          createdAt: 1,
          cwd: "/work/repo",
          id: "live",
          projectId: "/work/repo",
          status: "idle",
          summary: "",
          title: "Live",
          titleLocked: false,
          worktreePath: null,
        },
      },
    });
    listPastSessions.mockResolvedValueOnce(
      page([past("tracked-id", "Tracked")], 5)
    );

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    await waitFor(() =>
      expect(listPastSessions).toHaveBeenCalledWith("/work/repo", 15)
    );

    // visible is empty but more are fetchable — "No earlier sessions" must be absent
    expect(screen.queryByText("No earlier sessions")).not.toBeInTheDocument();
    // "Show more" must be present (items.length 1 < total 5)
    expect(
      screen.getByRole("button", { name: RE_SHOW_MORE })
    ).toBeInTheDocument();
  });

  it("shows empty-state only when visible is empty AND nothing more is fetchable", async () => {
    // Fetched one item that is tracked, and total === items.length (nothing more to fetch).
    useSessions.setState({
      sessions: {
        live: {
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: "tracked-id",
          createdAt: 1,
          cwd: "/work/repo",
          id: "live",
          projectId: "/work/repo",
          status: "idle",
          summary: "",
          title: "Live",
          titleLocked: false,
          worktreePath: null,
        },
      },
    });
    listPastSessions.mockResolvedValueOnce(
      page([past("tracked-id", "Tracked")], 1)
    );

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    await waitFor(() =>
      expect(listPastSessions).toHaveBeenCalledWith("/work/repo", 15)
    );

    // visible is empty AND nothing more to fetch — empty-state must appear
    expect(screen.getByText("No earlier sessions")).toBeInTheDocument();
    // "Show more" must NOT appear (items.length 1 >= total 1)
    expect(
      screen.queryByRole("button", { name: RE_SHOW_MORE })
    ).not.toBeInTheDocument();
  });

  it("shows skeleton rows while the first fetch is in flight", async () => {
    let resolve: (value: unknown) => void = () => {
      // replaced synchronously by the promise executor below
    };
    listPastSessions.mockReturnValueOnce(
      new Promise((res) => {
        resolve = res;
      })
    );

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));

    // Nothing cached yet → skeleton placeholders, not a bare "Loading…".
    expect(screen.getAllByTestId("history-skeleton-row")).toHaveLength(3);

    resolve(page([past("a", "A")], 1));
    expect(await screen.findByText("A")).toBeInTheDocument();
    expect(
      screen.queryByTestId("history-skeleton-row")
    ).not.toBeInTheDocument();
  });

  it("serves the cache instantly on re-expand and revalidates in the background", async () => {
    listPastSessions.mockResolvedValueOnce(page([past("a", "A")], 1));

    const { unmount } = render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    await screen.findByText("A");
    unmount();

    // Second mount: a slow refetch is in flight, but the cached page paints
    // immediately — stale-while-revalidate.
    let resolve: (value: unknown) => void = () => {
      // replaced synchronously by the promise executor below
    };
    listPastSessions.mockReturnValueOnce(
      new Promise((res) => {
        resolve = res;
      })
    );
    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));

    expect(screen.getByText("A")).toBeInTheDocument();
    expect(
      screen.queryByTestId("history-skeleton-row")
    ).not.toBeInTheDocument();
    expect(listPastSessions).toHaveBeenCalledTimes(2);

    // The fresh page replaces the stale one when it lands.
    resolve(page([past("a", "A"), past("b", "B")], 2));
    expect(await screen.findByText("B")).toBeInTheDocument();
  });

  it("keeps the stale page when a revalidation fails", async () => {
    listPastSessions.mockResolvedValueOnce(page([past("a", "A")], 1));

    const { unmount } = render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    await screen.findByText("A");
    unmount();

    listPastSessions.mockRejectedValueOnce(new Error("ipc down"));
    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));

    await waitFor(() => expect(listPastSessions).toHaveBeenCalledTimes(2));
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("a stale slow response cannot overwrite a newer page or the cache", async () => {
    // A slow fetch survives its component unmounting (project group collapse);
    // the remounted component fetches again and gets the newer, larger page.
    // When the slow original finally lands it must be discarded — not shrink
    // the list or poison the cache.
    let resolveSlow: (value: unknown) => void = () => {
      // replaced synchronously by the promise executor below
    };
    listPastSessions.mockReturnValueOnce(
      new Promise((res) => {
        resolveSlow = res;
      })
    );

    const first = render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    first.unmount();

    listPastSessions.mockResolvedValueOnce(
      page([past("a", "A"), past("b", "B")], 2)
    );
    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    expect(await screen.findByText("B")).toBeInTheDocument();

    // The stale original lands last with a smaller page — and is ignored.
    resolveSlow(page([past("a", "A")], 1));
    await waitFor(() => expect(screen.getByText("B")).toBeInTheDocument());
  });

  it("re-expanding while a scan is in flight does not stack another fetch", () => {
    listPastSessions.mockReturnValue(
      new Promise(() => {
        // never resolves — the scan stays in flight for the whole test
      })
    );

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));

    expect(listPastSessions).toHaveBeenCalledTimes(1);
  });

  it("a cold expand whose fetch fails admits it instead of claiming empty", async () => {
    listPastSessions.mockRejectedValueOnce(new Error("ipc down"));

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));

    expect(await screen.findByText(RE_LOAD_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(RE_NO_EARLIER)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("history-skeleton-row")
    ).not.toBeInTheDocument();
  });

  it("raises the limit and refetches on Show more", async () => {
    listPastSessions
      .mockResolvedValueOnce(page([past("a", "A")], 30))
      .mockResolvedValueOnce(page([past("a", "A"), past("b", "B")], 30));

    render(<HistorySection />);
    fireEvent.click(screen.getByRole("button", { name: RE_HISTORY }));
    await screen.findByText("A");

    fireEvent.click(screen.getByRole("button", { name: RE_SHOW_MORE }));
    await waitFor(() =>
      expect(listPastSessions).toHaveBeenLastCalledWith("/work/repo", 45)
    );
    expect(await screen.findByText("B")).toBeInTheDocument();
  });
});
