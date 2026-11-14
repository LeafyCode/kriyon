/**
 * Our relay, under Settings' "Reach from anywhere", only in a build that
 * has one: sign in (the same account as the computer's), the switch, and
 * the subscription's state. No buy button: subscriptions are managed on the
 * computer.
 */
import { useEffect } from "react";
import { Linking, Switch, Text, View } from "react-native";
import { subscriptionWords } from "../../../../src/remote/relayWords.ts";
import { Button, useLook } from "../kit.tsx";
import { useRelay } from "../state/relay.ts";
import { fonts } from "../theme.ts";

export function RelaySection() {
  const { t, text } = useLook();
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
  const row = {
    alignItems: "center" as const,
    borderBottomColor: t.lineSoft,
    borderBottomWidth: 1,
    flexDirection: "row" as const,
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  };
  return (
    <View style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        style={[text.label, { paddingHorizontal: 4 }]}
      >
        Reach from anywhere
      </Text>
      <View
        style={{
          backgroundColor: t.card,
          borderColor: t.line,
          borderRadius: 14,
          borderWidth: 1,
        }}
      >
        {view.signedIn ? (
          <>
            <View style={row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={text.body}>Our relay</Text>
                <Text style={text.caption}>
                  Traffic passes a server that can't read it.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Our relay"
                onValueChange={(on) => {
                  setOn(on).catch(() => undefined);
                }}
                thumbColor={t.knob}
                trackColor={{ false: t.lineStrong, true: t.accent }}
                value={view.on}
              />
            </View>
            <View style={row}>
              <Text style={[text.body, { color: t.ink2, flex: 1 }]}>
                Subscription
              </Text>
              <Text style={[text.body, { flexShrink: 1, textAlign: "right" }]}>
                {account
                  ? subscriptionWords(account)
                  : "Reading the subscription…"}
              </Text>
            </View>
            <View
              style={{ gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}
            >
              <Text style={text.caption}>
                Subscriptions are managed on your computer. Sign in with the
                same account there.
              </Text>
              <Button
                kind="ghost"
                label="Sign out"
                onPress={() => {
                  signOut().catch(() => undefined);
                }}
              />
            </View>
          </>
        ) : (
          <View style={{ gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={text.body}>Our relay</Text>
            <Text style={text.caption}>
              When no direct path works, this phone can reach your computer
              through our relay. Sign in with the same account on your computer.
            </Text>
            {view.signIn ? (
              <View style={{ gap: 8 }}>
                <Text style={text.caption}>
                  Check the browser shows this code, then approve:
                </Text>
                <Text
                  accessibilityLabel={`Code ${view.signIn.userCode.split("").join(" ")}`}
                  style={{
                    color: t.ink,
                    fontFamily: fonts.mono,
                    fontSize: 22,
                    letterSpacing: 4,
                  }}
                >
                  {view.signIn.userCode}
                </Text>
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  <Button
                    kind="ghost"
                    label="Open the page again"
                    onPress={() => {
                      const page = view.signIn?.verificationUriComplete;
                      if (page) {
                        Linking.openURL(page).catch(() => undefined);
                      }
                    }}
                  />
                  <Button
                    kind="ghost"
                    label="Cancel"
                    onPress={() => {
                      cancelSignIn().catch(() => undefined);
                    }}
                  />
                </View>
              </View>
            ) : (
              <Button
                kind="soft"
                label="Sign in"
                onPress={() => {
                  signIn().catch(() => undefined);
                }}
              />
            )}
          </View>
        )}
      </View>
      <Text style={[text.caption, { paddingHorizontal: 4 }]}>
        Free without it: the same Wi-Fi, or your own Tailscale.
      </Text>
      {problems.map((line) => (
        <Text
          key={line}
          style={[text.caption, { color: t.red, paddingHorizontal: 4 }]}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}
