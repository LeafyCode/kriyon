/**
 * A session's readable view: what the desktop's Structured view shows, at
 * phone width, from the entries Rust reads off the computer. It only reads:
 * Claude's questions are answered in the terminal. It never touches the
 * terminal's size.
 */
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type {
  ShownEntry,
  ShownKind,
} from "../../../../src/remote/readableSummary.ts";
import { readableKey, standingMeta, usePhone } from "../state/phone.ts";
import { colors, ui } from "../ui.ts";

/** How near the bottom still counts as following the newest entry. */
const FOLLOW_SLACK = 48;

type StepState = Extract<ShownKind, { kind: "step" }>["state"];

const mono = Platform.select({ android: "monospace", default: "Menlo" });

/** `hex` (#rrggbb) at `alpha`, as the desktop's accent washes. */
function wash(hex: string, alpha: number): string {
  const byte = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${byte}`;
}

/** A step's mark and colour, as the desktop's step list shows them. */
const STEP_LOOK: Record<StepState, { color: string; mark: string }> = {
  done: { color: colors.statusDone, mark: "✓" },
  failed: { color: colors.statusError, mark: "✕" },
  running: { color: colors.statusRunning, mark: "●" },
};

/** A report's outcome colour: finished and failed as the desktop's. */
function outcomeColor(outcome: string): string {
  if (outcome === "Finished") {
    return colors.statusDone;
  }
  return outcome === "Failed" ? colors.statusError : colors.inkMuted;
}

function Entry({
  entry,
  onAnswer,
}: {
  entry: ShownEntry;
  onAnswer: () => void;
}) {
  const id = `entry-${entry.seq}`;
  switch (entry.kind) {
    case "you":
      return (
        <View
          accessibilityLabel="Your prompt"
          style={{
            alignSelf: "flex-end",
            backgroundColor: wash(colors.accent, 0.1),
            borderBottomRightRadius: 4,
            borderColor: wash(colors.accent, 0.22),
            borderRadius: 14,
            borderWidth: 1,
            maxWidth: "85%",
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
          testID={id}
        >
          <Text
            style={{ color: colors.inkBright, fontSize: 15, lineHeight: 21 }}
          >
            {entry.text}
          </Text>
        </View>
      );
    case "claude":
      return (
        <View accessibilityLabel="Claude" style={{ gap: 4 }} testID={id}>
          <Text style={{ color: colors.inkSecondary, fontSize: 12 }}>
            <Text style={{ color: colors.accentBright }}>✻ </Text>
            Claude
          </Text>
          <Text
            style={{ color: colors.inkPrimary, fontSize: 15, lineHeight: 22 }}
          >
            {entry.text}
            {entry.done ? null : (
              <Text style={{ color: colors.accentBright }}> ▍</Text>
            )}
          </Text>
        </View>
      );
    case "step": {
      const look = STEP_LOOK[entry.state] ?? STEP_LOOK.running;
      return (
        <View
          style={{ alignItems: "center", flexDirection: "row", gap: 8 }}
          testID={id}
        >
          <Text style={{ color: look.color, fontSize: 12, width: 14 }}>
            {look.mark}
          </Text>
          <Text style={{ color: colors.inkSecondary, fontSize: 13 }}>
            {entry.name}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              color: colors.inkMuted,
              flex: 1,
              fontFamily: mono,
              fontSize: 12,
            }}
          >
            {entry.target}
          </Text>
        </View>
      );
    }
    case "report":
      return (
        <View
          style={{
            backgroundColor: colors.surface1,
            borderColor: colors.lineSoft,
            borderRadius: 10,
            borderWidth: 1,
            gap: 4,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
          testID={id}
        >
          <Text style={{ color: outcomeColor(entry.outcome), fontSize: 12 }}>
            {entry.outcome}
          </Text>
          <Text
            style={{ color: colors.inkPrimary, fontSize: 14, lineHeight: 20 }}
          >
            {entry.summary}
          </Text>
        </View>
      );
    case "asking":
      return (
        <View
          style={{
            borderColor: colors.statusWaiting,
            borderRadius: 10,
            borderWidth: 1,
            gap: 8,
            padding: 12,
          }}
          testID={id}
        >
          {entry.header ? (
            <Text style={{ color: colors.statusWaiting, fontSize: 12 }}>
              {entry.header}
            </Text>
          ) : null}
          <Text
            style={{ color: colors.inkBright, fontSize: 15, lineHeight: 21 }}
          >
            {entry.question}
          </Text>
          {entry.options.map((option, index) => (
            <Text
              // Two options can read the same: their place tells them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: options never move
              key={index}
              style={{ color: colors.inkSecondary, fontSize: 14 }}
            >
              · {option}
            </Text>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={onAnswer}
            style={ui.ghostButton}
          >
            <Text style={ui.ghostButtonText}>Answer in the terminal</Text>
          </Pressable>
        </View>
      );
    case "note":
      return (
        <Text
          style={{
            color: colors.inkMuted,
            fontSize: 12,
            fontStyle: "italic",
            textAlign: "center",
          }}
          testID={id}
        >
          {entry.text}
        </Text>
      );
    default:
      return null;
  }
}

export function ReadableView({
  hostId,
  onAnswer,
  sessionId,
}: {
  hostId: string;
  /** Show the terminal, where a question is answered. */
  onAnswer: () => void;
  sessionId: string;
}) {
  const summary = usePhone(
    (state) => state.readable[readableKey(hostId, sessionId)]
  );
  const session = usePhone((state) =>
    state.states[hostId]?.sessions.find((one) => one.id === sessionId)
  );
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Following the newest entry, until the person scrolls up to read.
  const following = useRef(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const { closeReadable, openReadable } = usePhone.getState();
    openReadable(hostId, sessionId).catch((error: unknown) =>
      setNote(error instanceof Error ? error.message : String(error))
    );
    return () => {
      closeReadable(hostId, sessionId).catch(() => undefined);
    };
  }, [hostId, sessionId]);

  const needs = session?.needsYou
    ? standingMeta(session.standing, colors)
    : null;
  return (
    <View style={{ flex: 1, gap: 10 }}>
      {needs ? (
        <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
          <View
            style={{
              backgroundColor: needs.color,
              borderRadius: 4,
              height: 8,
              width: 8,
            }}
          />
          <Text style={{ color: needs.color, fontSize: 13 }}>
            {`Needs you · ${needs.label}`}
          </Text>
        </View>
      ) : null}
      {note ? <Text style={ui.hint}>{note}</Text> : null}
      {summary || note ? null : <Text style={ui.hint}>Reading…</Text>}
      {summary && summary.entries.length === 0 ? (
        <Text style={ui.hint}>Nothing to read yet.</Text>
      ) : null}
      <ScrollView
        contentContainerStyle={{ gap: 14, paddingBottom: 16 }}
        // The newest entry stays in view as entries come, as on the desktop,
        // unless the person scrolled up to read.
        onContentSizeChange={() => {
          if (following.current) {
            scroll.current?.scrollToEnd();
          }
        }}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          following.current =
            contentOffset.y + layoutMeasurement.height >=
            contentSize.height - FOLLOW_SLACK;
        }}
        ref={scroll}
        scrollEventThrottle={100}
      >
        {summary?.entries.map((entry) => (
          <Entry entry={entry} key={entry.seq} onAnswer={onAnswer} />
        ))}
      </ScrollView>
    </View>
  );
}
