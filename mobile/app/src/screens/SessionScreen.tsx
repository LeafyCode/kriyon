/** A session on a paired computer. Its terminal view comes next. */
import { Pressable, Text, View } from "react-native";
import { usePhone } from "../state/phone.ts";
import { ui } from "../ui.ts";

export function SessionScreen({
  hostId,
  sessionId,
}: {
  hostId: string;
  sessionId: string;
}) {
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
      <Text style={ui.title}>{session?.title ?? "Session"}</Text>
    </View>
  );
}
