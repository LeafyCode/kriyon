/**
 * Home, as the mobile design draws it: the sessions at a glance, what needs
 * you (questions to answer in the terminal, turns waiting for a reply),
 * then each paired computer with its running sessions and the idle ones
 * folded. Every status is a word; colour only repeats it. Fields Rust
 * doesn't send yet (a question's text, the running tool, a turn's summary
 * and diff, plan use) simply don't show.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  HostSummary,
  PlanUsage,
  SessionSummary,
} from "../../../../src/remote/hostSummary.ts";
import type { PairedHost } from "../../modules/kriyon-native/index.ts";
import {
  Button,
  Card,
  Dot,
  Icon,
  IconButton,
  Pill,
  useLook,
  useNow,
} from "../kit.tsx";
import {
  type Filter,
  glance,
  hostRows,
  linkWords,
  needsYouCards,
  pillFor,
} from "../state/home.ts";
import { usePhone } from "../state/phone.ts";
import { fonts } from "../theme.ts";

/** Opens a session, on the view it should start on. */
function open(
  host: PairedHost,
  session: SessionSummary,
  view: "readable" | "terminal" = "readable"
) {
  usePhone.getState().show({
    hostId: host.hostId,
    kind: "session",
    sessionId: session.id,
    view,
  });
}

/** "MacBook Pro · api-server": where a session is. */
function placeOf(
  host: PairedHost,
  summary: HostSummary | undefined,
  session: SessionSummary
) {
  const project = summary?.projects.find((p) => p.id === session.projectId);
  const name = summary?.hostName || host.name;
  return project ? `${name} · ${project.name}` : name;
}

