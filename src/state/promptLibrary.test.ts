import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedPrompt } from "../types.ts";
import {
  EMPTY_LIBRARY_COPY,
  filterPrompts,
  importPromptsFromCommands,
  orderPrompts,
  usePromptLibrary,
} from "./promptLibrary.ts";
import { useSessions } from "./sessions.ts";

vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  importCommands: vi.fn(() => Promise.resolve([])),
  listPrompts: vi.fn(() => Promise.resolve([])),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));

vi.mock("../ui/Toast.tsx", () => ({
  showToast: vi.fn(),
}));

function prompt(over: Partial<SavedPrompt>): SavedPrompt {
  return {
    body: "body",
    createdMs: 1,
    favourite: false,
    id: "p1",
    lastUsedMs: null,
    tags: [],
    title: "title",
    updatedMs: 1,
    useCount: 0,
    ...over,
  };
}

describe("usePromptLibrary", () => {
  beforeEach(() => {
    usePromptLibrary.setState({ prompts: [] });
    vi.clearAllMocks();
  });

  it("save upserts optimistically and calls the bridge", async () => {
    const bridge = await import("../ipc/bridge.ts");
    usePromptLibrary.getState().save(prompt({}));
    usePromptLibrary.getState().save(prompt({ title: "renamed" }));
    expect(usePromptLibrary.getState().prompts).toHaveLength(1);
    expect(usePromptLibrary.getState().prompts[0].title).toBe("renamed");
    expect(bridge.upsertPrompt).toHaveBeenCalledTimes(2);
  });

  it("remove deletes optimistically and calls the bridge", async () => {
    const bridge = await import("../ipc/bridge.ts");
    usePromptLibrary.setState({ prompts: [prompt({})] });
    usePromptLibrary.getState().remove("p1");
    expect(usePromptLibrary.getState().prompts).toEqual([]);
    expect(bridge.deletePrompt).toHaveBeenCalledWith("p1");
  });

  it("markUsed bumps count/time optimistically and calls the bridge", async () => {
    const bridge = await import("../ipc/bridge.ts");
    usePromptLibrary.setState({ prompts: [prompt({})] });
    usePromptLibrary.getState().markUsed("p1", 9000);
    const [updated] = usePromptLibrary.getState().prompts;
    expect(updated.useCount).toBe(1);
    expect(updated.lastUsedMs).toBe(9000);
    expect(bridge.recordPromptUse).toHaveBeenCalledWith("p1");
  });

  it("toggleFavourite flips the flag through save", () => {
    usePromptLibrary.setState({ prompts: [prompt({})] });
    usePromptLibrary.getState().toggleFavourite("p1", 9000);
    expect(usePromptLibrary.getState().prompts[0].favourite).toBe(true);
  });
});

