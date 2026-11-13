/**
 * A session on a paired computer, in one of the plan's two views: the
 * readable view (Claude's messages at phone width; it doesn't touch the
 * terminal's size) and the real terminal.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePhone } from "../state/phone.ts";
import { colors, ui } from "../ui.ts";
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
  const { show } = usePhone.getState();
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
          on={view === "readable"}
          onPress={() => setView("readable")}
        />
        <Tab
          label="Terminal"
          on={view === "terminal"}
          onPress={() => setView("terminal")}
        />
      </View>
      {view === "terminal" ? (
        <TerminalView hostId={hostId} sessionId={sessionId} />
      ) : (
        <Text style={ui.hint}>
          The readable view, Claude's messages at phone width, comes in a later
          step. Use Terminal to watch and type for now.
        </Text>
      )}
    </View>
  );
}
