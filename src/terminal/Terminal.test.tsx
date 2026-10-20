import { render, waitFor } from "@testing-library/react";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  openExternalUrl,
  openPath,
  resizePty,
  revealPath,
  writeStdin,
} from "../ipc/bridge.ts";
import { attachTerminal, ensureSession } from "./sessionHost.ts";
import { Terminal } from "./Terminal.tsx";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const onDataHolder = vi.hoisted(() => ({
  current: undefined as ((data: string) => void) | undefined,
}));

const ctorOptionsHolder = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));

const wheelHolder = vi.hoisted(() => ({
  current: undefined as ((event: unknown) => boolean) | undefined,
}));

const keyHolder = vi.hoisted(() => ({
  current: undefined as ((event: KeyboardEvent) => boolean) | undefined,
}));

interface FakeTerm {
  blur: ReturnType<typeof vi.fn>;
  buffer: { active: { type: string } };
  focus: ReturnType<typeof vi.fn>;
  modes: {
    applicationCursorKeysMode: boolean;
    bracketedPasteMode: boolean;
    mouseTrackingMode: string;
  };
  scrollLines: ReturnType<typeof vi.fn>;
}

const termHolder = vi.hoisted(() => ({
  current: undefined as FakeTerm | undefined,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    parser = {
      registerOscHandler: vi.fn(),
    };
    buffer = { active: { type: "normal" } };
    // `bracketedPasteMode` is load-bearing, not padding: it is the whole
    // discriminator `readsArrowsAsScroll` runs on (ADR-0024). Without it on
    // the double the predicate reads `undefined` and the alt-screen wheel
    // tests below would pass for the wrong reason.
    modes = {
      applicationCursorKeysMode: false,
      bracketedPasteMode: false,
      mouseTrackingMode: "none",
    };
    focus = vi.fn();
    blur = vi.fn();
    textarea: HTMLTextAreaElement | undefined = undefined;
    loadAddon = vi.fn();
    open = vi.fn();
    registerLinkProvider = vi.fn();
    scrollLines = vi.fn();
    write = vi.fn();
    resize = vi.fn();
    dispose = vi.fn();
    attachCustomWheelEventHandler = vi.fn((cb: (event: unknown) => boolean) => {
      wheelHolder.current = cb;
    });
    attachCustomKeyEventHandler = vi.fn(
      (cb: (event: KeyboardEvent) => boolean) => {
        keyHolder.current = cb;
      }
    );
    onData = vi.fn((cb: (data: string) => void) => {
      onDataHolder.current = cb;
      return { dispose: vi.fn() };
    });
    constructor(options?: Record<string, unknown>) {
      ctorOptionsHolder.current = options;
      termHolder.current = this as unknown as FakeTerm;
    }
  },
}));

const fitHolder = vi.hoisted(() => ({
  current: undefined as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    constructor() {
      fitHolder.current = this.fit;
    }
  },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {},
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(),
}));

const contextLossHolder = vi.hoisted(() => ({
  current: undefined as (() => void) | undefined,
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss = vi.fn((cb: () => void) => {
      contextLossHolder.current = cb;
    });
    dispose = vi.fn();
  },
}));

vi.mock("../ipc/bridge", () => ({
  openExternalUrl: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve()),
  revealPath: vi.fn(() => Promise.resolve()),
  writeStdin: vi.fn(),
  resizePty: vi.fn(),
  reportDrained: vi.fn(),
}));

const detach = vi.hoisted(() => vi.fn());
const sizeSyncHolder = vi.hoisted(() => ({
  current: undefined as (() => void) | undefined,
}));
vi.mock("./sessionHost.ts", () => ({
  ensureSession: vi.fn(),
  attachTerminal: vi.fn(() => detach),
  disposeSession: vi.fn(),
  registerSizeSync: vi.fn((_id: string, sync: () => void) => {
    sizeSyncHolder.current = sync;
    return () => {
      sizeSyncHolder.current = undefined;
    };
  }),
}));

