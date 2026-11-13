/**
 * Home: what needs you first, as on the desktop, then each paired computer
 * with its sessions and how its link stands.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { linkLine } from "../../../../src/remote/remoteScreen.ts";
import type {
  HostSession,
  PairedHost,
} from "../../modules/kriyon-native/index.ts";
import {
  canStartSession,
  needsYou,
  standingMeta,
  usePhone,
} from "../state/phone.ts";
import { colors, ui } from "../ui.ts";
import { RelaySection } from "./RelaySection.tsx";

function SessionRow({
  host,
  session,
  showHost,
}: {
  host: PairedHost;
  session: HostSession;
  showHost: boolean;
}) {
  const { show } = usePhone.getState();
  const meta = standingMeta(session.standing, colors);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        show({ hostId: host.hostId, kind: "session", sessionId: session.id })
      }
      style={ui.row}
    >
      <View
        style={{
          backgroundColor: meta.color,
          borderRadius: 4,
          height: 8,
          width: 8,
        }}
      />
      <Text numberOfLines={1} style={ui.rowTitle}>
        {session.title}
      </Text>
      <Text style={ui.hint}>{showHost ? host.name : meta.label}</Text>
    </Pressable>
  );
}

export function HomeScreen() {
  const hosts = usePhone((state) => state.hosts);
  const states = usePhone((state) => state.states);
  const push = usePhone((state) => state.push);
  const { forget, show } = usePhone.getState();
  const waiting = needsYou(hosts, states);
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} style={ui.screen}>
      <Text style={ui.title}>Kriyon</Text>
      {waiting.length > 0 ? (
        <>
          <Text style={ui.sectionLabel}>Needs you</Text>
          {waiting.map(({ host, session }) => (
            <SessionRow
              host={host}
              key={`${host.hostId}/${session.id}`}
              session={session}
              showHost
            />
          ))}
        </>
      ) : null}
      {hosts.length === 0 ? (
        <Text style={[ui.hint, { marginTop: 20 }]}>No computers yet.</Text>
      ) : null}
      {hosts.map((host) => {
        const state = states[host.hostId];
        return (
          <View key={host.hostId}>
            <View style={{ alignItems: "flex-end", flexDirection: "row" }}>
              <Text style={[ui.sectionLabel, { flex: 1 }]}>{host.name}</Text>
              <Pressable
                accessibilityLabel={`Forget ${host.name}`}
                accessibilityRole="button"
                onPress={() => {
                  forget(host.hostId).catch(() => undefined);
                }}
              >
                <Text style={ui.hint}>Forget</Text>
              </Pressable>
            </View>
            <Text style={ui.hint}>{linkLine(state?.link ?? "connecting")}</Text>
            {canStartSession(state) ? (
              <Pressable
                accessibilityLabel={`New session on ${host.name}`}
                accessibilityRole="button"
                onPress={() => show({ hostId: host.hostId, kind: "new" })}
                style={ui.row}
              >
                <Text style={ui.ghostButtonText}>+ New session</Text>
              </Pressable>
            ) : null}
            {(state?.sessions ?? []).map((session) => (
              <SessionRow
                host={host}
                key={session.id}
                session={session}
                showHost={false}
              />
            ))}
          </View>
        );
      })}
      <RelaySection />
      {push ? (
        <Text style={[ui.hint, { marginTop: 16 }]}>Alerts: {push}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => show({ kind: "pair" })}
        style={[ui.ghostButton, { marginTop: 24 }]}
      >
        <Text style={ui.ghostButtonText}>Pair a computer</Text>
      </Pressable>
    </ScrollView>
  );
}
