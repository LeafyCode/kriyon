import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLayout } from "../state/layout.ts";
import { useRemoteHosts } from "../state/remoteHosts.ts";
import { button } from "../theme/recipes.ts";
import { terminalTheme } from "../theme/terminalTheme.ts";
import { themeById } from "../theme/themes/index.ts";
import { tokens } from "../theme/tokens.ts";
import {
  answerKeys,
  applyScreenFrame,
  decodeScreenFrame,
  linkLine,
  noteLine,
  typedLastLine,
} from "./remoteScreen.ts";

/**
 * A paired computer's session, drawn from its stream. A Controller types
 * straight in, with no control to take (ADR-0063); a Viewer only watches.
 * It dims with typing off while the link is lost, and says when someone
 * else typed last. Its size is the other computer's: it never resizes there.
 */
export function RemoteTerminal({
  hostId,
  sessionId,
}: {
  hostId: string;
  sessionId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const link = useRemoteHosts((state) => state.links[hostId]);
  const session = link?.sessions.find((one) => one.id === sessionId);
  const mayType = Boolean(session?.mayType);
  // Free typing is off while Claude asks: its choices answer it instead.
  const asking = mayType && Boolean(session?.dialogOpen);
  const typing = mayType && !asking;
  const lost = link?.link === "lost";
  const error = useRemoteHosts((state) => state.error);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const term = new XTerm({
      convertEol: false,
      disableStdin: true,
      fontFamily: tokens.font.mono,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 1000,
      theme: terminalTheme(themeById(useLayout.getState().layout.themeId)),
    });
    termRef.current = term;
    term.open(container);
    const store = useRemoteHosts.getState();
    const typed = term.onData((data) => {
      store.type(hostId, sessionId, data).catch(() => undefined);
    });
    let closed = false;
    // The store sends this session's open and close to Rust in turn, so the
    // close below never overtakes it.
    store
      .showScreen(hostId, sessionId, (raw) => {
        const frame = decodeScreenFrame(raw);
        if (!frame || closed) {
          return;
        }
        const said = applyScreenFrame(term, frame);
        if (said) {
          setNote(noteLine(said));
        }
      })
      .catch(() => undefined);
    return () => {
      closed = true;
      typed.dispose();
      termRef.current = null;
      term.dispose();
      // The session stays open (its view owns that): only its screen stops.
      useRemoteHosts
        .getState()
        .hideScreen(hostId, sessionId)
        .catch(() => undefined);
    };
  }, [hostId, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.disableStdin = !typing;
    }
  }, [typing]);

  const themeId = useLayout((state) => state.layout.themeId);
  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = terminalTheme(themeById(themeId));
    }
  }, [themeId]);

  const controller = link?.role === "controller";
  return (
    <div style={wrapStyle}>
      <div style={barStyle}>
        <span style={titleStyle}>{session?.title ?? ""}</span>
        {link && link.link !== "connected" ? (
          <span style={warnStyle}>{linkLine(link.link)}</span>
        ) : null}
        {link && !controller ? (
          <span style={hintStyle}>This computer may only watch there.</span>
        ) : null}
        {mayType && session?.typing && session.typing !== "you" ? (
          <span style={hintStyle}>{typedLastLine(session.typing)}</span>
        ) : null}
      </div>
      {asking ? (
        <div style={answerStyle}>
          <span style={titleStyle}>
            {session?.question?.text ?? "Claude asks."}
          </span>
          {answerKeys(session?.question).map((choice) => (
            <button
              className="kr-hover-surface"
              key={choice.label}
              onClick={() => {
                useRemoteHosts
                  .getState()
                  .type(hostId, sessionId, choice.key)
                  .catch(() => undefined);
              }}
              style={button("secondary", "sm")}
              type="button"
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        data-testid="remote-screen"
        ref={containerRef}
        style={{ ...screenStyle, opacity: lost ? 0.4 : 1 }}
      />
      {note ? <span style={hintStyle}>{note}</span> : null}
      {error ? (
        <span role="alert" style={warnStyle}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: tokens.space.sm,
  minWidth: 0,
};

const barStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.md,
  minHeight: "28px",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  flex: 1,
  fontSize: "13px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const answerStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.sm,
};

const hintStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "12px",
};

const warnStyle: CSSProperties = {
  color: tokens.color.status.waitingInk,
  fontSize: "12px",
};

const screenStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  transition: `opacity ${tokens.motion.hover}`,
};
