import { type CSSProperties, useEffect, useState } from "react";
import { standingMeta } from "../commandCenter/CommandCenter.tsx";
import type { PairedHost } from "../ipc/bridge.ts";
import { useRemoteHosts } from "../state/remoteHosts.ts";
import { button, card, inputBox, sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Segmented } from "../ui/Segmented.tsx";
import type { HostSummary, SessionSummary } from "./hostSummary.ts";
import { RemoteReadable } from "./RemoteReadable.tsx";
import { RemoteTerminal } from "./RemoteTerminal.tsx";
import { linkLine } from "./remoteScreen.ts";

/**
 * Other computers: each paired computer, how its link stands, and its
 * sessions with their standing and whether they need you. Choosing one shows
 * its screen beside the list.
 */
export function RemoteView() {
  const hosts = useRemoteHosts((state) => state.hosts);
  const links = useRemoteHosts((state) => state.links);
  const [chosen, setChosen] = useState<{
    hostId: string;
    sessionId: string;
  } | null>(null);

  // A session a start made is chosen, wherever the start was asked from: it
  // shows as soon as that computer lists it.
  const started = useRemoteHosts((state) => state.started);
  useEffect(() => {
    if (started) {
      setChosen(started);
      useRemoteHosts.getState().takeStarted();
    }
  }, [started]);

  // The chosen session may have ended there, or its computer been forgotten.
  const shown =
    chosen &&
    hosts.some((host) => host.hostId === chosen.hostId) &&
    links[chosen.hostId]?.sessions.some((one) => one.id === chosen.sessionId)
      ? chosen
      : null;

  if (hosts.length === 0) {
    return (
      <div style={viewStyle}>
        <p style={emptyStyle}>
          No other computer is paired with this one. Pair one in Settings,
          Remote access, under Use another computer from here.
        </p>
      </div>
    );
  }

  return (
    <div style={viewStyle}>
      <div style={listStyle}>
        {hosts.map((host) => (
          <HostCard
            chosen={shown}
            host={host}
            key={host.hostId}
            link={links[host.hostId]}
            onChoose={(sessionId) =>
              setChosen({ hostId: host.hostId, sessionId })
            }
          />
        ))}
      </div>
      {shown ? (
        <RemoteSession
          hostId={shown.hostId}
          key={`${shown.hostId}:${shown.sessionId}`}
          sessionId={shown.sessionId}
        />
      ) : null}
    </div>
  );
}

type SessionMode = "terminal" | "readable";

const MODES = [
  { label: "Terminal", value: "terminal" },
  { label: "Readable", value: "readable" },
] as const;

/**
 * The chosen session: its terminal, or read as entries. The session stays
 * open whichever is shown; reading, its screen is off, so no terminal
 * frames cross the link (or the relay). With no entries to read, the
 * terminal shows with why.
 */
