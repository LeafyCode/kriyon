import { beforeEach, expect, test, vi } from "vitest";
import {
  noteInterrupted,
  structuredTurns,
  submitPrompt,
  writeStdin,
} from "../ipc/bridge.ts";
import { useAttachments } from "../state/attachments.ts";
import { useDrafts } from "../state/drafts.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { afterEsc, interruptSession, resetInterruptGate } from "./interrupt.ts";
import { sendPrompt } from "./send.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  noteInterrupted: vi.fn(() => Promise.resolve()),
  structuredTurns: vi.fn(),
  submitPrompt: vi.fn(() => Promise.resolve()),
  writeStdin: vi.fn(() => Promise.resolve()),
}));

const decode = (call: unknown[]) =>
  new TextDecoder().decode(call[1] as Uint8Array);
const image = {
  bytes: 1,
  caution: null,
  convertedFrom: null,
  kind: "image" as const,
  name: "a.png",
  path: "/a.png",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(writeStdin).mockClear();
  vi.mocked(noteInterrupted).mockClear();
  vi.mocked(structuredTurns).mockResolvedValue([]);
  resetInterruptGate();
  useSentPrompts.setState({ sent: {} });
  useAttachments.setState({ bySession: {} });
  useDrafts.setState({ drafts: {}, insertRequest: null });
});

const run = async (work: Promise<void>) => {
  await vi.runAllTimersAsync();
  await work;
};

test("Esc goes to the terminal, once however fast it is pressed", async () => {
  const first = interruptSession("s1");
  const second = interruptSession("s1");
  await run(Promise.all([first, second]).then(() => undefined));
  expect(vi.mocked(writeStdin).mock.calls.map(decode)).toEqual(["\u001b"]);
});

test("an Esc shown to have stopped the turn ends the working status", async () => {
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      did: [],
      ended: false,
      endedMs: null,
      images: [],
      reports: [],
      interrupted: true,
      prompt: "go",
      reply: "Once",
      source: "live",
      startedMs: null,
    },
  ]);
  await run(afterEsc("s1"));
  expect(noteInterrupted).toHaveBeenCalledWith("s1");
});

test("an Esc that stopped nothing (a finished turn) leaves the status alone", async () => {
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      did: [],
      ended: false,
      endedMs: null,
      images: [],
      reports: [],
      interrupted: false,
      prompt: "go",
      reply: "Done.",
      source: "live",
      startedMs: null,
    },
  ]);
  await run(afterEsc("s1"));
  expect(noteInterrupted).not.toHaveBeenCalled();
});

test("a prompt Claude never started on comes back to the composer", async () => {
  useSentPrompts.getState().note("s1", {
    at: Date.now(),
    attachments: [image],
    draft: "fix /build it",
    text: "fix /build it",
  });
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      did: [],
      ended: false,
      endedMs: null,
      images: [],
      reports: [],
      interrupted: false,
      prompt: "fix /build it [Image #1]",
      reply: null,
      source: "live",
      startedMs: null,
    },
  ]);
  await run(interruptSession("s1"));
  expect(vi.mocked(writeStdin).mock.calls.map(decode)).toEqual([
    "\u001b",
    "\u0015\u0015",
  ]);
  expect(useDrafts.getState().insertRequest?.text).toBe("fix /build it");
  expect(useAttachments.getState().bySession.s1).toEqual([image]);
  expect(useSentPrompts.getState().sent.s1).toBeUndefined();
});

test("a prompt Claude was answering stays where it is", async () => {
  useSentPrompts
    .getState()
    .note("s1", { at: Date.now(), attachments: [], draft: "go", text: "go" });
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      did: [],
      ended: false,
      endedMs: null,
      images: [],
      reports: [],
      interrupted: true,
      prompt: "go",
      reply: "Once",
      source: "live",
      startedMs: null,
    },
  ]);
  await run(interruptSession("s1"));
  expect(vi.mocked(writeStdin)).toHaveBeenCalledTimes(1);
  expect(useDrafts.getState().insertRequest).toBeNull();
});

test("Esc waits for a message still being typed, so it never lands inside it", async () => {
  let typed: () => void = () => undefined;
  vi.mocked(submitPrompt).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        typed = resolve;
      })
  );
  sendPrompt("s1", {
    at: Date.now(),
    attachments: [image],
    draft: "go",
    text: "go",
  });
  const stopping = interruptSession("s1");
  await Promise.resolve();
  expect(writeStdin).not.toHaveBeenCalled();
  typed();
  await run(stopping);
  expect(vi.mocked(writeStdin).mock.calls.map(decode)[0]).toBe("\u001b");
});
