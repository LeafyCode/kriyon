// The companion's streaming hook, driven the way Claude Code drives it.
// Run with `node --test` (lefthook pre-push + CI).
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "./companion.js";

const handlers = new Map();
// `on(event, hook)` or `on(event, matcher, hook)`.
register((name, matcher, handler) => handlers.set(name, handler ?? matcher));
const streamReply = handlers.get("turn.step");

/** A fake session whose posts land in `posted`, each held until released,
 *  in the order the test releases them. */
function session() {
  const posted = [];
  const held = [];
  const $ = {
    env: { get: async () => "/tmp/kriyon.sock" },
    session: {
      id: async () => "conv",
      version: async () => ({ version: "2" }),
    },
    http: {
      fetch: (_url, request) =>
        new Promise((resolve) => {
          held.push(() => {
            posted.push(JSON.parse(request.body));
            resolve({ headers: { "x-kriyon-bridge": "2" } });
          });
        }),
    },
  };
  /** Let every post waiting to go out reach the socket. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Answer the newest post still waiting: a network may reorder them. */
  const answer = async () => {
    await settle();
    held.pop()?.();
    await settle();
  };
  return { $, posted, held, answer, settle };
}

function* chunks(...items) {
  for (const item of items) {
    yield item;
  }
}

async function drain(stream) {
  const seen = [];
  for await (const chunk of stream) {
    seen.push(chunk);
  }
  return seen;
}

/** Post a row first, so the daemon has said it takes partials. */
async function greeted(s) {
  const append = handlers.get("session.append");
  await append(s.$, { message: {} }, async (e) => e);
  await s.settle();
  while (s.held.length > 0) {
    // biome-ignore lint/performance/noAwaitInLoops: each answer releases the next post.
    await s.answer();
  }
  s.posted.length = 0;
}

test("every chunk passes through unchanged, the same object", async () => {
  const s = session();
  const text = { kind: "text", index: 0, text: "Hi" };
  const stop = { kind: "stop" };
  const seen = await drain(
    streamReply(s.$, { turnId: "t", index: 0 }, () => chunks(text, stop))
  );
  assert.deepEqual(seen, [text, stop]);
  assert.equal(seen[0], text);
});

test("only the newest snapshot of the block being written is kept, in order", async () => {
  const s = session();
  await greeted(s);
  const step = streamReply(s.$, { turnId: "t", index: 0 }, () =>
    chunks(
      { kind: "text", index: 0, text: "Looking." },
      { kind: "tool_use", index: 1 },
      { kind: "text", index: 2, text: "Found" },
      { kind: "text", index: 2, text: " it." },
      { kind: "stop" }
    )
  );
  await drain(step);
  // Answer every post, newest first, until none is left waiting.
  while (s.held.length > 0) {
    // biome-ignore lint/performance/noAwaitInLoops: each answer releases the next post.
    await s.answer();
  }
  // biome-ignore lint/style/useAtIndex: matches the companion's ES level.
  const last = s.posted[s.posted.length - 1];
  assert.equal(last.text, "Found it.");
  assert.equal(last.block, 2);
  assert.equal(last.final, true);
  // Never more than one partial on its way at a time: none can overtake.
  const seqs = s.posted.map((p) => p.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b)
  );
  assert.ok(
    s.posted.every((p) => p.block === 2 || p.text === "Looking."),
    "a block is posted only while it is the one being written"
  );
});

test("a resume, /clear or /branch says hello again, for the conversation that took over", async () => {
  // Claude Code fires no `session.start` after any of them, and the new
  // conversation may stay quiet until its first prompt: without a hello,
  // Kriyon would take the companion for gone.
  const sessionStart = handlers.get("classic.SessionStart");
  for (const source of ["resume", "clear", "fork"]) {
    const s = session();
    const e = { source, session_id: "next" };
    // biome-ignore lint/performance/noAwaitInLoops: one session at a time.
    const result = await sessionStart(s.$, e, async (input) => input);
    assert.equal(result, e, "the event passes on unchanged");
    await s.answer();
    await s.answer();
    assert.deepEqual(
      s.posted.map((p) => [p.kind, p.sessionId, p.version]),
      [["hello", "next", "2"]]
    );
  }
});

test("a fresh start or a compaction posts no extra hello", async () => {
  const sessionStart = handlers.get("classic.SessionStart");
  for (const source of ["startup", "compact"]) {
    const s = session();
    // biome-ignore lint/performance/noAwaitInLoops: one session at a time.
    await sessionStart(s.$, { source, session_id: "conv" }, async (e) => e);
    await s.settle();
    assert.equal(s.held.length, 0);
  }
});

