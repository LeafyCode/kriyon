import { expect, test } from "@jest/globals";
import type {
  HostSummary,
  SessionSummary,
} from "../../../../src/remote/hostSummary.ts";
import {
  ageText,
  glance,
  hostRows,
  kindOf,
  linkWords,
  needsYouCards,
  pillFor,
  projectChoices,
  roleWord,
  runningFor,
  shortKey,
} from "./home.ts";

const MAC = "ab".repeat(32);
const STUDIO = "cd".repeat(32);
const NOW = 1_800_000_000_000;

const session = (over: Partial<SessionSummary>): SessionSummary => ({
  dialogOpen: false,
  id: "s",
  lastChangeMs: NOW,
  mayType: false,
  needsYou: false,
  projectId: "p",
  standing: "idle",
  status: "idle",
  title: "A session",
  typing: null,
  ...over,
});

const asking = session({
  dialogOpen: true,
  id: "ask",
  lastChangeMs: NOW - 4 * 60_000,
  needsYou: true,
  standing: "awaiting_input",
  status: "waiting",
});
const yourTurn = session({
  id: "turn",
  lastChangeMs: NOW - 12 * 60_000,
  needsYou: true,
  standing: "awaiting_input",
  status: "waiting",
});
const running = session({ id: "run", standing: "running", status: "running" });
const idle = session({ id: "idle" });

const host = (over: Partial<HostSummary>): HostSummary => ({
  hostId: MAC,
  hostName: "MacBook Pro",
  link: "connected",
  mayStart: true,
  projects: [],
  refused: null,
  role: "controller",
  sessions: [asking, yourTurn, running, idle],
  ...over,
});

const paired = [
  {
    addrs: [],
    hostId: MAC,
    name: "MacBook Pro",
    pairedAtMs: 1,
    relayUrl: null,
  },
  {
    addrs: [],
    hostId: STUDIO,
    name: "Studio iMac",
    pairedAtMs: 2,
    relayUrl: null,
  },
];

test("a session is asking, your turn, running or idle, in that order of need", () => {
  expect(kindOf(asking)).toBe("asking");
  expect(kindOf(yourTurn)).toBe("yourTurn");
  expect(kindOf(running)).toBe("running");
  expect(kindOf(idle)).toBe("idle");
  expect(kindOf(session({ standing: "changed", status: "done" }))).toBe("idle");
});

test("at a glance counts the sessions of connected computers by kind", () => {
  const states = {
    [MAC]: host({}),
    [STUDIO]: host({ hostId: STUDIO, link: "lost", sessions: [running] }),
  };
  expect(glance(paired, states)).toEqual({
    asking: 1,
    idle: 1,
    needsYou: 2,
    running: 1,
    total: 4,
    yourTurn: 1,
  });
});

test("needs you lists asking and your-turn sessions in the computer's order, with their kind", () => {
  const cards = needsYouCards(paired, { [MAC]: host({}) });
  expect(cards.map(({ kind, session: s }) => [kind, s.id])).toEqual([
    ["asking", "ask"],
    ["yourTurn", "turn"],
  ]);
});

test("a computer's own rows leave out what needs you: running first, idle folded", () => {
  expect(hostRows(host({}), "all")).toEqual({
    idle: [idle],
    running: [running],
  });
  expect(hostRows(host({}), "running")).toEqual({
    idle: [],
    running: [running],
  });
  expect(hostRows(host({}), "needsYou")).toEqual({ idle: [], running: [] });
});

test("status is always said in a word, with how long where it helps", () => {
  expect(pillFor(asking, NOW)).toEqual({ label: "Asking · 4m", tone: "amber" });
  expect(pillFor(yourTurn, NOW)).toEqual({
    label: "Your turn · 12m",
    tone: "green",
  });
  expect(pillFor(running, NOW)).toEqual({ label: "Running", tone: "blue" });
  expect(pillFor({ ...running, runningSinceMs: NOW - 192_000 }, NOW)).toEqual({
    label: "Running 3:12",
    tone: "blue",
  });
  expect(pillFor(idle, NOW)).toEqual({ label: "Idle", tone: "plain" });
});