const mockedEnsureSession = vi.mocked(ensureSession);
const mockedAttachTerminal = vi.mocked(attachTerminal);
const mockedWriteStdin = vi.mocked(writeStdin);
const mockedResizePty = vi.mocked(resizePty);

// jsdom does no layout, so every element measures 0x0 — which is exactly the
// "hidden pane" state the size-sync guard refuses to fit. Drive the measured box
// explicitly so a test says which one it means.
const box = { height: 300, width: 600 };

beforeAll(() => {
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => (prop === "clientWidth" ? box.width : box.height),
    });
  }
});

beforeEach(() => {
  onDataHolder.current = undefined;
  ctorOptionsHolder.current = undefined;
  contextLossHolder.current = undefined;
  sizeSyncHolder.current = undefined;
  fitHolder.current = undefined;
  wheelHolder.current = undefined;
  keyHolder.current = undefined;
  termHolder.current = undefined;
  box.height = 300;
  box.width = 600;
  vi.clearAllMocks();
  mockedEnsureSession.mockResolvedValue(undefined);
  mockedWriteStdin.mockResolvedValue(undefined);
  mockedResizePty.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

test("ensures and attaches the session once on mount with the provided id and cwd", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(mockedEnsureSession).toHaveBeenCalledTimes(1);
  });
  expect(mockedEnsureSession.mock.calls[0]?.[0]).toBe("sess-uuid");
  expect(mockedEnsureSession.mock.calls[0]?.[1]).toBe("/work");
  expect(mockedAttachTerminal).toHaveBeenCalledWith(
    "sess-uuid",
    expect.any(Function)
  );
});

test("writes UTF-8 encoded stdin (keyed on the session id prop) when the user types", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(mockedAttachTerminal).toHaveBeenCalledTimes(1);
  });
  onDataHolder.current?.("ls");

  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "sess-uuid",
    new TextEncoder().encode("ls")
  );
});

test("detaches (does NOT tear down the pty) on unmount", async () => {
  const { unmount } = render(<Terminal cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(mockedAttachTerminal).toHaveBeenCalledTimes(1);
  });

  unmount();

  expect(detach).toHaveBeenCalledTimes(1);
});

test("creates the xterm with a 5000-line scrollback", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(mockedAttachTerminal).toHaveBeenCalledTimes(1);
  });

  expect(ctorOptionsHolder.current?.scrollback).toBe(5000);
});

// Regression: xterm's `shouldForceSelection` is unconditionally false on macOS
// unless this option is on, so once a TUI enabled mouse tracking there was no
// gesture left that made a *terminal* selection — ⌘C had nothing to copy and a
// clicked path never reached the link provider (ADR-0024).
test("leaves Option+click as the way out of an app that grabbed the mouse", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(mockedAttachTerminal).toHaveBeenCalledTimes(1);
  });

  expect(ctorOptionsHolder.current?.macOptionClickForcesSelection).toBe(true);
});

// Regression: the PTY was born at the hardcoded 80x24 default and the only
// size push came from a ResizeObserver that raced (and lost to) the async
// session creation — leaving the PTY stuck at 80x24 while xterm rendered far
// wider, garbling Claude's TUI. The size must be pushed once the session is
// ready, independent of the observer.
// The terminal registers its size pusher with sessionHost, which invokes it
// whenever the pty is (re)created — including a revive after a failed
// creation, which the old ensureSession().then(sync) chaining missed.
test("registers a size sync that pushes the terminal geometry to the PTY", async () => {
  render(<Terminal active cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(sizeSyncHolder.current).toBeDefined();
  });
  sizeSyncHolder.current?.();
  expect(mockedResizePty).toHaveBeenCalledWith("sess-uuid", 80, 24);
});

