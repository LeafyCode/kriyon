import { describe, expect, test } from "vitest";
import {
  type HostSummary,
  needsYou,
  pairingCodeFrom,
  type SessionSummary,
  standingLabel,
} from "./hostSummary.ts";

const session = (over: Partial<SessionSummary>): SessionSummary => ({
  dialogOpen: false,
  id: "s",
  lastChangeMs: 0,
  mayType: false,
  needsYou: false,
  projectId: "p",
  standing: "idle",
  status: "idle",
  title: "A session",
  typing: null,
  ...over,
});

const summary = (over: Partial<HostSummary>): HostSummary => ({
  hostId: "a",
  hostName: "Mac",
  link: "connected",
  mayStart: false,
  projects: [],
  refused: null,
  role: "controller",
  sessions: [],
  ...over,
});

describe("needs you", () => {
  test("only sessions waiting on connected, still-paired computers, in each computer's own order", () => {
    const hosts = [
      { hostId: "a", name: "Mac" },
      { hostId: "b", name: "Studio" },
    ];
    const summaries = {
      a: summary({
        sessions: [
          session({ id: "old", lastChangeMs: 1, needsYou: true }),
          session({ id: "busy" }),
          session({ id: "new", lastChangeMs: 9, needsYou: true }),
        ],
      }),
      b: summary({
        hostId: "b",
        link: "lost",
        sessions: [session({ id: "away", needsYou: true })],
      }),
      gone: summary({
        hostId: "gone",
        sessions: [session({ needsYou: true })],
      }),
    };
    expect(
      needsYou(hosts, summaries).map((one) => [one.host.name, one.session.id])
    ).toEqual([
      // The computer's order (the desktop's: longest-waiting first), kept.
      ["Mac", "old"],
      ["Mac", "new"],
    ]);
  });
});

test("each standing reads as the desktop says it", () => {
  expect(standingLabel("running")).toBe("Running");
  expect(standingLabel("awaiting_input")).toBe("Awaiting input");
  expect(standingLabel("changed")).toBe("Changed");
  expect(standingLabel("idle")).toBe("Idle");
  expect(standingLabel("unknown")).toBe("Unknown");
});

test("only a Kriyon pairing code is taken", () => {
  const code = `kriyon-pair:1:${"ab".repeat(4)}`;
  expect(pairingCodeFrom(` ${code}\n`)).toBe(code);
  expect(pairingCodeFrom("kriyon-pair:2:ab")).toBeNull();
  expect(pairingCodeFrom("https://example.com")).toBeNull();
});
