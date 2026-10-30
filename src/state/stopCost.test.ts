import { describe, expect, it } from "vitest";
import type { BackgroundShell, SessionActivity } from "../types.ts";
import type { UiSession } from "./sessions.ts";
import {
  freedMemoryNote,
  hasStopCost,
  NO_STOP_COST,
  packCommands,
  stopCostFor,
  stopCostOfAll,
  unpackCommands,
} from "./stopCost.ts";

function session(id: string, over: Partial<UiSession> = {}): UiSession {
  return {
    archivedAt: null,
    status: "idle",
    id,
    ...over,
  } as UiSession;
}

function shell(
  cmd: string,
  status: BackgroundShell["status"]
): BackgroundShell {
  return { bashId: cmd, cmd, exit: null, lastPolledAt: null, status };
}

function activity(shells: BackgroundShell[]): SessionActivity {
  return { shells } as SessionActivity;
}

const NOTHING = { activity: {}, bootPhase: {}, exited: {} };

describe("stopCostFor", () => {
  it("costs nothing for a quiet session, so it closes without a dialog", () => {
    const cost = stopCostFor(session("s"), NOTHING);
    expect(cost).toEqual(NO_STOP_COST);
    expect(hasStopCost(cost)).toBe(false);
  });

  it("costs a turn when Claude is mid-task", () => {
    const cost = stopCostFor(session("s", { status: "running" }), NOTHING);
    expect(cost.engagement).toBe("running");
    expect(hasStopCost(cost)).toBe(true);
  });

  it("costs something while claude is still starting up", () => {
    // Nothing has fired a hook yet, so the status is still idle — but a session
    // mid-boot is doing work the user can see, and quitting ends it.
    const cost = stopCostFor(session("s"), {
      ...NOTHING,
      bootPhase: { s: "booting" },
    });
    expect(cost.engagement).toBe("starting");
    expect(hasStopCost(cost)).toBe(true);
  });

  it("costs something while its pty is still opening, before claude is typed", () => {
    const cost = stopCostFor(session("s"), {
      ...NOTHING,
      bootPhase: { s: "launching" },
    });
    expect(cost.engagement).toBe("starting");
  });

  it("a booted session is not still starting", () => {
    for (const phase of ["idle", "live", "resumeFailed"] as const) {
      const cost = stopCostFor(session("s"), {
        ...NOTHING,
        bootPhase: { s: phase },
      });
      expect(cost.engagement, phase).not.toBe("starting");
    }
  });

  it("does not count a session waiting on the user as mid-task", () => {
    // Blocked on the user: stopping it destroys nothing that resume won't bring
    // back, and asking would nag on most closes.
    const cost = stopCostFor(session("s", { status: "waiting" }), NOTHING);
    expect(cost.engagement).not.toBe("running");
  });

  it("does not trust a frozen running status once claude has exited", () => {
    // A killed claude fires no Stop hook, so its status stays `running`.
    const cost = stopCostFor(session("s", { status: "running" }), {
      activity: {},
      bootPhase: {},
      exited: { s: true },
    });
    expect(cost).toEqual(NO_STOP_COST);
  });

  it("names the background commands still running, and only those", () => {
    const cost = stopCostFor(session("s"), {
      activity: {
        s: activity([
          shell("pnpm dev", "running"),
          shell("cargo build", "exited"),
          shell("cargo watch", "running"),
          shell("sleep 9", "killed"),
        ]),
      },
      bootPhase: {},
      exited: {},
    });
    expect(cost.commands).toEqual(["pnpm dev", "cargo watch"]);
    expect(hasStopCost(cost)).toBe(true);
  });

  it("forgets background commands once claude has exited", () => {
    // They were claude's children; the tracker just never heard them end.
    const cost = stopCostFor(session("s"), {
      activity: { s: activity([shell("pnpm dev", "running")]) },
      bootPhase: {},
      exited: { s: true },
    });
    expect(cost).toEqual(NO_STOP_COST);
  });

  it("costs nothing for a session that is not there", () => {
    expect(stopCostFor(undefined, NOTHING)).toEqual(NO_STOP_COST);
  });
});

