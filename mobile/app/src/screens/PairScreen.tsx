/**
 * Pairing with a computer: scan the QR code it shows (Remote access, Pair a
 * device), or paste its pairing code (Copy pairing code), then type the six
 * digits shown here into it.
 */
import { useEffect, useState } from "react";
import { BackHandler, ScrollView, Text, TextInput, View } from "react-native";
import { Button, Icon, TopBar, useLook, useNow } from "../kit.tsx";
import { roleWord } from "../state/home.ts";
import { type Pairing, usePhone } from "../state/phone.ts";
import { fonts } from "../theme.ts";
import { Scanner } from "./Scanner.tsx";

/** "4:12": time left on the code. */
function left(expiresAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The two steps, the second lit once the phone shows its code. */
function Steps({ second }: { second: boolean }) {
  const { t, text } = useLook();
  const steps = ["1 · Scan the code", "2 · Confirm on the computer"];
  return (
    <View
      accessibilityLabel={second ? "Step 2 of 2" : "Step 1 of 2"}
      accessible
      style={{
        flexDirection: "row",
        gap: 8,
        marginHorizontal: 24,
        marginTop: 8,
      }}
    >
      {steps.map((label, index) => {
        const lit = index === 0 || second;
        const current = second ? index === 1 : index === 0;
        return (
          <View key={label} style={{ flex: 1, gap: 6 }}>
            <View
              style={{
                backgroundColor: lit ? t.accentBright : t.overlay,
                borderRadius: 2,
                height: 3,
              }}
            />
            <Text
              style={[
                text.small,
                current ? { color: t.ink, fontFamily: fonts.medium } : null,
              ]}
            >
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** The six digits, in two threes, read out one by one. */
function Digits({ code }: { code: string }) {
  const { t } = useLook();
  const digits = code.split("");
  return (
    <View
      accessibilityLabel={`Pairing code ${digits.join(" ")}`}
      accessible
      style={{ alignItems: "center", flexDirection: "row", gap: 8 }}
    >
      {digits.map((digit, index) => (
        <View
          // The same digit can come twice: its place tells them apart.
          // biome-ignore lint/suspicious/noArrayIndexKey: digits never move
          key={index}
          style={{
            alignItems: "center",
            backgroundColor: t.card,
            borderColor: t.lineStrong,
            borderRadius: 10,
            borderWidth: 1,
            justifyContent: "center",
            marginLeft: index === 3 ? 8 : 0,
            minHeight: 60,
            width: 44,
          }}
        >
          <Text style={{ color: t.ink, fontFamily: fonts.mono, fontSize: 30 }}>
            {digit}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ScanStep({
  failed,
  scanning,
  setScanning,
  setText,
  text,
}: {
  failed: string | null;
  scanning: boolean;
  setScanning: (on: boolean) => void;
  setText: (text: string) => void;
  text: string;
}) {
  const { t, text: look } = useLook();
  const { pair } = usePhone.getState();
  return (
    <>
      <View style={{ alignItems: "center", gap: 8 }}>
        <Text
          accessibilityRole="header"
          style={[
            look.h2,
            { fontSize: 24, lineHeight: 30, textAlign: "center" },
          ]}
        >
          Scan the code on your computer
        </Text>
        <Text
          style={[
            look.bodyMuted,
            { fontSize: 15, lineHeight: 22, textAlign: "center" },
          ]}
        >
          On the computer, open Settings › Remote access › Pair a device. Scan
          the QR code it shows, or copy the pairing code there and paste it
          here.
        </Text>
      </View>
      {scanning ? (
        <View style={{ alignSelf: "stretch", gap: 10 }}>
          <Scanner
            onCode={(code) => {
              setScanning(false);
              pair(code).catch(() => undefined);
            }}
          />
          <Button
            kind="ghost"
            label="Stop scanning"
            onPress={() => setScanning(false)}
            wide
          />
        </View>
      ) : (
        <Button
          label="Scan the QR code"
          onPress={() => setScanning(true)}
          wide
        />
      )}
      <View style={{ alignSelf: "stretch", gap: 8 }}>
        <TextInput
          accessibilityLabel="Pairing code from the computer"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setText}
          placeholder="Or paste the pairing code"
          placeholderTextColor={t.muted}
          style={{
            backgroundColor: t.card,
            borderColor: t.lineStrong,
            borderRadius: 12,
            borderWidth: 1,
            color: t.ink,
            fontFamily: fonts.mono,
            fontSize: 14,
            minHeight: 48,
            paddingHorizontal: 14,
          }}
          value={text}
        />
        <Button
          kind="ghost"
          label="Connect"
          onPress={() => {
            pair(text).catch(() => undefined);
          }}
          wide
        />
      </View>
      {failed ? (
        <Text style={[look.body, { color: t.red, textAlign: "center" }]}>
          {failed}
        </Text>
      ) : null}
    </>
  );
}

function CodeStep({
  pairing,
}: {
  pairing: Extract<Pairing, { phase: "code" }>;
}) {
  const { t, text: look } = useLook();
  const now = useNow(1000);
  return (
    <>
      <View style={{ alignItems: "center", gap: 8 }}>
        <Text
          accessibilityRole="header"
          style={[
            look.h2,
            { fontSize: 24, lineHeight: 30, textAlign: "center" },
          ]}
        >
          Type this code on the computer
        </Text>
        <Text
          style={[
            look.bodyMuted,
            { fontSize: 15, lineHeight: 22, textAlign: "center" },
          ]}
        >
          The computer asks for it under Settings › Remote access. It proves
          this phone is the one you scanned with.
        </Text>
      </View>
      <Digits code={pairing.code} />
      {pairing.role || pairing.expiresAtMs ? (
        <View
          style={{
            alignSelf: "stretch",
            backgroundColor: t.card,
            borderColor: t.line,
            borderRadius: 12,
            borderWidth: 1,
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          {pairing.role ? (
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
              }}
            >
              <Text style={[look.bodyMuted, { fontSize: 14 }]}>
                Role on this computer
              </Text>
              <Text style={[look.body, { color: t.ink, fontSize: 14 }]}>
                {roleWord(pairing.role)}
              </Text>
            </View>
          ) : null}
          {pairing.expiresAtMs ? (
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
              }}
            >
              <Text style={[look.bodyMuted, { fontSize: 14 }]}>
                Code expires in
              </Text>
              <Text
                style={{
                  color: t.ink,
                  fontFamily: fonts.mono,
                  fontSize: 14,
                }}
              >
                {left(pairing.expiresAtMs, now)}
              </Text>
            </View>
          ) : null}
          {pairing.role === "controller" ? (
            <Text style={look.caption}>
              A Controller can do anything you can in a terminal there. The
              computer chose this role, not the phone.
            </Text>
          ) : null}
        </View>
      ) : null}
      <Text style={look.bodyMuted}>Waiting for the computer…</Text>
    </>
  );
}

export function PairScreen() {
  const { t, text: look } = useLook();
  const [text, setText] = useState("");
  const [scanning, setScanning] = useState(false);
  // While the camera is open, Android's Back closes it (it is heard before
  // the app's own Back, which would leave pairing).
  useEffect(() => {
    if (!scanning) {
      return;
    }
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setScanning(false);
      return true;
    });
    return () => back.remove();
  }, [scanning]);
  const pairing = usePhone((state) => state.pairing);
  const { back } = usePhone.getState();
  // A new pairing only while none runs: a second would cancel the first.
  const canStart = pairing.phase === "idle" || pairing.phase === "failed";
  const second = pairing.phase === "code" || pairing.phase === "paired";
  const tile = (
    <View
      style={{
        alignItems: "center",
        backgroundColor: t.card,
        borderColor: t.line,
        borderRadius: 20,
        borderWidth: 1,
        height: 72,
        justifyContent: "center",
        width: 72,
      }}
    >
      <Icon color={t.accentBright} name={second ? "check" : "scan"} size={32} />
    </View>
  );
  return (
    <View style={{ backgroundColor: t.bg, flex: 1 }}>
      <View style={{ paddingHorizontal: 8, paddingTop: 4 }}>
        <TopBar
          back={back}
          backLabel="Close"
          closeIcon
          title="Pair a computer"
        />
      </View>
      <Steps second={second} />
      <ScrollView
        contentContainerStyle={{
          alignItems: "center",
          gap: 24,
          paddingBottom: 24,
          paddingHorizontal: 24,
          paddingTop: 32,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {tile}
        {canStart ? (
          <ScanStep
            failed={pairing.phase === "failed" ? pairing.reason : null}
            scanning={scanning}
            setScanning={setScanning}
            setText={setText}
            text={text}
          />
        ) : null}
        {pairing.phase === "working" ? (
          <Text style={look.bodyMuted}>Connecting…</Text>
        ) : null}
        {pairing.phase === "code" ? <CodeStep pairing={pairing} /> : null}
        {pairing.phase === "paired" ? (
          <Text
            accessibilityRole="header"
            style={[look.h2, { textAlign: "center" }]}
          >
            {`Paired with ${pairing.name}.`}
          </Text>
        ) : null}
      </ScrollView>
      <View
        style={{ paddingBottom: 24, paddingHorizontal: 24, paddingTop: 12 }}
      >
        <Button
          kind={pairing.phase === "paired" ? "primary" : "ghost"}
          label={pairing.phase === "paired" ? "Done" : "Cancel"}
          onPress={back}
          wide
        />
      </View>
    </View>
  );
}
