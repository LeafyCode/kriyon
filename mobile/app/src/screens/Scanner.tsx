/**
 * The camera, scanning for the QR code the computer shows (Remote access →
 * Pair a device). It takes the first Kriyon pairing code it sees, then
 * stops scanning.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { pairingCodeFrom } from "../../../../src/remote/hostSummary.ts";
import appJson from "../../app.json" with { type: "json" };
import { Button, useLook } from "../kit.tsx";

/**
 * Why Kriyon asks for the camera: the same words as the system prompt, read
 * from the camera plugin's settings in app.json.
 */
const WHY_CAMERA = (() => {
  for (const plugin of appJson.expo.plugins) {
    if (Array.isArray(plugin) && plugin[0] === "expo-camera") {
      const settings = plugin[1] as { cameraPermission?: string };
      return settings.cameraPermission ?? "";
    }
  }
  return "";
})();

/** How long "not a Kriyon pairing code" stays after a wrong code is seen. */
const WRONG_SHOWS_MS = 2500;

export function Scanner({ onCode }: { onCode: (code: string) => void }) {
  const { text } = useLook();
  const [permission, ask] = useCameraPermissions();
  const [wrong, setWrong] = useState(false);
  const [done, setDone] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);

  useEffect(() => {
    if (!wrong) {
      return;
    }
    const clear = setTimeout(() => setWrong(false), WRONG_SHOWS_MS);
    return () => clearTimeout(clear);
  }, [wrong]);

  // Still being read: ask nothing yet.
  if (!permission) {
    return null;
  }
  if (!permission.granted) {
    if (!permission.canAskAgain) {
      return (
        <View style={{ gap: 10 }}>
          <Text style={text.caption}>
            The camera is off for Kriyon. Turn it on in Settings, or paste the
            pairing code instead.
          </Text>
          <Button
            kind="ghost"
            label="Open Settings"
            onPress={() => {
              Linking.openSettings().catch(() => undefined);
            }}
          />
        </View>
      );
    }
    return (
      <View style={{ gap: 10 }}>
        <Text style={text.caption}>{WHY_CAMERA}</Text>
        <Button
          kind="soft"
          label="Allow the camera"
          onPress={() => {
            ask().catch(() => undefined);
          }}
        />
      </View>
    );
  }
  if (broken) {
    return (
      <Text style={text.caption}>
        The camera didn't start ({broken}). Paste the pairing code instead.
      </Text>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        facing="back"
        // Once a code is taken, no more scans come.
        onBarcodeScanned={
          done
            ? undefined
            : (result) => {
                const code = pairingCodeFrom(result.data);
                if (code) {
                  setDone(true);
                  onCode(code);
                } else {
                  setWrong(true);
                }
              }
        }
        onMountError={(event) => setBroken(event.message)}
        style={{ aspectRatio: 1, borderRadius: 16, overflow: "hidden" }}
      />
      <Text style={text.caption}>
        {wrong
          ? "That isn't a Kriyon pairing code."
          : "Point the camera at the QR code on your computer."}
      </Text>
    </View>
  );
}
