/**
 * A new session on a paired computer, as a sheet over Home: pick one of its
 * projects (each says how many sessions it has open, or that it's parked)
 * and, if you like, a title. The computer starts it and checks the request
 * again; its screen opens once it starts.
 */
import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Button, IconButton, useLook } from "../kit.tsx";
import { projectChoices } from "../state/home.ts";
import { usePhone } from "../state/phone.ts";
import { fonts } from "../theme.ts";

export function NewSessionSheet({ hostId }: { hostId: string }) {
  const { t, text } = useLook();
  const [title, setTitle] = useState("");
  const summary = usePhone((state) => state.states[hostId]);
  const error = usePhone((state) => state.newSessionError);
  const starting = usePhone((state) => state.newSessionStarting);
  const name = usePhone(
    (state) =>
      state.states[hostId]?.hostName ||
      state.hosts.find((one) => one.hostId === hostId)?.name
  );
  const { newSession, show } = usePhone.getState();
  const choices = summary ? projectChoices(summary) : [];
  const [chosen, setChosen] = useState<string | null>(null);
  const picked =
    chosen ??
    choices.find((choice) => !choice.parked)?.id ??
    choices[0]?.id ??
    null;
  const close = () => show({ kind: "home" });
  const startable = Boolean(summary?.mayStart) && picked !== null;
  return (
    <Modal animationType="slide" onRequestClose={close} transparent visible>
      <View
        style={{
          backgroundColor: `${t.scrim}cc`,
          flex: 1,
          justifyContent: "flex-end",
        }}
      >
        <Pressable
          accessibilityLabel="Close"
          onPress={close}
          style={{ flex: 1 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: t.card,
            borderColor: t.lineStrong,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderTopWidth: 1,
            maxHeight: "85%",
          }}
        >
          <ScrollView
            contentContainerStyle={{
              gap: 18,
              paddingBottom: 34,
              paddingHorizontal: 20,
              paddingTop: 8,
            }}
          >
            <View
              style={{
                alignSelf: "center",
                backgroundColor: t.grabber,
                borderRadius: 3,
                height: 5,
                width: 36,
              }}
            />
            <View style={{ alignItems: "center", flexDirection: "row" }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text accessibilityRole="header" style={text.h2}>
                  New session
                </Text>
                <Text style={[text.caption, { color: t.ink2 }]}>
                  {`on ${name ?? "the computer"}`}
                </Text>
              </View>
              <IconButton icon="close" label="Close" onPress={close} plain />
            </View>
            {summary?.mayStart ? (
              <>
                <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
                  <Text style={text.label}>Project</Text>
                  {choices.map((choice) => {
                    const on = choice.id === picked;
                    return (
                      <Pressable
                        accessibilityLabel={`${choice.name}, ${choice.note}`}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        key={choice.id}
                        onPress={() => setChosen(choice.id)}
                        style={{
                          alignItems: "center",
                          backgroundColor: on ? t.accentWash : t.bg,
                          borderColor: on ? t.accentBright : t.line,
                          borderRadius: 12,
                          borderWidth: on ? 1.5 : 1,
                          flexDirection: "row",
                          gap: 12,
                          minHeight: 52,
                          paddingHorizontal: 14,
                          paddingVertical: 8,
                        }}
                      >
                        <View
                          style={{
                            alignItems: "center",
                            borderColor: on ? t.accentBright : t.lineStrong,
                            borderRadius: 10,
                            borderWidth: 2,
                            height: 20,
                            justifyContent: "center",
                            width: 20,
                          }}
                        >
                          {on ? (
                            <View
                              style={{
                                backgroundColor: t.accentBright,
                                borderRadius: 5,
                                height: 10,
                                width: 10,
                              }}
                            />
                          ) : null}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text
                            style={[text.body, { color: on ? t.ink : t.ink1 }]}
                          >
                            {choice.name}
                          </Text>
                          <Text style={text.small}>{choice.note}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={{ gap: 6 }}>
                  <Text style={text.label}>Title · optional</Text>
                  <TextInput
                    accessibilityLabel="Title, optional"
                    onChangeText={setTitle}
                    placeholder="Named after the project if left empty"
                    placeholderTextColor={t.muted}
                    style={{
                      backgroundColor: t.bg,
                      borderColor: t.lineStrong,
                      borderRadius: 12,
                      borderWidth: 1,
                      color: t.ink,
                      fontFamily: fonts.regular,
                      fontSize: 15,
                      minHeight: 48,
                      paddingHorizontal: 14,
                    }}
                    value={title}
                  />
                </View>
                <Text style={[text.caption, { color: t.ink2 }]}>
                  Claude starts in the project folder on the computer. Worktree
                  setup stays on the computer.
                </Text>
                {error ? (
                  <Text style={[text.body, { color: t.red }]}>{error}</Text>
                ) : null}
                <Button
                  disabled={!startable || starting}
                  label={starting ? "Starting…" : "Start session"}
                  onPress={() => {
                    if (picked) {
                      newSession(hostId, picked, title);
                    }
                  }}
                  wide
                />
              </>
            ) : (
              <Text style={text.bodyMuted}>
                A new session starts here while this phone is connected as a
                Controller.
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
