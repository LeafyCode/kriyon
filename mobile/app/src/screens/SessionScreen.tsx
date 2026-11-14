/**
 * A session on a paired computer, in one of the plan's two views: the
 * readable view (Claude's messages at phone width; it doesn't touch the
 * terminal's size), shown first, and the real terminal. A session with no
 * entries to read shows its terminal, saying why; Readable tries again.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { Text, View } from "react-native";
import type { SessionSummary } from "../../../../src/remote/hostSummary.ts";
import { Pill, Segmented, TopBar, useLook } from "../kit.tsx";
import { kindOf, type Tone } from "../state/home.ts";
import { readableKey, usePhone } from "../state/phone.ts";
import { ReadableView } from "./ReadableView.tsx";
import { TerminalView } from "./TerminalView.tsx";

type View_ = "readable" | "terminal";

/** The header's word for a session, as the design shows it. */
const HEADER_WORDS: Record<
  ReturnType<typeof kindOf>,
  { label: string; tone: Tone }
> = {
  asking: { label: "Asking", tone: "amber" },
  idle: { label: "Idle", tone: "plain" },
  running: { label: "Running", tone: "blue" },
  yourTurn: { label: "Your turn", tone: "green" },
};

/** The header's pill: in the terminal while this phone types, that. */
function headerWord(
  session: SessionSummary | undefined,
  inTerminal: boolean
): { label: string; tone: Tone } | null {
  if (!session) {
    return null;
  }
  if (inTerminal && session.mayType) {
    return { label: "You're typing", tone: "green" };
  }
  return HEADER_WORDS[kindOf(session)];
}

export function SessionScreen({
  hostId,
  sessionId,
  initialView = "readable",
}: {
  hostId: string;
  initialView?: View_;
  sessionId: string;
}) {
  const { t, text } = useLook();
  const [view, setView] = useState<View_>(initialView);
  const session = usePhone((state) =>
    state.states[hostId]?.sessions.find((one) => one.id === sessionId)
  );
  const place = usePhone((state) => {
    const summary = state.states[hostId];
    const name =
      summary?.hostName || state.hosts.find((h) => h.hostId === hostId)?.name;
    const project = summary?.projects.find(
      (p) => p.id === session?.projectId
    )?.name;
    return [name, project].filter(Boolean).join(" · ");
  });
  // Why there are no entries: the terminal shows instead.
  const unavailable = usePhone(
    (state) => state.readable[readableKey(hostId, sessionId)]?.unavailable
  );
  const readable = view === "readable" && !unavailable;
  const { retryReadable, show } = usePhone.getState();
  // Open while shown, read first, whichever view: switching turns its
  // screen on and off (the terminal's), never closing it. A layout effect,
  // so the open is asked before a terminal shown first asks for its screen
  // (a child's effects run before its parent's; layout effects before all).
  const [note, setNote] = useState<string | null>(null);
  useLayoutEffect(() => {
    const { closeReadable, openReadable } = usePhone.getState();
    openReadable(hostId, sessionId).catch((error: unknown) =>
      setNote(error instanceof Error ? error.message : String(error))
    );
    return () => {
      closeReadable(hostId, sessionId).catch(() => undefined);
    };
  }, [hostId, sessionId]);
  // Leaving the session forgets why it had no entries: back, it reads afresh.
  useEffect(
    () => () => usePhone.getState().forgetReadable(hostId, sessionId),
    [hostId, sessionId]
  );
  const word = headerWord(session, !readable);
  return (
    <View style={{ backgroundColor: t.bg, flex: 1 }}>
      <View
        style={{
          backgroundColor: t.rail,
          borderBottomColor: t.overlay,
          borderBottomWidth: 1,
          gap: 10,
          paddingBottom: 10,
          paddingHorizontal: 8,
          paddingTop: 4,
        }}
      >
        <TopBar
          back={() => show({ kind: "home" })}
          right={
            word ? <Pill label={word.label} tone={word.tone} /> : undefined
          }
          subtitle={place || undefined}
          title={session?.title ?? "Session"}
        />
        <View style={{ paddingHorizontal: 8 }}>
          <Segmented
            label="View"
            onChange={(next) => {
              if (next === "readable") {
                retryReadable(hostId, sessionId);
              }
              setView(next);
            }}
            options={[
              { label: "Readable", value: "readable" },
              { label: "Terminal", value: "terminal" },
            ]}
            value={readable ? "readable" : "terminal"}
          />
        </View>
      </View>
      {readable ? (
        <ReadableView
          hostId={hostId}
          note={note}
          onAnswer={() => setView("terminal")}
          sessionId={sessionId}
        />
      ) : (
        <>
          {view === "readable" && unavailable ? (
            <Text style={[text.caption, { color: t.ink2, padding: 16 }]}>
              {unavailable}
            </Text>
          ) : null}
          <TerminalView hostId={hostId} sessionId={sessionId} />
        </>
      )}
    </View>
  );
}
