// Kriyon Companion — a read-only mod for Kriyon's own Claude Code sessions.
//
// It tells the Kriyon app on this Mac what the session does — the rows the
// conversation keeps, Claude's reply as it streams, and which rule allowed a
// tool —
// over a Unix socket the session's Kriyon daemon serves. Nothing leaves the
// Mac.
//
// What it never does: answer for a hook, change a prompt, a tool call or a
// result, approve or block anything, call a model, or read credentials. Every
// hook passes its event on unchanged and posts after `next`, without waiting
// for the post — the streaming one passes each piece on as it came, the same
// object.
//
// Two things it adds, for [Nested session]s (ADR-0049): one deferred tool,
// `start_session`, that asks Kriyon to start a session beside this one, and,
// in a session Kriyon started that way, one message back to the session that
// asked when its first turn ends. Neither changes anything the session does.

// This process's run: a restarted claude numbers its posts from 1 again, so
// readers order by (run, seq).
const run = Math.random().toString(36).slice(2, 10);
let seq = 0;
let socketPath = null;
let greeted = false;
// Whether the daemon takes partial replies (it says so on every reply): an
// older one would append each to its spool, so none is sent until it does.
let streams = false;

/** Text capped, so one huge result can't bloat the spool. */
function cap(text, max) {
  if (typeof text !== "string") {
    return;
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A row's blocks with only what the Structured view shows. */
function shrinkBlock(block) {
  if (!block || typeof block !== "object") {
    return { type: "unknown" };
  }
  switch (block.type) {
    case "text":
      return { type: "text", text: cap(block.text, 20_000) };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: cap(JSON.stringify(block.input ?? null), 2000),
      };
    case "tool_result": {
      const content = Array.isArray(block.content)
        ? block.content
            .filter((b) => b && b.type === "text")
            .map((b) => b.text)
            .join("\n")
        : block.content;
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        is_error: block.is_error === true,
        content: cap(typeof content === "string" ? content : "", 2000),
      };
    }
    default:
      // Thinking arrives without its text (the API hides it); images and
      // anything else are named, not copied.
      return { type: String(block.type) };
  }
}

function shrinkMessage(message) {
  return {
    type: message?.type,
    role: message?.role,
    name: message?.name,
    isMeta: message?.isMeta === true,
    content: Array.isArray(message?.content)
      ? message.content.map(shrinkBlock)
      : [],
  };
}

/** Send one numbered event to the app. Never rejects. */
async function send($, body) {
  try {
    if (socketPath === null) {
      socketPath = (await $.env.get("KRIYON_BRIDGE_SOCKET")) ?? "";
    }
    if (!socketPath) {
      return;
    }
    // The conversation this came from: a nested `claude -p` run in the same
    // terminal inherits the socket, and Kriyon keeps only the session's own.
    const sessionId = body.sessionId ?? (await $.session.id());
    const res = await $.http.fetch("http://kriyon/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, sessionId }),
      socketPath,
    });
    streams = Number(res?.headers?.["x-kriyon-bridge"] ?? 0) >= 2;
  } catch {
    // The app is the observer; a missed post never troubles the session.
  }
}

/** Post one event to the app; never awaited by a hook, never throws. */
function post($, event) {
  seq += 1;
  send($, { run, seq, ...event });
}

// The daemon keeps only the newest partial reply, so partials go one at a
// time — two on their way at once could land out of order, leaving an older
// snapshot in place — and while one is out, only the newest waiting is kept.
let partialOut = false;
let partialNext = null;

/** Post a partial reply, after any still on its way. */
function postPartial($, event) {
  seq += 1;
  partialNext = { run, seq, ...event };
  if (partialOut) {
    return;
  }
  partialOut = true;
  (async () => {
    while (partialNext !== null) {
      const body = partialNext;
      partialNext = null;
      // biome-ignore lint/performance/noAwaitInLoops: one post at a time, newest body wins.
      await send($, body);
    }
    partialOut = false;
  })();
}

/** Say hello, with the Claude Code version; `sessionId` names the
 *  conversation when it isn't the one `$.session.id()` reads. */
function hello($, sessionId) {
  $.session
    .version()
    .then((v) => post($, { kind: "hello", version: v?.version, sessionId }))
    .catch(() => post($, { kind: "hello", sessionId }));
}

/** Say hello once, on the first event seen. */
function greet($) {
  if (greeted) {
    return;
  }
  greeted = true;
  hello($);
}

// ---- Nested sessions (ADR-0049) ----

/** The tool's short name; Claude Code lists it as `mcp__<plugin>__<name>`. */
const START_SESSION = "start_session";

/** Prompts that are the person's own words to this session: typed at the
 *  terminal, or sent from their phone over Remote Control. */
const OWN_WORDS = new Set(["composer", "bridge"]);

/** The running turn: where the prompt that started it came from, whether
 *  that prompt asked for a session, and whether anything not in the person's
 *  own words (a peer's message, a task notification, a schedule) has been
 *  delivered into it since. */
let turn = { asked: false, mixed: false, origin: null };

