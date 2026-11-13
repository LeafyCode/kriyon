/**
 * A new session on a paired computer: pick one of its projects and, if you
 * like, a title. The computer starts it and checks the request again; its
 * screen opens once it starts.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { usePhone } from "../state/phone.ts";
import { colors, ui } from "../ui.ts";

export function NewSessionScreen({ hostId }: { hostId: string }) {
  const [title, setTitle] = useState("");
  const host = usePhone((state) => state.states[hostId]);
  const error = usePhone((state) => state.newSessionError);
  const starting = usePhone((state) => state.newSessionStarting);
  const name = usePhone(
    (state) => state.hosts.find((one) => one.hostId === hostId)?.name
  );
  const { newSession, show } = usePhone.getState();
  const startable = Boolean(host?.mayStart);
  return (
    <ScrollView
      contentContainerStyle={{ gap: 12, padding: 16 }}
      style={ui.screen}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => show({ kind: "home" })}
      >
        <Text style={ui.ghostButtonText}>‹ Back</Text>
      </Pressable>
      <Text style={ui.title}>New session on {name ?? "the computer"}</Text>
      {startable ? (
        <>
          <TextInput
            accessibilityLabel="Title (optional)"
            onChangeText={setTitle}
            placeholder="Title (optional)"
            placeholderTextColor={colors.inkFaint}
            style={ui.input}
            value={title}
          />
          <Text style={ui.sectionLabel}>Projects</Text>
          {(host?.projects ?? []).map((project) => (
            <Pressable
              accessibilityLabel={`Start in ${project.name}`}
              accessibilityRole="button"
              disabled={starting}
              key={project.id}
              onPress={() => {
                newSession(hostId, project.id, title);
              }}
              style={ui.row}
            >
              <Text style={ui.rowTitle}>
                {project.parked ? `${project.name} (parked)` : project.name}
              </Text>
            </Pressable>
          ))}
        </>
      ) : (
        <Text style={ui.hint}>
          A new session starts here while this phone is connected as a
          Controller.
        </Text>
      )}
      {starting ? <Text style={ui.hint}>Starting…</Text> : null}
      {error ? (
        <Text style={[ui.hint, { color: colors.statusError }]}>{error}</Text>
      ) : null}
    </ScrollView>
  );
}