// Regression: switching projects with the dock open yanked keyboard focus into
// the dock terminal — activation called focus() unconditionally. With scoped
// focus, activation only steals focus when focus is already inside the
// terminal workspace (e.g. the user clicked a tab), never from the sidebar.
test("scoped focus: activation steals focus only from inside the scope", async () => {
  const scope = document.createElement("div");
  scope.setAttribute("data-terminal-focus-scope", "");
  document.body.appendChild(scope);
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  const inside = document.createElement("button");
  scope.appendChild(inside);
  // React owns its own mount node; `inside` stays a sibling within the scope
  // (like the tab strip next to the pane grid).
  const mount = document.createElement("div");
  scope.appendChild(mount);

  try {
    outside.focus();
    const { rerender } = render(
      <Terminal active={false} cwd="/work" scopedFocus sessionId="sess-uuid" />,
      { container: mount }
    );
    await waitFor(() => {
      expect(termHolder.current).toBeDefined();
    });

    // Activated while focus sits outside the scope (sidebar click): no steal.
    rerender(<Terminal active cwd="/work" scopedFocus sessionId="sess-uuid" />);
    expect(termHolder.current?.focus).not.toHaveBeenCalled();

    // Activated while focus is inside the scope (tab click): focus moves in.
    inside.focus();
    rerender(
      <Terminal active={false} cwd="/work" scopedFocus sessionId="sess-uuid" />
    );
    rerender(<Terminal active cwd="/work" scopedFocus sessionId="sess-uuid" />);
    expect(termHolder.current?.focus).toHaveBeenCalledTimes(1);
  } finally {
    scope.remove();
    outside.remove();
  }
});

// Without scoped focus (the Claude session pane), activation always focuses —
// the existing behavior, unchanged.
test("unscoped focus: activation focuses regardless of where focus was", async () => {
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  try {
    outside.focus();
    const { rerender } = render(
      <Terminal active={false} cwd="/work" sessionId="sess-uuid" />
    );
    await waitFor(() => {
      expect(termHolder.current).toBeDefined();
    });
    rerender(<Terminal active cwd="/work" sessionId="sess-uuid" />);
    expect(termHolder.current?.focus).toHaveBeenCalledTimes(1);
  } finally {
    outside.remove();
  }
});

// A terminal hidden while it holds focus (the Structured view's dialog
// detour ending) would otherwise keep taking keys nobody can see.
test("hiding a terminal that has focus lets go of it", async () => {
  const { rerender } = render(<Terminal active cwd="/work" sessionId="s" />);
  await waitFor(() => {
    expect(termHolder.current).toBeDefined();
  });
  const term = termHolder.current as FakeTerm & {
    textarea: HTMLTextAreaElement | undefined;
  };
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  term.textarea = textarea;
  try {
    textarea.focus();
    rerender(<Terminal active={false} cwd="/work" sessionId="s" />);
    expect(term.blur).toHaveBeenCalledTimes(1);

    // Focus elsewhere is left where it is.
    rerender(<Terminal active cwd="/work" sessionId="s" />);
    textarea.blur();
    rerender(<Terminal active={false} cwd="/work" sessionId="s" />);
    expect(term.blur).toHaveBeenCalledTimes(1);
  } finally {
    textarea.remove();
  }
});

// Regression: the wheel was dead inside alt-screen apps that don't grab the
// mouse (less, man, git log): the custom handler called scrollLines — a no-op
// in the alternate buffer, which has no scrollback — and returning false
// suppressed xterm's default handling too. The terminal convention (iTerm,
// Terminal.app) is arrow keys per line-step there.
test("wheel in an alt-screen app without mouse tracking sends arrow keys", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);
  await waitFor(() => {
    expect(wheelHolder.current).toBeDefined();
  });
  const term = termHolder.current;
  if (!term) {
    throw new Error("fake terminal not constructed");
  }

  term.buffer.active.type = "alternate";
  mockedWriteStdin.mockClear();
  // One coarse mouse notch down (line mode ⇒ 3 line-steps).
  const handled = wheelHolder.current?.({ deltaMode: 1, deltaY: 1 });
  expect(handled).toBe(false);
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "sess-uuid",
    new TextEncoder().encode("\x1b[B\x1b[B\x1b[B")
  );
  expect(term.scrollLines).not.toHaveBeenCalled();

  // Application cursor keys (DECCKM) switch the report to SS3 form, upward.
  term.modes.applicationCursorKeysMode = true;
  mockedWriteStdin.mockClear();
  wheelHolder.current?.({ deltaMode: 1, deltaY: -1 });
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "sess-uuid",
    new TextEncoder().encode("\x1bOA\x1bOA\x1bOA")
  );

  // Back in the normal buffer the same notch scrolls the scrollback.
  term.buffer.active.type = "normal";
  wheelHolder.current?.({ deltaMode: 1, deltaY: 1 });
  expect(term.scrollLines).toHaveBeenCalledWith(3);
});

