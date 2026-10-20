import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type StructuredTurn,
  structuredTurns,
  submitPrompt,
} from "../ipc/bridge.ts";
import { useAttachments } from "../state/attachments.ts";
import { useDrafts } from "../state/drafts.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { registerScreenText } from "../terminal/screenText.ts";
import { sendPrompt, untilSent } from "./send.ts";
import { SENT_PROMPT_TTL_MS } from "./sentPrompt.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  structuredTurns: vi.fn(() => Promise.resolve([])),
  submitPrompt: vi.fn(() => Promise.resolve()),
}));

const image = {
  bytes: 1,
  caution: null,
  convertedFrom: null,
  kind: "image" as const,
  name: "a.png",
  path: "/a.png",
};

const message = (text: string) => ({
  at: 1000,
  attachments: [image],
  draft: text,
  text,
});

/** A submit that resolves (or rejects) when the test says. */
function heldSubmit() {
  let release: (error?: unknown) => void = () => undefined;
  vi.mocked(submitPrompt).mockImplementationOnce(
    () =>
      new Promise<void>((resolve, reject) => {
        release = (error) => (error === undefined ? resolve() : reject(error));
      })
  );
  return (error?: unknown) => release(error);
}

beforeEach(() => {
  vi.mocked(submitPrompt).mockClear();
  useSentPrompts.setState({ sent: {} });
  useAttachments.setState({ bySession: {} });
  useDrafts.setState({ drafts: {}, insertRequest: null });
});

test("a sent message is noted at once and typed by the backend", async () => {
  sendPrompt("s1", message("go"));
  expect(useSentPrompts.getState().sent.s1?.text).toBe("go");
  await untilSent("s1");
  expect(submitPrompt).toHaveBeenCalledWith("s1", "go", ["/a.png"]);
});

test("a send that fails hands the message back to the composer", async () => {
  vi.mocked(submitPrompt).mockRejectedValueOnce("session not found");
  sendPrompt("s1", message("go"));
  await untilSent("s1");
  expect(useSentPrompts.getState().sent.s1).toBeUndefined();
  expect(useAttachments.getState().bySession.s1).toEqual([image]);
  expect(useDrafts.getState().insertRequest).toMatchObject({
    sessionId: "s1",
    text: "go",
  });
});

test("a second send waits until the first is typed", async () => {
  const release = heldSubmit();
  sendPrompt("s1", message("one"));
  sendPrompt("s1", message("two"));
  await Promise.resolve();
  expect(submitPrompt).toHaveBeenCalledTimes(1);
  release();
  await untilSent("s1");
  expect(vi.mocked(submitPrompt).mock.calls.map((c) => c[1])).toEqual([
    "one",
    "two",
  ]);
});

test("waiting for a send ends once it is typed, whether it worked or not", async () => {
  const release = heldSubmit();
  sendPrompt("s1", message("go"));
  let done = false;
  const waiting = untilSent("s1")?.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release("write failed");
  await waiting;
  expect(done).toBe(true);
  // Nothing in flight: nothing to wait for.
  expect(untilSent("s1")).toBeNull();
});

describe("a sent prompt settles on its own, whichever view is on screen", () => {
  const answered = (prompt: string): StructuredTurn => ({
    did: [],
    ended: true,
    endedMs: null,
    images: [],
    reports: [],
    interrupted: false,
    prompt,
    reply: "Done.",
    source: "live",
    startedMs: null,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    // The messages say they were sent at 1000.
    vi.setSystemTime(1000);
    vi.mocked(structuredTurns).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("once Claude has started on it", async () => {
    sendPrompt("s1", message("go"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(useSentPrompts.getState().sent.s1).toBeDefined();
    vi.mocked(structuredTurns).mockResolvedValue([answered("go")]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(useSentPrompts.getState().sent.s1).toBeUndefined();
  });

  test("once a dialog it opened closes, which writes no turn", async () => {
    let rows = ["❯ "];
    const unregister = registerScreenText("s1", () => rows);
    sendPrompt("s1", message("/mcp"));
    rows = ["  Manage MCP servers", " ↑/↓ to navigate · Esc to cancel"];
    await vi.advanceTimersByTimeAsync(1000);
    expect(useSentPrompts.getState().sent.s1).toBeDefined();
    rows = ["❯ "];
    await vi.advanceTimersByTimeAsync(1000);
    expect(useSentPrompts.getState().sent.s1).toBeUndefined();
    unregister();
  });

  test("once it is too old to wait for", async () => {
    sendPrompt("s1", message("go"));
    await vi.advanceTimersByTimeAsync(SENT_PROMPT_TTL_MS + 2000);
    expect(useSentPrompts.getState().sent.s1).toBeUndefined();
  });

  test("a newer send is not settled by what settled the one before", async () => {
    vi.mocked(structuredTurns).mockResolvedValue([answered("one")]);
    sendPrompt("s1", message("one"));
    sendPrompt("s1", message("two"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(useSentPrompts.getState().sent.s1?.text).toBe("two");
  });
});
