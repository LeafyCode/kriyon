/**
 * The phone app's shell. The screens come in later steps; the look is the
 * desktop's own Steel theme, read from the same theme files.
 */
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { steel } from "../../../src/theme/themes/steel.ts";

const { colors } = steel;

export function App() {
  return (
    <View style={styles.window}>
      <Text style={styles.name}>Kriyon</Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  name: {
    color: colors.inkBright,
    fontSize: 22,
    fontWeight: "600",
  },
  window: {
    alignItems: "center",
    backgroundColor: colors.chromeWindow,
    flex: 1,
    justifyContent: "center",
  },
});
