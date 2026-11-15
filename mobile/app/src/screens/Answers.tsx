/**
 * Claude's question answered from the phone: a button for each choice,
 * which sends that choice's number key, and Esc, as the desktop offers them
 * (answerKeys, ADR-0063). Free typing stays off while Claude asks; the
 * computer refuses a key from a phone whose screen hadn't drawn the
 * question, and that refusal shows in its words.
 */
import { View } from "react-native";
import type { SessionQuestion } from "../../../../src/remote/hostSummary.ts";
import {
  type AnswerKey,
  answerKeys,
} from "../../../../src/remote/remoteScreen.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { Button } from "../kit.tsx";

const utf8 = new TextEncoder();

/** Send one answer's key to the session; `onError` hears why it didn't go. */
function sendAnswer(
  hostId: string,
  sessionId: string,
  answer: AnswerKey,
  onError: (reason: string) => void
): void {
  KriyonNative.input(hostId, sessionId, utf8.encode(answer.key)).catch(
    (error: unknown) =>
      onError(error instanceof Error ? error.message : String(error))
  );
}

export function Answers({
  hostId,
  onError,
  question,
  sessionId,
}: {
  hostId: string;
  onError: (reason: string) => void;
  /** The question as the computer sent it; `null` when its choices aren't
   *  known (a permission prompt), which offers the first numbers. */
  question: Pick<SessionQuestion, "options"> | null | undefined;
  sessionId: string;
}) {
  return (
    <View
      accessibilityLabel="Answers"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
    >
      {answerKeys(
        question ? { options: question.options, text: "" } : null
      ).map((answer) => (
        <Button
          key={answer.label}
          kind={answer.key === "\u001b" ? "ghost" : "amber"}
          label={answer.label}
          onPress={() => sendAnswer(hostId, sessionId, answer, onError)}
        />
      ))}
    </View>
  );
}
