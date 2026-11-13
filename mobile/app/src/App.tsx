/**
 * The phone app: starts Kriyon's Rust library once, keeps what it says
 * about each paired computer, dials again when the app comes to the front,
 * and shows the screen the store names.
 */
import { modelName, deviceName as phoneName } from "expo-device";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, SafeAreaView, Text, View } from "react-native";
import { KriyonNative } from "../modules/kriyon-native/index.ts";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { PairScreen } from "./screens/PairScreen.tsx";
import { SessionScreen } from "./screens/SessionScreen.tsx";
import { usePhone } from "./state/phone.ts";
import { colors, ui } from "./ui.ts";

/** What computers show for this phone. */
function deviceName(): string {
  return phoneName ?? modelName ?? "Phone";
}

function Current() {
  const screen = usePhone((state) => state.screen);
  const startError = usePhone((state) => state.startError);
  if (startError) {
    return (
      <View style={[ui.screen, { gap: 8, padding: 16 }]}>
        <Text style={ui.title}>Kriyon</Text>
        <Text style={[ui.hint, { color: colors.statusError }]}>
          {startError}
        </Text>
      </View>
    );
  }
  switch (screen.kind) {
    case "pair":
      return <PairScreen />;
    case "session":
      return (
        <SessionScreen hostId={screen.hostId} sessionId={screen.sessionId} />
      );
    default:
      return <HomeScreen />;
  }
}

export function App() {
  useEffect(() => {
    const { hostChanged, start } = usePhone.getState();
    const changes = KriyonNative.addListener("onHostChanged", hostChanged);
    start(deviceName()).catch(() => undefined);
    // Back in front, or the network came back: dial now, not after backoff.
    const front = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        try {
          KriyonNative.wake();
        } catch {
          // Not started yet: nothing to wake.
        }
      }
    });
    return () => {
      changes.remove();
      front.remove();
    };
  }, []);
  return (
    <SafeAreaView style={ui.screen}>
      <Current />
      <StatusBar style="light" />
    </SafeAreaView>
  );
}
