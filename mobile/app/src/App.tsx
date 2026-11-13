/**
 * The phone app: starts Kriyon's Rust library once, keeps what it says
 * about each paired computer, dials again when the app comes to the front,
 * and shows the screen the store names.
 */
import { modelName, deviceName as phoneName } from "expo-device";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import {
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Text,
  View,
} from "react-native";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { KriyonNative } from "../modules/kriyon-native/index.ts";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { NewSessionScreen } from "./screens/NewSessionScreen.tsx";
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
    case "new":
      return <NewSessionScreen hostId={screen.hostId} />;
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
    const { entriesChanged, hostChanged, start } = usePhone.getState();
    const changes = KriyonNative.addListener("onHostChanged", hostChanged);
    const entries = KriyonNative.addListener(
      "onEntriesChanged",
      entriesChanged
    );
    start(deviceName()).catch(() => undefined);
    // Back in front, or the network came back: dial now, not after backoff.
    const front = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        return;
      }
      // A start that failed while the phone was locked (its keys are
      // readable only while it is unlocked) is tried again now.
      if (usePhone.getState().startError) {
        start(deviceName()).catch(() => undefined);
        return;
      }
      try {
        KriyonNative.wake();
      } catch {
        // Not started yet: nothing to wake.
      }
    });
    // Android's Back goes back a screen; at home it leaves the app.
    const back = BackHandler.addEventListener("hardwareBackPress", () =>
      usePhone.getState().back()
    );
    return () => {
      changes.remove();
      entries.remove();
      front.remove();
      back.remove();
    };
  }, []);
  // Inside the status and navigation bars on both phones: Android draws
  // the app edge to edge, under both.
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <SafeAreaView style={ui.screen}>
        {/* Android, edge to edge, no longer shrinks the app for the
            keyboard: without this it covers the terminal's last rows. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "android" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <Current />
        </KeyboardAvoidingView>
        <StatusBar style="light" />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
