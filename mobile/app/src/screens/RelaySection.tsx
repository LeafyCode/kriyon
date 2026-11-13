/**
 * Our relay on Home, only in a build that has one: sign in (the same
 * account as the computer's), the switch, and the subscription's state.
 * No buy button: subscriptions are managed on the computer.
 */
import { useEffect } from "react";
import { Linking, Pressable, Switch, Text, View } from "react-native";
import { subscriptionWords } from "../../../../src/remote/relayWords.ts";
import { useRelay } from "../state/relay.ts";
import { colors, ui } from "../ui.ts";

export function RelaySection() {
  const view = useRelay((state) => state.view);
  const account = useRelay((state) => state.account);
  const error = useRelay((state) => state.error);
  useEffect(() => {
    useRelay
      .getState()
      .load()
      .catch(() => undefined);
  }, []);
  if (!view?.available) {
    return null;
  }
  const { cancelSignIn, setOn, signIn, signOut } = useRelay.getState();
  const problems = [error, view.problem].filter(
    (line, index, all): line is string =>
      line !== null && all.indexOf(line) === index
  );
  return (
    <View style={{ gap: 8 }}>
      <Text style={ui.sectionLabel}>Our relay</Text>
      {view.signedIn ? (
        <>
          <View style={ui.row}>
            <Text style={ui.rowTitle}>Our relay</Text>
            <Switch
              accessibilityLabel="Our relay"
              onValueChange={(on) => {
                setOn(on).catch(() => undefined);
              }}
              value={view.on}
            />
          </View>
          <Text style={ui.hint}>
            {account ? subscriptionWords(account) : "Reading the subscription…"}
          </Text>
          <Text style={ui.hint}>
            Subscriptions are managed on your computer.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              signOut().catch(() => undefined);
            }}
          >
            <Text style={ui.hint}>Sign out</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={ui.hint}>
            When no direct path works, this phone can reach your computer
            through our relay.
          </Text>
          <Text style={ui.hint}>
            Sign in with the same account on your computer.
          </Text>
          {view.signIn ? (
            <View style={{ gap: 4 }}>
              <Text style={ui.hint}>
                Check the browser shows this code, then approve:
              </Text>
              <Text
                style={{
                  color: colors.inkBright,
                  fontFamily: "Menlo",
                  fontSize: 22,
                  letterSpacing: 4,
                }}
              >
                {view.signIn.userCode}
              </Text>
              <View style={{ flexDirection: "row", gap: 16 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    const page = view.signIn?.verificationUriComplete;
                    if (page) {
                      Linking.openURL(page).catch(() => undefined);
                    }
                  }}
                >
                  <Text style={ui.ghostButtonText}>Open the page again</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    cancelSignIn().catch(() => undefined);
                  }}
                >
                  <Text style={ui.ghostButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                signIn().catch(() => undefined);
              }}
              style={ui.ghostButton}
            >
              <Text style={ui.ghostButtonText}>Sign in</Text>
            </Pressable>
          )}
        </>
      )}
      {problems.map((line) => (
        <Text key={line} style={[ui.hint, { color: colors.statusError }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}