describe("stopCostOfAll", () => {
  it("adds up every live session and skips archived ones", () => {
    const view = {
      activity: {
        a: activity([shell("pnpm dev", "running")]),
        gone: activity([shell("old server", "running")]),
      },
      bootPhase: {},
      exited: {},
      sessions: {
        a: session("a", { status: "running" }),
        b: session("b", { status: "running" }),
        c: session("c"),
        gone: session("gone", { archivedAt: 1, status: "running" }),
      },
    };
    expect(stopCostOfAll(view)).toEqual({
      commands: ["pnpm dev"],
      starting: 0,
      working: 2,
    });
  });

  it("is empty when nothing is running anywhere", () => {
    const total = stopCostOfAll({
      activity: {},
      bootPhase: {},
      exited: {},
      sessions: { a: session("a"), b: session("b", { status: "done" }) },
    });
    expect(total).toEqual({ commands: [], starting: 0, working: 0 });
  });
});

describe("freedMemoryNote", () => {
  it("says what stopping a session gave back", () => {
    expect(freedMemoryNote("Closed", 612)).toBe("Closed — freed about 612 MB");
    expect(freedMemoryNote("Archived", 1843)).toBe(
      "Archived — freed about 1.8 GB"
    );
  });

  // A shell at its prompt, or a session never sampled: nothing worth a toast.
  // Closing should stay quiet unless it actually gave something back.
  it("stays silent when there was nothing worth mentioning", () => {
    expect(freedMemoryNote("Closed", undefined)).toBeNull();
    expect(freedMemoryNote("Closed", 0)).toBeNull();
    expect(freedMemoryNote("Closed", 40)).toBeNull();
  });
});

describe("sessionEngagement", () => {
  // The two booleans this replaces were sourced independently, so nothing but
  // one store action remembering to do two things kept them apart. When they
  // both read true the quit dialog said "Claude is still working in 1 session.
  // 1 session still starting up." about the same session, and counted it twice.
  it("is one answer, so a session is never both working and starting", () => {
    const cost = stopCostFor(session("a", { status: "running" }), {
      activity: {},
      bootPhase: { a: "booting" },
      exited: {},
    });
    expect(cost.engagement).toBe("running");
  });

  it("is starting while claude is launching and no hook has fired", () => {
    const cost = stopCostFor(session("a", { status: "idle" }), {
      activity: {},
      bootPhase: { a: "booting" },
      exited: {},
    });
    expect(cost.engagement).toBe("starting");
  });

  // A killed claude fires no closing hook, so `running` is a frozen claim
  // about a process that is already gone.
  it("is quiet once the session's processes have died", () => {
    const cost = stopCostFor(session("a", { status: "running" }), {
      activity: {},
      bootPhase: { a: "booting" },
      exited: { a: true },
    });
    expect(cost.engagement).toBe("quiet");
    expect(cost).toEqual(NO_STOP_COST);
  });

  it("counts each session once in the whole-app total", () => {
    const total = stopCostOfAll({
      activity: {},
      bootPhase: { a: "booting", b: "booting" },
      exited: {},
      sessions: {
        a: session("a", { status: "running" }),
        b: session("b", { status: "idle" }),
      },
    });
    expect(total).toEqual({ commands: [], starting: 1, working: 1 });
  });
});

describe("packCommands / unpackCommands", () => {
  // A selector must return a primitive or the row re-renders on every
  // unrelated store update, so the command list travels as one string. The
  // regression: joining on a newline shredded the multi-line commands Claude
  // Code backgrounds all the time — a heredoc or a chain split across lines
  // came back as several bogus entries, and the dialog counted each as its
  // own running command.
  it("survives a command with newlines in it", () => {
    const commands = ["cat <<'EOF' > notes.md\nhello\nEOF", "pnpm dev"];
    expect(unpackCommands(packCommands(commands))).toEqual(commands);
  });

  it("round-trips the ordinary cases", () => {
    expect(unpackCommands(packCommands([]))).toEqual([]);
    expect(unpackCommands(packCommands(["pnpm dev"]))).toEqual(["pnpm dev"]);
  });
});