// Regression for ADR-0024 defect (2), through the real wheel handler rather
// than the predicate alone: an alternate-screen app with bracketed paste on
// has an input line, so the arrows this would otherwise send are what the app
// reads as history navigation — a wheel notch would walk away the user's
// half-written prompt. The trade the ADR argues for is a dead wheel instead.
test("wheel in an alt-screen app with bracketed paste on sends nothing", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);
  await waitFor(() => {
    expect(wheelHolder.current).toBeDefined();
  });
  const term = termHolder.current;
  if (!term) {
    throw new Error("fake terminal not constructed");
  }

  // Claude Code's fullscreen renderer under CLAUDE_CODE_DISABLE_MOUSE=1:
  // alternate screen, no mouse capture, a prompt at the bottom.
  term.buffer.active.type = "alternate";
  term.modes.bracketedPasteMode = true;
  term.modes.mouseTrackingMode = "none";
  mockedWriteStdin.mockClear();
  term.scrollLines.mockClear();

  const handled = wheelHolder.current?.({ deltaMode: 1, deltaY: 1 });

  expect(handled).toBe(false);
  expect(mockedWriteStdin).not.toHaveBeenCalled();
  expect(term.scrollLines).not.toHaveBeenCalled();

  // Turning it back off restores the pager behaviour on the same terminal —
  // so the discriminator is what decided, not the buffer type alone.
  term.modes.bracketedPasteMode = false;
  wheelHolder.current?.({ deltaMode: 1, deltaY: 1 });
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "sess-uuid",
    new TextEncoder().encode("\x1b[B\x1b[B\x1b[B")
  );
});

// Regression: Shift+Enter submitted the prompt instead of opening a newline —
// xterm sends a bare \r for Enter with or without Shift, so Claude's CLI never
// saw the ESC CR that `/terminal-setup` installs in VS Code, iTerm2 and friends.
// The terminal must send that sequence itself.
test("shift+enter sends ESC CR (the newline sequence) instead of a submit", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);
  await waitFor(() => {
    expect(keyHolder.current).toBeDefined();
  });
  const preventDefault = vi.fn();
  const event = {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "Enter",
    metaKey: false,
    preventDefault,
    shiftKey: true,
    type: "keydown",
  } as unknown as KeyboardEvent;

  expect(keyHolder.current?.(event)).toBe(false);
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "sess-uuid",
    new TextEncoder().encode("\x1b\r")
  );
});

// Plain Enter stays xterm's own submit: the handler must not claim it.
test("plain enter is left to xterm (submits)", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);
  await waitFor(() => {
    expect(keyHolder.current).toBeDefined();
  });
  mockedWriteStdin.mockClear();
  const event = {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "Enter",
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    type: "keydown",
  } as unknown as KeyboardEvent;

  expect(keyHolder.current?.(event)).toBe(true);
  expect(mockedWriteStdin).not.toHaveBeenCalled();
});

// Regression: switching sessions hides a pane (display:none), which fires its
// ResizeObserver with a 0x0 box. The pinned FitAddon does NOT decline an
// unmeasurable container — it reads `height: auto`, coerces the NaN to 0, and
// clamps to its 2x1 floor. Fitting there resized the pty to 2 columns, which
// SIGWINCH-ed the running child (Claude, vim, a dev server) into dying and
// shredded the scrollback on reflow. A terminal with no box must not be fit at
// all; activation re-syncs the real geometry.
test("does not fit or push a PTY size while the pane is hidden", async () => {
  render(<Terminal active cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(sizeSyncHolder.current).toBeDefined();
  });
  mockedResizePty.mockClear();
  fitHolder.current?.mockClear();

  // The pane just got `display: none`: it measures nothing.
  box.height = 0;
  box.width = 0;
  sizeSyncHolder.current?.();

  expect(fitHolder.current).not.toHaveBeenCalled();
  expect(mockedResizePty).not.toHaveBeenCalled();
});