test("ages and running times read short", () => {
  expect(ageText(NOW - 20_000, NOW)).toBe("now");
  expect(ageText(NOW - 4 * 60_000, NOW)).toBe("4m");
  expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe("3h");
  expect(ageText(NOW - 2 * 86_400_000, NOW)).toBe("2d");
  expect(ageText(0, NOW)).toBeNull();
  expect(runningFor(NOW - 48_000, NOW)).toBe("0:48");
  expect(runningFor(NOW - 3_723_000, NOW)).toBe("1:02:03");
});

test("a computer's line says how it is linked, by which path, and its role", () => {
  expect(linkWords(host({}), NOW)).toBe("Connected · Controller");
  expect(linkWords(host({ path: "direct" }), NOW)).toBe(
    "Connected · direct · Controller"
  );
  expect(linkWords(host({ path: "relay", role: "viewer" }), NOW)).toBe(
    "Connected · through the relay · Viewer"
  );
  expect(linkWords(host({ link: "lost", role: "viewer" }), NOW)).toBe(
    "Reconnecting · Viewer"
  );
  expect(
    linkWords(
      host({ lastSeenMs: NOW - 3 * 60_000, link: "lost", role: "viewer" }),
      NOW
    )
  ).toBe("Reconnecting · last seen 3m ago · Viewer");
  expect(linkWords(host({ link: "connecting", role: null }), NOW)).toBe(
    "Connecting…"
  );
  // Heard from before (it went away, its link closed): it reconnects.
  expect(
    linkWords(
      host({
        lastSeenMs: NOW - 2 * 60_000,
        link: "connecting",
        role: "controller",
      }),
      NOW
    )
  ).toBe("Reconnecting · last seen 2m ago · Controller");
  expect(linkWords(host({ link: "removed" }), NOW)).toBe(
    "Removed from that computer · pair again to use it"
  );
  expect(linkWords(undefined, NOW)).toBe("Connecting…");
});

test("a new session's projects say how many sessions each has open, or parked", () => {
  const summary = host({
    projects: [
      { id: "api", name: "api-server", parked: false },
      { id: "web", name: "website", parked: false },
      { id: "vid", name: "video-tools", parked: true },
      { id: "new", name: "notes", parked: false },
    ],
    sessions: [
      session({ id: "1", projectId: "api" }),
      session({ id: "2", projectId: "api" }),
      session({ id: "3", projectId: "api" }),
      session({ id: "4", projectId: "web" }),
    ],
  });
  expect(projectChoices(summary).map(({ name, note }) => [name, note])).toEqual(
    [
      ["api-server", "3 open sessions"],
      ["website", "1 open session"],
      ["video-tools", "Parked"],
      ["notes", "No open sessions"],
    ]
  );
});

test("this phone's key reads as its first twelve hex digits, in fours", () => {
  expect(shortKey("a09aa5f47a67beef00")).toBe("a09a·a5f4·7a67");
  expect(shortKey(null)).toBe("");
});

test("a dialog that isn't asking you (a menu open) doesn't make a session asking", () => {
  const menu = session({
    dialogOpen: true,
    needsYou: false,
    standing: "running",
    status: "running",
  });
  expect(kindOf(menu)).toBe("running");
});

test("a standing nobody knows reads as Unknown, never as Idle", () => {
  const unknown = session({ standing: "unknown", status: "idle" });
  expect(pillFor(unknown, NOW)).toEqual({ label: "Unknown", tone: "plain" });
});

test("roles read in words", () => {
  expect(roleWord("controller")).toBe("Controller");
  expect(roleWord("viewer")).toBe("Viewer");
  expect(roleWord(null)).toBeNull();
});
