/**
 * The phone app: starts Kriyon's Rust library once, keeps what it says
 * about each paired computer, dials again when the app comes to the front,
 * and shows the screen the store names.
 */
import { Geist_400Regular } from "@expo-google-fonts/geist/400Regular";
import { Geist_500Medium } from "@expo-google-fonts/geist/500Medium";
import { Geist_700Bold } from "@expo-google-fonts/geist/700Bold";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono/400Regular";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono/500Medium";
import { modelName, deviceName as phoneName } from "expo-device";
import { useFonts } from "expo-font";
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
import { useLook } from "./kit.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { NewSessionSheet } from "./screens/NewSessionScreen.tsx";
import { PairScreen } from "./screens/PairScreen.tsx";
import { SessionScreen } from "./screens/SessionScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { usePhone } from "./state/phone.ts";
import { useMode } from "./theme.ts";

/** What computers show for this phone. */
function deviceName(): string {
  return phoneName ?? modelName ?? "Phone";
}

/** The design's fonts (OFL), one file per weight used. */
const FONTS = {
  Geist_400Regular,
  Geist_500Medium,
  Geist_700Bold,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
};

function Current() {
  const screen = usePhone((state) => state.screen);
  const startError = usePhone((state) => state.startError);
  const { t, text } = useLook();
  if (startError) {
    return (
      <View style={{ gap: 8, padding: 20 }}>
        <Text accessibilityRole="header" style={text.h1}>
          Sessions
        </Text>
        <Text style={[text.body, { color: t.red }]}>{startError}</Text>
      </View>
    );
  }
  switch (screen.kind) {
    case "pair":
      return <PairScreen />;
    case "settings":
      return <SettingsScreen />;
    case "session":
      return (
        <SessionScreen
          hostId={screen.hostId}
          initialView={screen.view}
          key={`${screen.hostId}/${screen.sessionId}`}
          sessionId={screen.sessionId}
        />
      );
    default:
      // Home, the same element whether or not the sheet is over it (so it
      // keeps its filter, folds and scroll), with New session as a sheet.
      return (
        <>
          <HomeScreen />
          {screen.kind === "new" ? (
            <NewSessionSheet hostId={screen.hostId} />
          ) : null}
        </>
      );
  }
}

export function App() {
  const [fontsLoaded, fontsFailed] = useFonts(FONTS);
  const mode = useMode();
  const { t } = useLook();
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
  // Without the fonts, text would be drawn in a font that isn't there:
  // wait the moment they take (or go on in the phone's own if they fail).
  if (!(fontsLoaded || fontsFailed)) {
    return null;
  }
  // Inside the status and navigation bars on both phones: Android draws
  // the app edge to edge, under both.
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <SafeAreaView style={{ backgroundColor: t.bg, flex: 1 }}>
        {/* Android, edge to edge, no longer shrinks the app for the
            keyboard: without this it covers the terminal's last rows. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "android" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <Current />
        </KeyboardAvoidingView>
        <StatusBar style={mode === "dark" ? "light" : "dark"} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
