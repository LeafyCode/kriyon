/**
 * A session's readable view: what the desktop's Structured view shows, at
 * phone width, in the mobile design's look, from the entries Rust reads off
 * the computer. Claude's questions are answered in the terminal: their
 * options are shown, never buttons. While this phone holds control, a
 * message typed below goes to Claude, as typed into the terminal. It never
 * touches the terminal's size.
 */
import { type ComponentRef, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type {
  ShownEntry,
  ShownKind,
} from "../../../../src/remote/readableSummary.ts";
import { Button, Icon, IconButton, useLook, useReduceMotion } from "../kit.tsx";
import { readableKey, usePhone } from "../state/phone.ts";
import { fonts, type Tokens } from "../theme.ts";

/** How near the bottom still counts as following the newest entry. */
const FOLLOW_SLACK = 48;

type StepState = Extract<ShownKind, { kind: "step" }>["state"];

/** A step's mark, its colour and the word a screen reader says for it. */
function stepLook(
  t: Tokens
): Record<StepState, { color: string; mark: string; word: string }> {
  return {
    done: { color: t.green, mark: "✓", word: "Done" },
    failed: { color: t.red, mark: "✕", word: "Failed" },
    running: { color: t.accentBright, mark: "●", word: "Running" },
  };
}

/** A report's outcome colour: finished and failed as the desktop's. */
function outcomeColor(t: Tokens, outcome: string): string {
  if (outcome === "Finished") {
    return t.greenInk;
  }
  return outcome === "Failed" ? t.red : t.ink2;
}

function Entry({
  entry,
  onAnswer,
}: {
  entry: ShownEntry;
  onAnswer: () => void;
}) {
  const { t, text } = useLook();
  const id = `entry-${entry.seq}`;
  switch (entry.kind) {
    case "you":
      return (
        <View
          accessibilityLabel={`You said: ${entry.text}`}
          accessible
          style={{
            alignSelf: "flex-end",
            backgroundColor: t.accentSoft,
            borderBottomRightRadius: 4,
            borderColor: t.accentLine,
            borderRadius: 16,
            borderWidth: 1,
            maxWidth: "82%",
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
          testID={id}
        >
          <Text style={text.body}>{entry.text}</Text>
        </View>
      );
    case "claude":
      return (
        <View
          accessibilityLabel={
            entry.done
              ? `Claude: ${entry.text}`
              : `Claude, still writing: ${entry.text}`
          }
          accessible
          style={{ flexDirection: "row", gap: 10 }}
          testID={id}
        >
          <Text style={[text.body, { color: t.accentBright }]}>✻</Text>
          <Text style={[text.body, { flex: 1, lineHeight: 22 }]}>
            {entry.text}
            {entry.done ? null : (
              <Text style={{ color: t.accentBright }}> ▍</Text>
            )}
          </Text>
        </View>
      );
    case "step": {
      const looks = stepLook(t);
      const look = looks[entry.state] ?? looks.running;
      return (
        <View
          // One reading per step: "Read src/login.ts, done".
          accessibilityLabel={`${entry.name} ${entry.target}, ${look.word.toLowerCase()}`}
          accessible
          style={{ flexDirection: "row", gap: 8, paddingLeft: 24 }}
          testID={id}
        >
          <Text style={[text.mono, { color: look.color, fontSize: 12.5 }]}>
            {look.mark}
          </Text>
          <Text style={[text.mono, { fontSize: 12.5 }]}>{entry.name}</Text>
          <Text
            numberOfLines={1}
            style={[text.mono, { flex: 1, fontSize: 12.5 }]}
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
            backgroundColor: t.card,
            borderColor: t.lineSoft,
            borderRadius: 14,
            borderWidth: 1,
            gap: 4,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
          testID={id}
        >
          <Text
            style={{
              color: outcomeColor(t, entry.outcome),
              fontFamily: fonts.medium,
              fontSize: 12,
            }}
          >
            {entry.outcome}
          </Text>
          <Text style={text.body}>{entry.summary}</Text>
        </View>
      );
    case "asking":
      return (
        <View
          accessibilityLabel="Claude is asking"
          style={{
            backgroundColor: t.amberSoft,
            borderColor: t.amberLine,
            borderRadius: 14,
            borderWidth: 1,
            gap: 12,
            marginTop: 4,
            padding: 16,
          }}
          testID={id}
        >
          <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
            <Icon color={t.amberInk} name="question" size={14} />
            <Text style={[text.label, { color: t.amberInk, flexShrink: 1 }]}>
              {entry.header
                ? `Claude is asking · ${entry.header}`
                : "Claude is asking"}
            </Text>
          </View>
          <Text style={[text.title, { lineHeight: 22 }]}>{entry.question}</Text>
          {entry.options.length > 0 ? (
            <View style={{ gap: 6 }}>
              {entry.options.map((option, index) => (
                <View
                  // Two options can read the same: their place tells them apart.
                  // biome-ignore lint/suspicious/noArrayIndexKey: options never move
                  key={index}
                  style={{
                    backgroundColor: t.amberWell,
                    borderColor: t.amberWellLine,
                    borderRadius: 10,
                    borderWidth: 1,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  }}
                >
                  <Text style={[text.bodyMuted, { color: t.ink1 }]}>
                    <Text style={{ color: t.amberInk, fontFamily: fonts.mono }}>
                      {index + 1}
                    </Text>
                    {`  ${option}`}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <Button
            icon="arrowRight"
            kind="amber"
            label="Answer in the terminal"
            onPress={onAnswer}
            wide
          />
        </View>
      );
    case "note":
      return (
        <Text
          style={[text.caption, { fontStyle: "italic", textAlign: "center" }]}
          testID={id}
        >
          {entry.text}
        </Text>
      );
    default:
      return null;
  }
}

/** Why the message bar can't send now, or `null` when it can. */
function composeLine(
  asking: boolean,
  controller: boolean,
  mayType: boolean
): string | null {
  if (asking) {
    return "Typing is off while Claude asks. Answer in the terminal.";
  }
  if (!controller) {
    return "This phone may only watch.";
  }
  return mayType
    ? null
    : "Take control in the terminal to write to Claude here.";
}

/** The bar below: a message to Claude while this phone holds control. */
function Compose({
  asking,
  hostId,
  sessionId,
}: {
  asking: boolean;
  hostId: string;
  sessionId: string;
}) {
  const { t, text } = useLook();
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const summary = usePhone((state) => state.states[hostId]);
  const session = summary?.sessions.find((one) => one.id === sessionId);
  const mayType = Boolean(session?.mayType) && !asking;
  const line = composeLine(
    asking,
    summary?.role === "controller",
    Boolean(session?.mayType)
  );
  const send = () => {
    if (!(mayType && message.trim())) {
      return;
    }
    const text = message;
    setMessage("");
    usePhone
      .getState()
      .sendMessage(hostId, sessionId, text)
      .then(() => setProblem(null))
      .catch((error: unknown) => {
        // Not sent: the words come back to try again.
        setMessage(text);
        setProblem(error instanceof Error ? error.message : String(error));
      });
  };
  return (
    <View
      style={{
        backgroundColor: t.rail,
        borderTopColor: t.overlay,
        borderTopWidth: 1,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      {line ? (
        <Text style={[text.caption, { color: t.ink2, paddingHorizontal: 4 }]}>
          {line}
        </Text>
      ) : null}
      {problem ? (
        <Text style={[text.caption, { color: t.red, paddingHorizontal: 4 }]}>
          {problem}
        </Text>
      ) : null}
      <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
        <TextInput
          accessibilityLabel="Message"
          editable={mayType}
          onChangeText={setMessage}
          onSubmitEditing={send}
          placeholder="Message Claude…"
          placeholderTextColor={t.muted}
          returnKeyType="send"
          style={{
            backgroundColor: t.card,
            borderColor: t.line,
            borderRadius: 22,
            borderWidth: 1,
            color: mayType ? t.ink : t.muted,
            flex: 1,
            fontFamily: fonts.regular,
            fontSize: 15,
            minHeight: 44,
            paddingHorizontal: 14,
          }}
          value={message}
        />
        <IconButton
          color={mayType ? t.onAccent : t.muted}
          disabled={!mayType}
          icon="send"
          label="Send"
          onPress={send}
          tint={mayType ? t.accent : t.overlay}
        />
      </View>
    </View>
  );
}

export function ReadableView({
  hostId,
  note,
  onAnswer,
  sessionId,
}: {
  hostId: string;
  /** Why the session couldn't be opened, if it couldn't. */
  note: string | null;
  /** Show the terminal, where a question is answered. */
  onAnswer: () => void;
  sessionId: string;
}) {
  const { t, text } = useLook();
  const summary = usePhone(
    (state) => state.readable[readableKey(hostId, sessionId)]
  );
  const dialogOpen = usePhone(
    (state) =>
      state.states[hostId]?.sessions.find((one) => one.id === sessionId)
        ?.dialogOpen
  );
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const reduceMotion = useReduceMotion();
  // Following the newest entry, until the person scrolls up to read.
  const following = useRef(true);

  const asking =
    Boolean(dialogOpen) || summary?.entries.at(-1)?.kind === "asking";
  return (
    <View style={{ backgroundColor: t.bg, flex: 1 }}>
      <ScrollView
        accessibilityLabel="Conversation"
        contentContainerStyle={{ gap: 14, padding: 16 }}
        // The newest entry stays in view as entries come, as on the desktop,
        // unless the person scrolled up to read.
        onContentSizeChange={() => {
          if (following.current) {
            scroll.current?.scrollToEnd({ animated: !reduceMotion });
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
        {note ? <Text style={text.caption}>{note}</Text> : null}
        {summary || note ? null : <Text style={text.caption}>Reading…</Text>}
        {summary && summary.entries.length === 0 ? (
          <Text style={text.caption}>Nothing to read yet.</Text>
        ) : null}
        {summary?.entries.map((entry) => (
          <Entry entry={entry} key={entry.seq} onAnswer={onAnswer} />
        ))}
      </ScrollView>
      <Compose asking={asking} hostId={hostId} sessionId={sessionId} />
    </View>
  );
}
