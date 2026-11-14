/**
 * Settings, as the mobile design draws it: alerts, our relay (in a build
 * that has one), the paired computers (forget one here), and this phone's
 * key as computers show it.
 */
import { ScrollView, Text, View } from "react-native";
import { Button, Pill, TopBar, useLook } from "../kit.tsx";
import { roleWord, shortKey } from "../state/home.ts";
import { usePhone } from "../state/phone.ts";
import { alertsWord, pushLine } from "../state/push.ts";
import { fonts } from "../theme.ts";
import { RelaySection } from "./RelaySection.tsx";

/** "13 Nov": when a computer was paired. */
function pairedOn(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

export function SettingsScreen() {
  const { t, text } = useLook();
  const hosts = usePhone((state) => state.hosts);
  const states = usePhone((state) => state.states);
  const push = usePhone((state) => state.push);
  const deviceId = usePhone((state) => state.deviceId);
  const { forget, show } = usePhone.getState();
  const alerts = alertsWord(push);
  const box = {
    backgroundColor: t.card,
    borderColor: t.line,
    borderRadius: 14,
    borderWidth: 1,
  };
  return (
    <View style={{ backgroundColor: t.bg, flex: 1 }}>
      <View style={{ paddingHorizontal: 8, paddingTop: 4 }}>
        <TopBar back={() => show({ kind: "home" })} title="Settings" />
      </View>
      <ScrollView
        contentContainerStyle={{
          gap: 22,
          paddingBottom: 32,
          paddingHorizontal: 16,
          paddingTop: 8,
        }}
      >
        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={[text.label, { paddingHorizontal: 4 }]}
          >
            Alerts
          </Text>
          <View
            style={[
              box,
              {
                flexDirection: "row",
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 12,
              },
            ]}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text.body}>When a session needs you</Text>
              <Text style={text.caption}>
                Says only "A session needs you". Details come from your
                computer.
              </Text>
              {push && push !== "on" ? (
                <Text style={[text.caption, { color: t.ink2 }]}>
                  {pushLine(push)}
                </Text>
              ) : null}
            </View>
            <Pill label={alerts.label} tone={alerts.tone} />
          </View>
        </View>

        <RelaySection />

        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={[text.label, { paddingHorizontal: 4 }]}
          >
            Computers
          </Text>
          {hosts.length === 0 ? (
            <Text style={[text.caption, { paddingHorizontal: 4 }]}>
              No computers yet.
            </Text>
          ) : (
            <View style={box}>
              {hosts.map((host, index) => {
                const summary = states[host.hostId];
                const role = roleWord(summary?.role ?? null);
                const name = summary?.hostName || host.name;
                return (
                  <View
                    key={host.hostId}
                    style={{
                      alignItems: "center",
                      borderBottomColor: t.lineSoft,
                      borderBottomWidth: index === hosts.length - 1 ? 0 : 1,
                      flexDirection: "row",
                      gap: 12,
                      minHeight: 56,
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={text.body}>{name}</Text>
                      <Text style={text.caption}>
                        {[role, `paired ${pairedOn(host.pairedAtMs)}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    <Button
                      accessibilityLabel={`Forget ${name}`}
                      kind="danger"
                      label="Forget"
                      onPress={() => {
                        forget(host.hostId).catch(() => undefined);
                      }}
                    />
                  </View>
                );
              })}
            </View>
          )}
          <Text style={[text.caption, { paddingHorizontal: 4 }]}>
            Forgetting here stops this phone. To cut a lost phone off, remove it
            on the computer.
          </Text>
        </View>

        {deviceId ? (
          <View style={{ gap: 8 }}>
            <Text
              accessibilityRole="header"
              style={[text.label, { paddingHorizontal: 4 }]}
            >
              This phone
            </Text>
            <View
              style={[
                box,
                {
                  alignItems: "center",
                  flexDirection: "row",
                  justifyContent: "space-between",
                  minHeight: 48,
                  paddingHorizontal: 16,
                },
              ]}
            >
              <Text style={[text.body, { color: t.ink2 }]}>Device key</Text>
              <Text
                accessibilityLabel={`Device key ${shortKey(deviceId).replaceAll("·", " ")}`}
                style={{ color: t.ink1, fontFamily: fonts.mono, fontSize: 13 }}
              >
                {shortKey(deviceId)}
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
