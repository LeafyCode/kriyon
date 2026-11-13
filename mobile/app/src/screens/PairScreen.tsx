/**
 * Pairing with a computer: scan the QR code it shows (Remote access, Pair a
 * device), or paste its pairing code (Copy pairing code), then type the six
 * digits shown here into it.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { usePhone } from "../state/phone.ts";
import { colors, ui } from "../ui.ts";
import { Scanner } from "./Scanner.tsx";

export function PairScreen() {
  const [text, setText] = useState("");
  const [scanning, setScanning] = useState(false);
  const pairing = usePhone((state) => state.pairing);
  const { cancelPairing, pair, show } = usePhone.getState();
  // A new pairing only while none runs: a second would cancel the first.
  const canStart = pairing.phase === "idle" || pairing.phase === "failed";
  const leave = () => {
    cancelPairing().catch(() => undefined);
    show({ kind: "home" });
  };
  return (
    <View style={[ui.screen, { gap: 14, padding: 16 }]}>
      <Text style={ui.title}>Pair a computer</Text>
      <Text style={ui.hint}>
        On the computer, open Remote access and Pair a device. Scan the QR code
        it shows, or Copy pairing code there and paste it here.
      </Text>
      {canStart ? (
        <>
          {scanning ? (
            <>
              <Scanner
                onCode={(code) => {
                  setScanning(false);
                  pair(code).catch(() => undefined);
                }}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => setScanning(false)}
                style={ui.ghostButton}
              >
                <Text style={ui.ghostButtonText}>Stop scanning</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setScanning(true)}
              style={ui.button}
            >
              <Text style={ui.buttonText}>Scan the QR code</Text>
            </Pressable>
          )}
          <TextInput
            accessibilityLabel="Pairing code from the computer"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setText}
            placeholderTextColor={colors.inkFaint}
            style={[ui.input, { fontFamily: "Menlo" }]}
            value={text}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              pair(text).catch(() => undefined);
            }}
            style={ui.ghostButton}
          >
            <Text style={ui.ghostButtonText}>Connect</Text>
          </Pressable>
        </>
      ) : null}
      {pairing.phase === "working" ? (
        <Text style={ui.hint}>Connecting…</Text>
      ) : null}
      {pairing.phase === "code" ? (
        <View style={{ gap: 6 }}>
          <Text style={ui.hint}>Type this code on the computer:</Text>
          <Text
            style={{
              color: colors.inkBright,
              fontFamily: "Menlo",
              fontSize: 32,
              letterSpacing: 6,
            }}
          >
            {pairing.code}
          </Text>
        </View>
      ) : null}
      {pairing.phase === "paired" ? (
        <Text style={ui.hint}>Paired with {pairing.name}.</Text>
      ) : null}
      {pairing.phase === "failed" ? (
        <Text style={[ui.hint, { color: colors.statusError }]}>
          {pairing.reason}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={leave}
        style={ui.ghostButton}
      >
        <Text style={ui.ghostButtonText}>
          {pairing.phase === "paired" ? "Done" : "Cancel"}
        </Text>
      </Pressable>
    </View>
  );
}