describe("importPromptsFromCommands", () => {
  beforeEach(() => {
    usePromptLibrary.setState({ prompts: [] });
    useSessions.setState({
      activeSessionId: null,
      projects: [],
      sessions: {},
    });
    vi.clearAllMocks();
  });

  it("saves a prompt per imported command, titled from description, tagged imported", async () => {
    const bridge = await import("../ipc/bridge.ts");
    vi.mocked(bridge.importCommands).mockResolvedValueOnce([
      { body: "B", description: "Review", name: "review" },
    ]);

    await importPromptsFromCommands();

    const saved = usePromptLibrary.getState().prompts;
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe("Review");
    expect(saved[0].body).toBe("B");
    expect(saved[0].tags).toEqual(["imported"]);
    expect(bridge.importCommands).toHaveBeenCalledWith(null);
  });

  it("a second call adds nothing (idempotent re-import)", async () => {
    const bridge = await import("../ipc/bridge.ts");
    vi.mocked(bridge.importCommands).mockResolvedValue([
      { body: "B", description: "Review", name: "review" },
    ]);

    await importPromptsFromCommands();
    await importPromptsFromCommands();

    expect(usePromptLibrary.getState().prompts).toHaveLength(1);
  });

  it("imports both global and the active session's project scope", async () => {
    const bridge = await import("../ipc/bridge.ts");
    vi.mocked(bridge.importCommands).mockImplementation((projectId) =>
      Promise.resolve(
        projectId === null
          ? [{ body: "G", description: "Global one", name: "global-one" }]
          : [{ body: "P", description: "Project one", name: "project-one" }]
      )
    );
    useSessions.setState({
      activeSessionId: "s1",
      projects: [
        {
          color: null,
          id: "proj1",
          name: "Proj",
          path: "/p",
          setupCommand: null,
        },
      ],
      sessions: {
        s1: {
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: null,
          createdAt: 1,
          cwd: "/p",
          id: "s1",
          projectId: "proj1",
          status: "idle",
          summary: "",
          title: "S1",
          titleLocked: false,
          worktreePath: null,
        },
      },
    });

    await importPromptsFromCommands();

    expect(bridge.importCommands).toHaveBeenCalledWith(null);
    expect(bridge.importCommands).toHaveBeenCalledWith("proj1");
    const titles = usePromptLibrary
      .getState()
      .prompts.map((p) => p.title)
      .sort();
    expect(titles).toEqual(["Global one", "Project one"]);
  });

  it("still imports global commands when the project scope fails", async () => {
    const bridge = await import("../ipc/bridge.ts");
    const toast = await import("../ui/Toast.tsx");
    vi.mocked(bridge.importCommands).mockImplementation((projectId) =>
      projectId === null
        ? Promise.resolve([
            { body: "G", description: "Global one", name: "global-one" },
          ])
        : Promise.reject(new Error("unknown project"))
    );
    useSessions.setState({
      activeSessionId: "s1",
      projects: [],
      sessions: {
        s1: {
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: null,
          createdAt: 1,
          cwd: "/p",
          id: "s1",
          projectId: "stale",
          status: "idle",
          summary: "",
          title: "S1",
          titleLocked: false,
          worktreePath: null,
        },
      },
    });

    await importPromptsFromCommands();

    const saved = usePromptLibrary.getState().prompts;
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe("Global one");
    expect(toast.showToast).toHaveBeenCalledWith(
      "Imported 1 prompt (project commands unavailable)"
    );
  });

  it("skips an imported command whose name matches an existing prompt's title", async () => {
    const bridge = await import("../ipc/bridge.ts");
    usePromptLibrary.setState({
      prompts: [prompt({ id: "existing", title: "review" })],
    });
    vi.mocked(bridge.importCommands).mockResolvedValueOnce([
      { body: "B", description: "Review", name: "review" },
    ]);

    await importPromptsFromCommands();

    expect(usePromptLibrary.getState().prompts).toHaveLength(1);
  });

  it("shows a toast summarizing added/skipped, and reports errors", async () => {
    const bridge = await import("../ipc/bridge.ts");
    const toast = await import("../ui/Toast.tsx");
    vi.mocked(bridge.importCommands).mockResolvedValueOnce([
      { body: "B", description: "Review", name: "review" },
    ]);

    await importPromptsFromCommands();

    expect(toast.showToast).toHaveBeenCalledWith("Imported 1 prompt");

    vi.mocked(bridge.importCommands).mockRejectedValueOnce(new Error("boom"));
    await importPromptsFromCommands();
    expect(toast.showToast).toHaveBeenCalledWith("boom", "error");
  });
});

describe("filterPrompts", () => {
  it("matches title, tags, and body case-insensitively", () => {
    const list = [
      prompt({ id: "a", title: "Refactor plan" }),
      prompt({ id: "b", tags: ["review"], title: "Other" }),
      prompt({ body: "deep REVIEW notes", id: "c", title: "Third" }),
    ];
    expect(filterPrompts(list, "review").map((x) => x.id)).toEqual(["b", "c"]);
    expect(filterPrompts(list, "REFACTOR").map((x) => x.id)).toEqual(["a"]);
  });

  it("returns every prompt for a blank query", () => {
    const list = [prompt({ id: "a" }), prompt({ id: "b" })];
    expect(filterPrompts(list, "   ")).toHaveLength(2);
  });
});

describe("EMPTY_LIBRARY_COPY", () => {
  it("is the shared save/import affordance copy", () => {
    expect(EMPTY_LIBRARY_COPY).toContain("No saved prompts yet");
  });
});

describe("orderPrompts", () => {
  it("orders favourites first, then recent use, then title", () => {
    const ordered = orderPrompts([
      prompt({ id: "c", title: "c zebra" }),
      prompt({ id: "b", lastUsedMs: 100, title: "b used" }),
      prompt({ favourite: true, id: "a", title: "a fav" }),
      prompt({ id: "d", title: "a alpha" }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(["a", "b", "d", "c"]);
  });
});
