/**
 * The app lock: nothing of any session shows until the phone says it is
 * its owner (Face ID, Touch ID, the fingerprint, or its passcode). It asks
 * at once; Unlock asks again. A phone with no passcode can't be asked:
 * that is said plainly, and the person goes on (the app can't enforce what
 * the phone doesn't have).
 */
import { useEffect } from "react";
import { Text, View } from "react-native";
import { Button, useLook } from "../kit.tsx";
import { usePhone } from "../state/phone.ts";

/** Why the phone didn't unlock, in words; `null` with nothing to say. */
function problemWords(problem: string | null): string | null {
  if (!problem || problem === "noPasscode") {
    return null;
  }
  return `The phone couldn't check it (${problem}). Try again.`;
}

/** A plain cover with the app's name: the lock's, and the app switcher's. */
export function Cover({ children }: { children?: React.ReactNode }) {
  const { t, text } = useLook();
  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: t.bg,
        flex: 1,
        gap: 16,
        justifyContent: "center",
        padding: 32,
      }}
    >
      <Text accessibilityRole="header" style={text.h1}>
        Kriyon
      </Text>
      {children}
    </View>
  );
}

export function LockScreen() {
  const { t, text } = useLook();
  const problem = usePhone((state) => state.lockProblem);
  const { continueUnlocked, unlock } = usePhone.getState();
  // Asked at once: the person opened the app to use it.
  useEffect(() => {
    usePhone
      .getState()
      .unlock()
      .catch(() => undefined);
  }, []);
  if (problem === "noPasscode") {
    return (
      <Cover>
        <Text style={[text.body, { textAlign: "center" }]}>
          This phone has no passcode, Face ID or fingerprint set up, so Kriyon
          can't lock itself. Set one up in the phone's settings: then a lost
          phone can't reach your computers' sessions.
        </Text>
        <Button kind="primary" label="Continue" onPress={continueUnlocked} />
      </Cover>
    );
  }
  const words = problemWords(problem);
  return (
    <Cover>
      <Text style={[text.title, { textAlign: "center" }]}>
        Kriyon is locked
      </Text>
      {words ? (
        <Text style={[text.body, { color: t.red, textAlign: "center" }]}>
          {words}
        </Text>
      ) : null}
      <Button
        kind="primary"
        label={words ? "Try again" : "Unlock"}
        onPress={() => {
          unlock().catch(() => undefined);
        }}
      />
    </Cover>
  );
}