function Glance({
  hosts,
  states,
}: {
  hosts: PairedHost[];
  states: Record<string, HostSummary>;
}) {
  const { t, text } = useLook();
  const counts = glance(hosts, states);
  if (counts.total === 0) {
    return null;
  }
  const parts = [
    { color: t.amber, count: counts.asking, label: "asking" },
    { color: t.green, count: counts.yourTurn, label: "your turn" },
    { color: t.accentBright, count: counts.running, label: "running" },
    { color: t.lineStrong, count: counts.idle, label: "idle" },
  ];
  const described = parts.map((p) => `${p.count} ${p.label}`).join(", ");
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ alignItems: "baseline", flexDirection: "row", gap: 8 }}>
        <Text style={{ color: t.ink, fontFamily: fonts.mono, fontSize: 28 }}>
          {counts.total}
        </Text>
        <Text style={[text.body, { color: t.ink2 }]}>
          {counts.total === 1 ? "session" : "sessions"}
          {counts.needsYou > 0 ? ` · ${counts.needsYou} need you` : ""}
        </Text>
      </View>
      <View
        accessibilityLabel={described}
        accessibilityRole="image"
        style={{
          borderRadius: 4,
          flexDirection: "row",
          gap: 3,
          height: 8,
          overflow: "hidden",
        }}
      >
        {parts
          .filter((p) => p.count > 0)
          .map((p) => (
            <View
              key={p.label}
              style={{ backgroundColor: p.color, flex: p.count }}
            />
          ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {parts.map((p) => (
          <View
            key={p.label}
            style={{ alignItems: "center", flexDirection: "row", gap: 5 }}
          >
            {p.label === "idle" ? (
              <View
                style={{
                  borderColor: t.muted,
                  borderRadius: 4,
                  borderWidth: 1.5,
                  height: 7,
                  width: 7,
                }}
              />
            ) : (
              <Dot color={p.color} size={7} />
            )}
            <Text style={text.small}>{`${p.count} ${p.label}`}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

function Chips({
  filter,
  needs,
  running,
  setFilter,
}: {
  filter: Filter;
  needs: number;
  running: number;
  setFilter: (filter: Filter) => void;
}) {
  const { t } = useLook();
  const chips: { label: string; value: Filter }[] = [
    { label: "All", value: "all" },
    { label: `Needs you · ${needs}`, value: "needsYou" },
    { label: `Running · ${running}`, value: "running" },
  ];
  return (
    <View
      accessibilityLabel="Show"
      accessibilityRole="tablist"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
    >
      {chips.map((chip) => {
        const on = chip.value === filter;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            key={chip.value}
            onPress={() => setFilter(chip.value)}
            style={{
              backgroundColor: on ? t.ink1 : "transparent",
              borderColor: on ? t.ink1 : t.line,
              borderRadius: 22,
              borderWidth: 1,
              justifyContent: "center",
              minHeight: 44,
              paddingHorizontal: 14,
            }}
          >
            <Text
              style={{
                color: on ? t.bg : t.ink2,
                fontFamily: on ? fonts.medium : fonts.regular,
                fontSize: 14,
              }}
            >
              {chip.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A card's top: what the session is, where, and its status in a word. */
function CardHead({
  dot,
  host,
  now,
  session,
  summary,
}: {
  dot: string;
  host: PairedHost;
  now: number;
  session: SessionSummary;
  summary: HostSummary | undefined;
}) {
  const { text } = useLook();
  const pill = pillFor(session, now);
  return (
    <Pressable
      accessibilityHint="Opens the session"
      accessibilityRole="button"
      onPress={() => open(host, session)}
      style={{ gap: 4, minHeight: 44 }}
    >
      <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
        <Dot color={dot} />
        <Text numberOfLines={2} style={[text.title, { flex: 1 }]}>
          {session.title}
        </Text>
        <Pill label={pill.label} tone={pill.tone} />
      </View>
      <Text style={[text.caption, { paddingLeft: 16 }]}>
        {placeOf(host, summary, session)}
      </Text>
    </Pressable>
  );
}

function AskingCard({
  host,
  now,
  session,
  summary,
}: {
  host: PairedHost;
  now: number;
  session: SessionSummary;
  summary: HostSummary | undefined;
}) {
  const { t, text } = useLook();
  const { question } = session;
  const shown = question?.options.slice(0, 2) ?? [];
  const more = (question?.options.length ?? 0) - shown.length;
  return (
    <Card style={{ backgroundColor: t.amberSoft, borderColor: t.amberLine }}>
      <CardHead
        dot={t.amber}
        host={host}
        now={now}
        session={session}
        summary={summary}
      />
      {question ? (
        <>
          <Text style={text.body}>{question.text}</Text>
          {shown.length > 0 ? (
            <View style={{ gap: 4 }}>
              {shown.map((option, index) => (
                <Text
                  // Two options can read the same: their place tells them apart.
                  // biome-ignore lint/suspicious/noArrayIndexKey: options never move
                  key={index}
                  style={[text.bodyMuted, { fontSize: 13 }]}
                >
                  <Text style={{ color: t.amberInk, fontFamily: fonts.mono }}>
                    {index + 1}
                  </Text>
                  {`  ${option}`}
                </Text>
              ))}
              {more > 0 ? (
                <Text style={text.caption}>{`+${more} more`}</Text>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
      <Button
        icon="arrowRight"
        kind="amber"
        label="Answer in the terminal"
        onPress={() => open(host, session, "terminal")}
      />
    </Card>
  );
}

function YourTurnCard({
  host,
  now,
  session,
  summary,
}: {
  host: PairedHost;
  now: number;
  session: SessionSummary;
  summary: HostSummary | undefined;
}) {
  const { t, text } = useLook();
  const { diff } = session;
  return (
    <Card>
      <CardHead
        dot={t.green}
        host={host}
        now={now}
        session={session}
        summary={summary}
      />
      {session.turnSummary ? (
        <Text style={text.bodyMuted}>{session.turnSummary}</Text>
      ) : null}
      <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
        {diff ? (
          <View
            accessibilityLabel={`${diff.files} files changed, ${diff.added} lines added, ${diff.removed} removed`}
            style={{
              backgroundColor: t.overlay,
              borderRadius: 14,
              flexDirection: "row",
              gap: 6,
              paddingHorizontal: 10,
              paddingVertical: 6,
            }}
          >
            <Text style={text.mono}>
              {diff.files === 1 ? "1 file" : `${diff.files} files`}
            </Text>
            <Text
              style={[text.mono, { color: t.greenInk }]}
            >{`+${diff.added}`}</Text>
            <Text
              style={[text.mono, { color: t.red }]}
            >{`−${diff.removed}`}</Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Button label="Reply" onPress={() => open(host, session)} />
      </View>
    </Card>
  );
}

/** A session row under its computer: running ones say what they run. */
function Row({
  host,
  last,
  now,
  session,
}: {
  host: PairedHost;
  last: boolean;
  now: number;
  session: SessionSummary;
}) {
  const { t, text } = useLook();
  const pill = pillFor(session, now);
  const running = pill.tone === "blue";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => open(host, session)}
      style={{
        alignItems: "center",
        borderBottomColor: t.lineSoft,
        borderBottomWidth: last ? 0 : 1,
        flexDirection: "row",
        gap: 12,
        minHeight: 56,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{
          borderColor: running ? t.accentBright : t.muted,
          borderRadius: 5,
          borderRightColor: running ? "transparent" : t.muted,
          borderWidth: 2,
          height: 10,
          width: 10,
        }}
      />
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <Text style={[text.body, { color: t.ink1 }]}>{session.title}</Text>
        {running && session.activity ? (
          <Text numberOfLines={1} style={[text.mono, { color: t.accentInk }]}>
            {session.activity}
          </Text>
        ) : null}
      </View>
      <Pill label={pill.label} tone={pill.tone} />
    </Pressable>
  );
}

/** A computer's Claude plan use in its window, when it says. */
function UsageBar({ usage }: { usage: PlanUsage }) {
  const { t, text } = useLook();
  const percent = Math.round(usage.usedPercent);
  const resets = usage.resetsAtMs
    ? ` · resets ${new Date(usage.resetsAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "";
  return (
    <View
      style={{
        backgroundColor: t.rail,
        borderColor: t.lineSoft,
        borderRadius: 12,
        borderWidth: 1,
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={text.small}>{`Claude usage · ${usage.window}`}</Text>
        <Text style={[text.small, { fontFamily: fonts.mono }]}>
          {`${percent}%${resets}`}
        </Text>
      </View>
      <View
        accessibilityLabel={`${percent} percent used`}
        accessibilityRole="image"
        style={{
          backgroundColor: t.overlay,
          borderRadius: 3,
          height: 6,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            backgroundColor: t.accentBright,
            height: "100%",
            width: `${Math.min(100, Math.max(0, usage.usedPercent))}%`,
          }}
        />
      </View>
    </View>
  );
}

function Computer({
  filter,
  host,
  now,
  summary,
}: {
  filter: Filter;
  host: PairedHost;
  now: number;
  summary: HostSummary | undefined;
}) {
  const { t, text } = useLook();
  const [showIdle, setShowIdle] = useState(false);
  const connected = summary?.link === "connected";
  const name = summary?.hostName || host.name;
  const rows =
    summary && connected
      ? hostRows(summary, filter)
      : { idle: [], running: [] };
  if (filter !== "all" && rows.running.length === 0) {
    return null;
  }
  const listed = showIdle ? [...rows.running, ...rows.idle] : rows.running;
  return (
    <View style={{ gap: 10, opacity: connected ? 1 : 0.6 }}>
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          gap: 10,
          paddingHorizontal: 4,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" style={text.h2}>
            {name}
          </Text>
          <View style={{ alignItems: "center", flexDirection: "row", gap: 6 }}>
            {connected ? <Dot color={t.green} size={6} /> : null}
            <Text style={[text.caption, { color: t.ink2 }]}>
              {linkWords(summary, now)}
            </Text>
          </View>
        </View>
        {connected && summary?.mayStart ? (
          <Button
            accessibilityLabel={`New session on ${name}`}
            icon="plus"
            kind="soft"
            label="New"
            onPress={() =>
              usePhone.getState().show({ hostId: host.hostId, kind: "new" })
            }
          />
        ) : null}
      </View>
      {connected && summary?.usage ? <UsageBar usage={summary.usage} /> : null}
      {listed.length > 0 ? (
        <View
          style={{
            backgroundColor: t.card,
            borderColor: t.lineSoft,
            borderRadius: 16,
            borderWidth: 1,
          }}
        >
          {listed.map((session, index) => (
            <Row
              host={host}
              key={session.id}
              last={index === listed.length - 1}
              now={now}
              session={session}
            />
          ))}
        </View>
      ) : null}
      {rows.idle.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showIdle }}
          onPress={() => setShowIdle((shown) => !shown)}
          style={{
            alignItems: "center",
            borderColor: t.lineStrong,
            borderRadius: 12,
            borderStyle: "dashed",
            borderWidth: 1,
            flexDirection: "row",
            gap: 8,
            minHeight: 48,
            paddingHorizontal: 16,
          }}
        >
          <Icon color={t.ink2} name="chevronDown" size={16} />
          <Text style={[text.bodyMuted, { fontSize: 14 }]}>
            {showIdle
              ? "Hide idle sessions"
              : `${rows.idle.length} idle ${rows.idle.length === 1 ? "session" : "sessions"}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function HomeScreen() {
  const hosts = usePhone((state) => state.hosts);
  const states = usePhone((state) => state.states);
  const { show } = usePhone.getState();
  const { t, text } = useLook();
  // Each second while a running clock shows ("Running 3:12"), else each 30 s.
  const clock = Object.values(states).some((summary) =>
    summary.sessions.some((one) => Boolean(one.runningSinceMs))
  );
  const now = useNow(clock ? 1000 : 30_000);
  const [filter, setFilter] = useState<Filter>("all");
  const counts = glance(hosts, states);
  const cards = needsYouCards(hosts, states);
  return (
    <ScrollView
      contentContainerStyle={{
        gap: 24,
        paddingBottom: 32,
        paddingHorizontal: 16,
        paddingTop: 12,
      }}
      style={{ backgroundColor: t.bg, flex: 1 }}
    >
      <View style={{ gap: 16 }}>
        <View
          style={{
            alignItems: "center",
            flexDirection: "row",
            paddingHorizontal: 4,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text accessibilityRole="header" style={text.h1}>
              Sessions
            </Text>
            {hosts.length > 0 ? (
              <Text style={text.caption}>
                {hosts.length === 1
                  ? "1 computer"
                  : `${hosts.length} computers`}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <IconButton
              icon="plus"
              label="Pair a computer"
              onPress={() => show({ kind: "pair" })}
            />
            <IconButton
              icon="settings"
              label="Settings"
              onPress={() => show({ kind: "settings" })}
            />
          </View>
        </View>
        <Glance hosts={hosts} states={states} />
        {counts.total > 0 ? (
          <Chips
            filter={filter}
            needs={counts.needsYou}
            running={counts.running}
            setFilter={setFilter}
          />
        ) : null}
      </View>

      {hosts.length === 0 ? (
        <Card style={{ alignItems: "flex-start" }}>
          <Text style={text.title}>No computers yet.</Text>
          <Text style={text.bodyMuted}>
            Pair a computer to see its sessions here: on the computer, open
            Settings › Remote access › Pair a device.
          </Text>
          <Button
            label="Pair a computer"
            onPress={() => show({ kind: "pair" })}
          />
        </Card>
      ) : null}

      {filter !== "running" && cards.length > 0 ? (
        <View style={{ gap: 10 }}>
          <View
            style={{
              alignItems: "center",
              flexDirection: "row",
              gap: 8,
              paddingHorizontal: 4,
            }}
          >
            <Text accessibilityRole="header" style={text.h2}>
              Needs you
            </Text>
            <View
              style={{
                alignItems: "center",
                backgroundColor: t.amberFill,
                borderRadius: 12,
                justifyContent: "center",
                minHeight: 24,
                minWidth: 24,
                paddingHorizontal: 7,
              }}
            >
              <Text
                style={{
                  color: t.onAmber,
                  fontFamily: fonts.bold,
                  fontSize: 13,
                }}
              >
                {cards.length}
              </Text>
            </View>
          </View>
          {cards.map(({ host, kind, session }) =>
            kind === "asking" ? (
              <AskingCard
                host={host}
                key={`${host.hostId}/${session.id}`}
                now={now}
                session={session}
                summary={states[host.hostId]}
              />
            ) : (
              <YourTurnCard
                host={host}
                key={`${host.hostId}/${session.id}`}
                now={now}
                session={session}
                summary={states[host.hostId]}
              />
            )
          )}
        </View>
      ) : null}

      {hosts.map((host) => (
        <Computer
          filter={filter}
          host={host}
          key={host.hostId}
          now={now}
          summary={states[host.hostId]}
        />
      ))}
    </ScrollView>
  );
}
