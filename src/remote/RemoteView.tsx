import { type CSSProperties, useState } from "react";
import { standingMeta } from "../commandCenter/CommandCenter.tsx";
import type { HostLink, HostSession, PairedHost } from "../ipc/bridge.ts";
import { linkLine, useRemoteHosts } from "../state/remoteHosts.ts";
import { card, sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { RemoteTerminal } from "./RemoteTerminal.tsx";

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
        <div style={screenStyle}>
          <RemoteTerminal
            hostId={shown.hostId}
            key={`${shown.hostId}:${shown.sessionId}`}
            sessionId={shown.sessionId}
          />
        </div>
      ) : null}
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
  link: HostLink | undefined;
  onChoose: (sessionId: string) => void;
}) {
  const state = link?.state ?? "connecting";
  return (
    <section aria-label={host.name} style={hostCardStyle}>
      <div style={hostHeadStyle}>
        <span style={hostNameStyle}>{link?.name || host.name}</span>
        <span style={state === "connected" ? hintStyle : warnStyle}>
          {linkLine(state)}
        </span>
      </div>
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

function SessionRow({
  onChoose,
  selected,
  session,
}: {
  onChoose: () => void;
  selected: boolean;
  session: HostSession;
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
  minWidth: 0,
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