function RemoteSession({
  hostId,
  sessionId,
}: {
  hostId: string;
  sessionId: string;
}) {
  const [mode, setMode] = useState<SessionMode>("terminal");
  const summary = useRemoteHosts(
    (state) => state.readable[`${hostId}:${sessionId}`]
  );
  // Open while it is chosen, whichever is shown: switching never closes it.
  // The terminal mounts once the open is asked for, so its screen is turned
  // on after it (a child's effects run before its parent's).
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const store = useRemoteHosts.getState();
    store.open(hostId, sessionId).catch(() => undefined);
    setOpened(true);
    return () => {
      store.close(hostId, sessionId).catch(() => undefined);
    };
  }, [hostId, sessionId]);
  useEffect(() => {
    if (mode !== "readable") {
      return;
    }
    const store = useRemoteHosts.getState();
    store.readEntries(hostId, sessionId).catch(() => undefined);
    return () => {
      store.stopEntries(hostId, sessionId).catch(() => undefined);
    };
  }, [hostId, sessionId, mode]);
  const unavailable =
    mode === "readable" ? (summary?.unavailable ?? null) : null;
  const reading = mode === "readable" && unavailable === null;
  return (
    <div style={sessionStyle}>
      <div style={sessionHeadStyle}>
        <Segmented
          ariaLabel="Show the session as"
          onChange={setMode}
          options={MODES}
          value={mode}
        />
        {unavailable ? <span style={warnStyle}>{unavailable}</span> : null}
      </div>
      {reading ? (
        <RemoteReadable
          onTerminal={() => setMode("terminal")}
          summary={summary}
        />
      ) : null}
      {/* Only while shown: reading, no screen crosses the link. */}
      {reading || !opened ? null : (
        <div style={screenStyle}>
          <RemoteTerminal hostId={hostId} sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}

function HostCard({
  chosen,
  host,
  link,
  onChoose,
}: {
  chosen: { hostId: string; sessionId: string } | null;
  host: PairedHost;
  link: HostSummary | undefined;
  onChoose: (sessionId: string) => void;
}) {
  const state = link?.link ?? "connecting";
  const starting = useRemoteHosts((store) =>
    Boolean(store.starting[host.hostId])
  );
  return (
    <section aria-label={host.name} style={hostCardStyle}>
      <div style={hostHeadStyle}>
        <span style={hostNameStyle}>{link?.hostName || host.name}</span>
        <span style={state === "connected" ? hintStyle : warnStyle}>
          {linkLine(state)}
        </span>
      </div>
      {/* Kept while a start is under way, even through a lost link: it is
          sent again when the link is back, and its answer still comes. */}
      {link && (link.mayStart || starting) ? <NewSession link={link} /> : null}
      {(link?.sessions ?? []).map((session) => (
        <SessionRow
          key={session.id}
          onChoose={() => onChoose(session.id)}
          selected={
            chosen?.hostId === host.hostId && chosen.sessionId === session.id
          }
          session={session}
        />
      ))}
    </section>
  );
}

/**
 * Start a session on that computer: in one of its projects (where its
 * sessions are all parked, said so), titled as typed or after the project.
 * Once started it is chosen, and shows when that computer lists it.
 */
function NewSession({ link }: { link: HostSummary }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const starting = useRemoteHosts((state) =>
    Boolean(state.starting[link.hostId])
  );
  const startError = useRemoteHosts(
    (state) => state.startErrors[link.hostId] ?? null
  );
  // Projects in use first; parked ones after, marked.
  const projects = [...link.projects].sort(
    (a, b) => Number(a.parked) - Number(b.parked)
  );
  // A pick the computer no longer lists falls back to the first project.
  const chosenProject = projects.some((project) => project.id === projectId)
    ? projectId
    : (projects[0]?.id ?? "");
  if (!(open || starting)) {
    return (
      <div style={newSessionStyle}>
        <button
          className="kr-hover-surface"
          onClick={() => {
            useRemoteHosts.getState().clearStartError(link.hostId);
            setOpen(true);
          }}
          style={button("secondary", "sm")}
          type="button"
        >
          New session
        </button>
      </div>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        useRemoteHosts
          .getState()
          .startSession(link.hostId, chosenProject, title)
          .then((id) => {
            if (id) {
              setOpen(false);
              setTitle("");
            }
          })
          .catch(() => undefined);
      }}
      style={newSessionStyle}
    >
      <select
        aria-label="Project"
        className="kr-focusable"
        onChange={(event) => setProjectId(event.target.value)}
        style={{ ...inputBox(), color: tokens.color.ink.primary }}
        value={chosenProject}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.parked ? `${project.name} (parked)` : project.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Title"
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title (optional)"
        spellCheck={false}
        style={{ ...inputBox(), color: tokens.color.ink.primary }}
        value={title}
      />
      <div style={newSessionActionsStyle}>
        <button
          className="kr-hover-surface"
          disabled={starting}
          style={button("secondary", "sm")}
          type="submit"
        >
          {starting ? "Starting…" : "Start"}
        </button>
        {/* A start can't be called back once asked: the computer answers
            it, and the session it makes opens. */}
        <button
          className="kr-hover-surface"
          disabled={starting}
          onClick={() => setOpen(false)}
          style={button("ghost", "sm")}
          type="button"
        >
          Cancel
        </button>
      </div>
      {startError && !starting ? (
        <span role="alert" style={warnStyle}>
          {startError}
        </span>
      ) : null}
    </form>
  );
}

function SessionRow({
  onChoose,
  selected,
  session,
}: {
  onChoose: () => void;
  selected: boolean;
  session: SessionSummary;
}) {
  const meta = standingMeta(session.standing);
  return (
    <button
      aria-pressed={selected}
      className="kr-hover-surface"
      onClick={onChoose}
      style={selected ? selectedRowStyle : rowStyle}
      type="button"
    >
      <span style={{ ...dotStyle, background: meta.color }} />
      <span style={titleStyle}>{session.title}</span>
      <span style={hintStyle}>{meta.label}</span>
      {session.needsYou ? <span style={needsYouStyle}>Needs you</span> : null}
    </button>
  );
}

const newSessionStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  padding: `${tokens.space.sm} ${tokens.space.md}`,
};

const newSessionActionsStyle: CSSProperties = {
  display: "flex",
  gap: tokens.space.sm,
};

const viewStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  gap: tokens.space.lg,
  minHeight: 0,
  padding: tokens.space.xl,
};

const listStyle: CSSProperties = {
  display: "flex",
  flex: "0 0 320px",
  flexDirection: "column",
  gap: tokens.space.lg,
  overflowY: "auto",
};

const screenStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  minWidth: 0,
};

const sessionStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: tokens.space.sm,
  minWidth: 0,
};

const sessionHeadStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.md,
};

const emptyStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontSize: "13px",
  lineHeight: 1.5,
  margin: 0,
  maxWidth: "480px",
};

const hostCardStyle: CSSProperties = {
  ...card(),
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const hostHeadStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xs,
  padding: tokens.space.md,
};

const hostNameStyle: CSSProperties = {
  ...sectionLabel(),
};

const hintStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "12px",
};

const warnStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontSize: "12px",
};

const rowStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderTop: `1px solid ${tokens.color.line.soft}`,
  color: tokens.color.ink.primary,
  cursor: "pointer",
  display: "flex",
  font: "inherit",
  fontSize: "13px",
  gap: tokens.space.sm,
  padding: `${tokens.space.sm} ${tokens.space.md}`,
  textAlign: "left",
};

const selectedRowStyle: CSSProperties = {
  ...rowStyle,
  background: tokens.color.surface.active,
};

const dotStyle: CSSProperties = {
  borderRadius: "50%",
  flex: "none",
  height: "6px",
  width: "6px",
};

const titleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const needsYouStyle: CSSProperties = {
  color: tokens.color.status.waitingInk,
  fontSize: "12px",
};