// A backgrounded session mounts hidden (display:none), so its initial fit
// measures nothing. When it becomes the active pane it finally has a real box,
// so the size must be re-synced to the PTY on activation.
test("re-syncs the PTY size when the terminal becomes active", async () => {
  const { rerender } = render(
    <Terminal active={false} cwd="/work" sessionId="sess-uuid" />
  );

  await waitFor(() => {
    expect(mockedEnsureSession).toHaveBeenCalledTimes(1);
  });
  mockedResizePty.mockClear();

  rerender(<Terminal active cwd="/work" sessionId="sess-uuid" />);

  await waitFor(() => {
    expect(mockedResizePty).toHaveBeenCalledWith("sess-uuid", 80, 24);
  });
});

// A fullscreen `claude` tracks the mouse, and xterm still activates links on
// mouseup. The user's plain click must open the link anyway: that is the
// gesture they use, and `claude` itself does nothing with a click on a link.
test("a plain click opens a link even while an app tracks the mouse", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);
  await waitFor(() => {
    expect(mockedAttachTerminal).toHaveBeenCalledTimes(1);
  });
  const term = termHolder.current as unknown as {
    buffer: { active: { getLine: (n: number) => unknown } };
    modes: { mouseTrackingMode: string };
    registerLinkProvider: ReturnType<typeof vi.fn>;
  };
  term.modes.mouseTrackingMode = "any";

  const onWebLink = vi.mocked(WebLinksAddon).mock.calls[0]?.[0] as (
    event: MouseEvent,
    uri: string
  ) => void;
  onWebLink(new MouseEvent("click"), "https://example.com");
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");

  term.buffer.active.getLine = () => ({
    translateToString: () => "see src/main.ts",
  });
  const provider = term.registerLinkProvider.mock.calls[0]?.[0] as {
    provideLinks: (
      line: number,
      cb: (links?: { activate: (e: MouseEvent) => void }[]) => void
    ) => void;
  };
  let links: { activate: (e: MouseEvent) => void }[] = [];
  provider.provideLinks(1, (found) => {
    links = found ?? [];
  });
  expect(links.length).toBeGreaterThan(0);
  links[0]?.activate(new MouseEvent("click"));
  expect(openPath).toHaveBeenLastCalledWith("/work", "src/main.ts");
  links[0]?.activate(new MouseEvent("click", { metaKey: true }));
  expect(revealPath).toHaveBeenLastCalledWith("/work", "src/main.ts");
});

// Claude Code detects xterm.js (it answers XTVERSION) and hands its links to
// the terminal as OSC 8 hyperlinks, which xterm opens through `linkHandler` —
// by default a `confirm()` + `window.open` that does nothing in the webview.
test("an OSC 8 hyperlink opens through Kriyon", async () => {
  render(<Terminal cwd="/work" sessionId="sess-uuid" />);
  await waitFor(() => {
    expect(mockedAttachTerminal).toHaveBeenCalledTimes(1);
  });
  const handler = ctorOptionsHolder.current?.linkHandler as {
    activate: (event: MouseEvent, uri: string) => void;
    allowNonHttpProtocols?: boolean;
  };
  expect(handler.allowNonHttpProtocols).toBe(true);
  handler.activate(new MouseEvent("click"), "https://example.com");
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");

  handler.activate(new MouseEvent("click"), "file:///work/src/a.ts");
  expect(openPath).toHaveBeenLastCalledWith("/work", "/work/src/a.ts");
  handler.activate(new MouseEvent("click"), "javascript:alert(1)");
  expect(openPath).toHaveBeenCalledTimes(1);
  expect(openExternalUrl).toHaveBeenCalledTimes(1);
});
