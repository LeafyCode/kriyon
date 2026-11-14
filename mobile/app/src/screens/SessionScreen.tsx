/**
 * A session on a paired computer, in one of the plan's two views: the
 * readable view (Claude's messages at phone width; it doesn't touch the
 * terminal's size), shown first, and the real terminal. A session with no
 * entries to read shows its terminal, saying why; Readable tries again.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { readableKey, usePhone } from "../state/phone.ts";
import { colors, ui } from "../ui.ts";
import { ReadableView } from "./ReadableView.tsx";
import { TerminalView } from "./TerminalView.tsx";

type View_ = "readable" | "terminal";

function Tab({
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{
        borderBottomColor: on ? colors.accentBright : "transparent",
        borderBottomWidth: 2,
        paddingVertical: 6,
      }}
    >
      <Text style={on ? ui.rowTitle : ui.hint}>{label}</Text>
    </Pressable>
  );
}

export function SessionScreen({
  hostId,
  sessionId,
}: {
  hostId: string;
  sessionId: string;
}) {
  const [view, setView] = useState<View_>("readable");
  const session = usePhone((state) =>
    state.states[hostId]?.sessions.find((one) => one.id === sessionId)
  );
  // Why there are no entries: the terminal shows instead.
  const unavailable = usePhone(
    (state) => state.readable[readableKey(hostId, sessionId)]?.unavailable
  );
  const readable = view === "readable" && !unavailable;
  const { retryReadable, show } = usePhone.getState();
  // Open while shown, read first, whichever view: switching turns its
  // screen on and off (the terminal's), never closing it.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
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
  return (
    <View style={[ui.screen, { gap: 12, padding: 16 }]}>
      <Pressable
        accessibilityRole="button"
        onPress={() => show({ kind: "home" })}
      >
        <Text style={ui.ghostButtonText}>‹ Back</Text>
      </Pressable>
      <Text numberOfLines={1} style={ui.title}>
        {session?.title ?? "Session"}
      </Text>
      <View style={{ flexDirection: "row", gap: 18 }}>
        <Tab
          label="Readable"
          on={readable}
          onPress={() => {
            retryReadable(hostId, sessionId);
            setView("readable");
          }}
        />
        <Tab
          label="Terminal"
          on={!readable}
          onPress={() => setView("terminal")}
        />
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
            <Text style={ui.hint}>{unavailable}</Text>
          ) : null}
          <TerminalView hostId={hostId} sessionId={sessionId} />
        </>
      )}
    </View>
  );
}