/** The person's prompt has to ask for a session in so many words. */
const ASKS_FOR_SESSION = /\bsessions?\b/i;

/** Note one prompt the main loop reads. A prompt with no `turnId` starts a
 *  turn; one with a `turnId` is delivered into the running one. */
function notePrompt(e) {
  const origin = e.origin?.kind ?? null;
  if (e.turnId === undefined) {
    turn = {
      asked: OWN_WORDS.has(origin) && ASKS_FOR_SESSION.test(e.text ?? ""),
      mixed: false,
      origin,
    };
  } else if (!OWN_WORDS.has(origin)) {
    turn = { ...turn, mixed: true };
  }
}

/** Whether this turn is the person asking for a session: started by their
 *  own prompt, which names a session, with nobody else's words since. A
 *  file or tool result Claude reads can't make this true on its own. */
function personAsked() {
  return OWN_WORDS.has(turn.origin) && turn.asked && !turn.mixed;
}

const START_SESSION_SPEC = {
  name: START_SESSION,
  description:
    "Start a separate Claude Code session in Kriyon, beside this one, to do one piece of work in parallel. " +
    "The person sees it nested under this session in Kriyon's sidebar and can open and steer it like any session. " +
    "When its first task ends it sends you its result as a message. " +
    "Use initiation 'user_asked' only when the person's own message that started this turn asked you to start a session; " +
    "otherwise use 'own_initiative', and Kriyon shows the person a suggestion to start it instead. " +
    "Kriyon also checks this itself, so a session another source asked for is only ever suggested.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The whole task for the new session: it starts with no memory of this conversation.",
      },
      title: {
        type: "string",
        description: "A short name for the session in the sidebar.",
      },
      worktree: {
        type: "boolean",
        description:
          "Run it on its own git worktree and branch, so it can't overwrite files this session is changing.",
      },
      branch: {
        type: "string",
        description: "The worktree's branch name, when worktree is true.",
      },
      initiation: {
        type: "string",
        enum: ["user_asked", "own_initiative"],
      },
    },
    required: ["prompt", "title", "initiation"],
  },
};

/** The text a tool argument carries, trimmed and capped; "" when absent. */
function arg(value, max) {
  return typeof value === "string" ? (cap(value.trim(), max) ?? "") : "";
}

/** Answer one `start_session` call: hand the request to Kriyon and tell the
 *  model what happens next. Kriyon decides, not this mod: it starts the
 *  session only for the person's own words and under their cap. */
function startSession($, e) {
  const prompt = arg(e.prompt, 20_000);
  const title = arg(e.title, 80);
  if (!(prompt && title)) {
    return { result: "Not started: a session needs a prompt and a title." };
  }
  const asked =
    e.initiation === "user_asked" && e.agentId === undefined && personAsked();
  post($, {
    kind: "session_request",
    requestId: e.tool_use_id ?? `${run}-${seq + 1}`,
    initiation: asked ? "user_asked" : "own_initiative",
    prompt,
    title,
    worktree: e.worktree === true,
    branch: arg(e.branch, 120) || undefined,
  });
  return {
    result: asked
      ? `Kriyon will start "${title}" unless the person's limit on busy sessions is reached; then it shows them a suggestion to start it instead. Once it runs, it messages you its result when its first task ends; you don't need to wait for it.`
      : `Kriyon is showing the person a suggestion to start "${title}". It starts only if they choose it; don't assume it ran.`,
  };
}

/** The session that asked for this one, by Claude session id, when Kriyon
 *  started this one as a [Nested session] (`KRIYON_REPORT_TO`, beside
 *  `KRIYON_REPORT_FROM`, the conversation Kriyon started); "" otherwise. */
let reportTo = null;
let reported = false;
/** The report being sent right now, so `tool.check` can allow exactly it. */
let sending = null;

/** When this nested session's first turn ends, send its answer to the
 *  session that asked for it — once, and never from a subagent's loop. */
async function reportBack($, e, result) {
  if (reported || e.agentId !== undefined) {
    return;
  }
  reported = true;
  try {
    if (reportTo === null) {
      reportTo = (await $.env.get("KRIYON_REPORT_TO")) ?? "";
    }
    // Only the conversation Kriyon started: a `claude -p` run inside the
    // nested session inherits the same env and must not speak for it.
    const from = (await $.env.get("KRIYON_REPORT_FROM")) ?? "";
    if (!(reportTo && from)) {
      return;
    }
    if (from !== (await $.session.id())) {
      post($, { kind: "report", outcome: "skipped: another conversation" });
      return;
    }
    const answer = cap(result?.text ?? "", 4000) || "(no reply text)";
    const ending =
      e.reason === "answer" ? "finished its task" : `stopped (${e.reason})`;
    // Who started it and where it works, so the lead knows a session it
    // didn't ask for (the person's Split off) and which folder holds it.
    const pwd = cap((await $.env.get("PWD")) ?? "", 300);
    const where = pwd ? ` (working in ${pwd})` : "";
    const opening =
      (await $.env.get("KRIYON_REPORT_BY")) === "person"
        ? `The person split off a session from this one${where}. It ${ending}.`
        : `The nested session you asked for${where} ${ending}.`;
    sending = `${opening} Its reply:\n\n${answer}`;
    await $.session.send({ to: { sessionId: reportTo }, text: sending });
    post($, { kind: "report", outcome: "sent" });
  } catch (err) {
    // A report that can't be sent never troubles this session. The outcome
    // goes to the bridge spool, so a lost report can be traced there.
    post($, {
      kind: "report",
      outcome: `failed: ${cap(String(err?.message ?? err), 200)}`,
    });
  } finally {
    sending = null;
  }
}