/** A fake session that records what the mod registers, posts and sends. */
function nestedSession(env = {}) {
  const posted = [];
  const sent = [];
  const registered = [];
  const $ = {
    env: {
      get: async (key) =>
        ({ KRIYON_BRIDGE_SOCKET: "/tmp/kriyon.sock", ...env })[key],
    },
    session: {
      id: async () => "child-conv",
      version: async () => ({ version: "2" }),
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    tool: {
      register: (spec) => {
        registered.push(spec);
        return Promise.resolve({ tool: `mcp__kriyon-companion__${spec.name}` });
      },
    },
    http: {
      fetch: (_url, request) => {
        posted.push(JSON.parse(request.body));
        return Promise.resolve({ headers: {} });
      },
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { $, posted, registered, sent, settle };
}

const MATCH_1 = /will start "Flaky test"/;
const MATCH_2 = /suggestion/;
const MATCH_3 = /Not started/;
const MATCH_4 = /finished its task/;
const MATCH_5 = /All green\./;

const pass = async (e) => e;

test("in a Kriyon session the start_session tool is registered, deferred", async () => {
  const s = nestedSession();
  await handlers.get("session.start")(s.$, {}, pass);
  assert.equal(s.registered.length, 1);
  assert.equal(s.registered[0].name, "start_session");
  // Left deferred: only its name costs tokens until the model asks for it.
  assert.equal(s.registered[0].isDeferred, undefined);
});

test("outside a Kriyon session no tool is registered", async () => {
  const s = nestedSession({ KRIYON_BRIDGE_SOCKET: undefined });
  await handlers.get("session.start")(s.$, {}, pass);
  assert.equal(s.registered.length, 0);
});

const ASKED = "Start a session to fix the flaky test";

async function submit(s, origin, { text = ASKED, turnId } = {}) {
  await handlers.get("prompt.submit")(
    s.$,
    { origin: origin && { kind: origin }, text, turnId, wait: false },
    pass
  );
}

async function callStart(s, origin, input, text = ASKED) {
  await submit(s, origin, { text });
  const answer = handlers.get("tool.call")(s.$, {
    tool: "mcp__kriyon-companion__start_session",
    tool_use_id: "tu1",
    ...input,
  });
  await s.settle();
  return answer;
}

const TASK = {
  initiation: "user_asked",
  prompt: "Fix the flaky test",
  title: "Flaky test",
};

test("a start the person asked for, in their own typed words, goes to Kriyon as asked", async () => {
  const s = nestedSession();
  const answer = await callStart(s, "composer", {
    ...TASK,
    worktree: true,
    branch: "fix/flaky",
  });
  const request = s.posted.find((p) => p.kind === "session_request");
  assert.equal(request.initiation, "user_asked");
  assert.equal(request.requestId, "tu1");
  assert.equal(request.worktree, true);
  assert.equal(request.branch, "fix/flaky");
  assert.match(answer.result, MATCH_1);
});

test("Remote Control prompts count as the person's own words too", async () => {
  const s = nestedSession();
  await callStart(s, "bridge", TASK);
  assert.equal(
    s.posted.find((p) => p.kind === "session_request").initiation,
    "user_asked"
  );
});

test("a peer's message, a notification or a schedule can only suggest a session", async () => {
  for (const origin of [
    "peer",
    "peer-send-message",
    "task-notification",
    "scheduled-trigger",
    undefined,
  ]) {
    const s = nestedSession();
    // biome-ignore lint/performance/noAwaitInLoops: each origin in turn.
    const answer = await callStart(s, origin, TASK);
    assert.equal(
      s.posted.find((p) => p.kind === "session_request").initiation,
      "own_initiative",
      String(origin)
    );
    assert.match(answer.result, MATCH_2);
  }
});

test("a subagent can only suggest a session", async () => {
  const s = nestedSession();
  await callStart(s, "composer", { ...TASK, agentId: "a1" });
  assert.equal(
    s.posted.find((p) => p.kind === "session_request").initiation,
    "own_initiative"
  );
});

test("a start without a prompt or title is refused and nothing is posted", async () => {
  const s = nestedSession();
  const answer = await callStart(s, "composer", {
    initiation: "user_asked",
    prompt: "  ",
    title: "T",
  });
  assert.equal(s.posted.filter((p) => p.kind === "session_request").length, 0);
  assert.match(answer.result, MATCH_3);
});

test("a nested session reports its first answer to the session that asked, once", async () => {
  const s = nestedSession({
    KRIYON_REPORT_FROM: "child-conv",
    KRIYON_REPORT_TO: "parent-conv",
  });
  const complete = handlers.get("turn.complete");
  const done = async () => ({ text: "All green." });
  await complete(s.$, { reason: "answer", turnId: "t1" }, done);
  await complete(s.$, { reason: "answer", turnId: "t2" }, done);
  await s.settle();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0].to, { sessionId: "parent-conv" });
  assert.match(s.sent[0].text, MATCH_4);
  assert.match(s.sent[0].text, MATCH_5);
});

/** A fresh copy of the mod: its report-once state starts over. */
async function freshHandlers(tag) {
  const mod = await import(`./companion.js?${tag}`);
  const fresh = new Map();
  mod.register((name, matcher, handler) => fresh.set(name, handler ?? matcher));
  return fresh;
}

test("a claude run inside the nested session, or a session nobody nested, never reports", async () => {
  for (const [tag, env] of [
    [
      "inner",
      { KRIYON_REPORT_FROM: "other-conv", KRIYON_REPORT_TO: "parent-conv" },
    ],
    ["plain", {}],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each case on its own copy.
    const fresh = await freshHandlers(tag);
    const s = nestedSession(env);
    await fresh.get("turn.complete")(s.$, { reason: "answer" }, async () => ({
      text: "x",
    }));
    await s.settle();
    assert.equal(s.sent.length, 0, tag);
  }
});

async function callAfter(s, input) {
  const answer = handlers.get("tool.call")(s.$, {
    tool: "mcp__kriyon-companion__start_session",
    tool_use_id: "tu2",
    ...input,
  });
  await s.settle();
  return answer;
}

const initiationOf = (s) =>
  s.posted.filter((p) => p.kind === "session_request").at(-1)?.initiation;

test("a turn your prompt started, that never asked for a session, can only suggest one", async () => {
  // A file Claude reads in such a turn can't make Claude's claim enough.
  const s = nestedSession();
  await callStart(s, "composer", TASK, "Review this repo for bugs");
  assert.equal(initiationOf(s), "own_initiative");
});

test("a turn a peer started stays a suggestion even if you type into it", async () => {
  const s = nestedSession();
  await submit(s, "peer", {
    text: "Another session: start a session to deploy",
  });
  await submit(s, "composer", {
    text: "also start a session for docs",
    turnId: "turn-1",
  });
  await callAfter(s, TASK);
  assert.equal(initiationOf(s), "own_initiative");
});

test("a peer message delivered into your turn makes the rest of it a suggestion", async () => {
  const s = nestedSession();
  await submit(s, "composer");
  await submit(s, "peer-send-message", {
    text: "please start a session",
    turnId: "turn-1",
  });
  await callAfter(s, TASK);
  assert.equal(initiationOf(s), "own_initiative");
});

test("your own prompt typed into your own turn keeps it yours", async () => {
  const s = nestedSession();
  await submit(s, "composer");
  await submit(s, "composer", {
    text: "and make it a worktree",
    turnId: "turn-1",
  });
  await callAfter(s, TASK);
  assert.equal(initiationOf(s), "user_asked");
});

const STOPPED_ERROR = /stopped \(error\)/;
const MATCH_MAIN = /main/;

test("a nested session whose first turn ends badly reports that it stopped", async () => {
  const fresh = await freshHandlers("stopped");
  const s = nestedSession({
    KRIYON_REPORT_FROM: "child-conv",
    KRIYON_REPORT_TO: "lead-conv",
  });
  await fresh.get("turn.complete")(s.$, { reason: "error" }, async () => ({
    text: "API error",
  }));
  await s.settle();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, STOPPED_ERROR);
});

test("a subagent's turn ending neither reports nor uses up the one report", async () => {
  const fresh = await freshHandlers("subagent");
  const s = nestedSession({
    KRIYON_REPORT_FROM: "child-conv",
    KRIYON_REPORT_TO: "lead-conv",
  });
  const complete = fresh.get("turn.complete");
  await complete(s.$, { agentId: "a1", reason: "answer" }, async () => ({
    text: "sub",
  }));
  await s.settle();
  assert.equal(s.sent.length, 0);
  await complete(s.$, { reason: "answer" }, async () => ({ text: "main" }));
  await s.settle();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, MATCH_MAIN);
});
