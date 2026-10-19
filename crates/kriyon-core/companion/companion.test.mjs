// The companion's streaming hook, driven the way Claude Code drives it.
// Run with `node --test` (lefthook pre-push + CI).
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "./companion.js";

const handlers = new Map();
register((name, handler) => handlers.set(name, handler));
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