/** This mod's own SendMessage carrying the report being sent: auto mode's
 *  classifier judges only what the model asked for and refuses a mod's
 *  send, so the report is allowed here. Nothing else is touched. */
function isOwnReport(e, next) {
  return (
    sending !== null &&
    e.tool === "SendMessage" &&
    next.origin?.plugin === "kriyon-companion" &&
    e.input?.message === sending
  );
}

/** Conversations that take over a running process: no `session.start`
 *  fires for them, only the classic hook. */
const TAKEOVERS = new Set(["resume", "clear", "fork"]);

/** The fewest milliseconds between two posts of a reply as it streams. */
const PARTIAL_MS = 250;

/**
 * The main agent's reply as it streams, posted as a snapshot of the text
 * block being written at most every {@link PARTIAL_MS}: a lost post heals at
 * the next one.
 * Read-only: every chunk is passed on unchanged, the same object, so what the
 * person sees and what is recorded are exactly what the engine sent.
 */
async function* streamReply($, e, next) {
  const stream = next(e);
  if (e.agentId !== undefined) {
    // A subagent's step: passed through, nothing read.
    return yield* stream;
  }
  // The text block being written: the view shows one, the newest.
  let block = null;
  let text = "";
  let lastPost = 0;
  let dirty = false;
  const flush = (final) => {
    if (!(dirty && streams)) {
      return;
    }
    dirty = false;
    postPartial($, {
      kind: "partial",
      turnId: e.turnId,
      step: e.index,
      block,
      text: cap(text, 20_000),
      final,
    });
  };
  try {
    for await (const chunk of stream) {
      try {
        if (chunk?.kind === "text") {
          if (chunk.index !== block) {
            block = chunk.index;
            text = "";
          }
          text += chunk.text;
          dirty = true;
          const now = performance.now();
          if (now - lastPost >= PARTIAL_MS) {
            lastPost = now;
            flush(false);
          }
        } else if (chunk?.kind === "stop") {
          flush(true);
        }
      } catch {
        // Reading is best-effort; the stream itself is never touched.
      }
      yield chunk;
    }
  } finally {
    flush(true);
  }
}

export function register(on) {
  on("turn.step", streamReply);

  on("session.start", async ($, e, next) => {
    greet($);
    try {
      // Only in a Kriyon session: elsewhere there is nobody to start it.
      if (await $.env.get("KRIYON_BRIDGE_SOCKET")) {
        await $.tool.register(START_SESSION_SPEC);
      }
    } catch {
      // No tool, no nested sessions; the session itself is untouched.
    }
    return next(e);
  });

  // Only the main loop's prompts raise `prompt.submit`; a subagent's run
  // starts from its Agent call instead.
  on("prompt.submit", (_$, e, next) => {
    notePrompt(e);
    return next(e);
  });

  // The literal name, so `claude plugin validate` can list the matcher.
  on("tool.call", { tool: "mcp__kriyon-companion__start_session" }, ($, e) =>
    startSession($, e)
  );

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    // Awaited: `$` works only inside this dispatch, so a send left running
    // after the hook returns never arrives. It resolves once queued.
    await reportBack($, e, result);
    return result;
  });

  // A resume, /clear or /branch ends the conversation, not the companion:
  // say hello for the new one, which may stay quiet until its first prompt.
  on("classic.SessionStart", ($, e, next) => {
    if (TAKEOVERS.has(e.source)) {
      hello($, e.session_id);
    }
    return next(e);
  });

  on("session.append", async ($, e, next) => {
    greet($);
    const result = await next(e);
    post($, {
      kind: "row",
      uuid: e.uuid,
      agentId: e.agentId,
      door: e.door,
      origin: e.origin?.kind,
      message: shrinkMessage(result?.message ?? e.message),
    });
    return result;
  });

  on("tool.check", async ($, e, next) => {
    if (isOwnReport(e, next)) {
      return {
        decision: "allow",
        reason: "Kriyon's report to the lead session",
      };
    }
    const result = await next(e);
    if (e.tool_use_id) {
      post($, {
        kind: "check",
        toolUseId: e.tool_use_id,
        tool: e.tool,
        decision: result?.decision,
        rule: cap(result?.rule, 300),
        reason: cap(result?.reason, 300),
      });
    }
    return result;
  });

  on("session.end", ($, e, next) => {
    post($, { kind: "end", reason: e.reason });
    return next(e);
  });
}
