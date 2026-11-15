/**
 * Claude's question answered from the phone: a button for each choice,
 * which sends that choice's number key, and Esc, as the desktop offers them
 * (answerKeys, ADR-0063). Free typing stays off while Claude asks.
 *
 * The computer takes an answer only from a phone whose screen showed the
 * question (a device can't answer what it never saw). The terminal view's
 * screen is on, so its answers go at once and their refusals show there.
 * Elsewhere (the readable view) the screen comes on for the answer: the key
 * waits for the screen, the computer's word on it shows, and the screen
 * goes off again.
 */
import { useState } from "react";
import { View } from "react-native";
import type { SessionQuestion } from "../../../../src/remote/hostSummary.ts";
import {
  type AnswerKey,
  answerKeys,
  decodeScreenFrame,
  receiptLine,
} from "../../../../src/remote/remoteScreen.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { Button } from "../kit.tsx";
import { usePhone } from "../state/phone.ts";
import { wordsOf } from "../state/words.ts";

const utf8 = new TextEncoder();

/** How long an answer waits for the screen and the computer's word. */
const ANSWER_WAIT_MS = 15_000;

/** What came of an answer: its line to show, and whether it went. */
export interface Answered {
  line: string;
  ok: boolean;
}

/**
 * Answer with the screen on for it: show the session's screen, send the key
 * once the screen has come (it shows the question), hear the computer's
 * word on it, then hide the screen again.
 */
function answerSeen(
  hostId: string,
  sessionId: string,
  answer: AnswerKey
): Promise<Answered> {
  const { hideScreen, showScreen } = usePhone.getState();
  return new Promise((resolve) => {
    let sent = false;
    let done = false;
    const finish = (answered: Answered) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      frames.remove();
      hideScreen(hostId, sessionId).catch(() => undefined);
      resolve(answered);
    };
    const frames = KriyonNative.addListener("onScreenFrame", (event) => {
      if (event.hostId !== hostId || event.sessionId !== sessionId) {
        return;
      }
      const frame = decodeScreenFrame(event.frame);
      if (frame?.kind === "screen" && !sent) {
        sent = true;
        KriyonNative.input(hostId, sessionId, utf8.encode(answer.key)).catch(
          (error: unknown) => finish({ line: wordsOf(error), ok: false })
        );
      } else if (frame?.kind === "receipt" && sent) {
        finish(
          frame.written
            ? { line: "Answered.", ok: true }
            : { line: receiptLine(false), ok: false }
        );
      } else if (frame?.kind === "refused") {
        finish({
          line: frame.words || "The other computer refused that.",
          ok: false,
        });
      }
    });
    const timer = setTimeout(
      () =>
        finish({ line: "The computer didn't answer. Try again.", ok: false }),
      ANSWER_WAIT_MS
    );
    showScreen(hostId, sessionId).catch((error: unknown) =>
      finish({ line: wordsOf(error), ok: false })
    );
  });
}

export function Answers({
  hostId,
  onAnswered,
  question,
  screenOn,
  sessionId,
}: {
  hostId: string;
  /** What came of an answer, to show: a refusal, or how it went. */
  onAnswered: (answered: Answered) => void;
  /** The question as the computer sent it; `null` when its choices aren't
   *  known (a permission prompt), which offers the first numbers. */
  question: Pick<SessionQuestion, "options"> | null | undefined;
  /** The session's screen shows here already (the terminal view). */
  screenOn: boolean;
  sessionId: string;
}) {
  const [answering, setAnswering] = useState(false);
  const pick = (answer: AnswerKey) => {
    if (screenOn) {
      KriyonNative.input(hostId, sessionId, utf8.encode(answer.key)).catch(
        (error: unknown) => onAnswered({ line: wordsOf(error), ok: false })
      );
      return;
    }
    // One answer at a time while the screen comes for it.
    setAnswering(true);
    answerSeen(hostId, sessionId, answer)
      .then(onAnswered)
      .finally(() => setAnswering(false));
  };
  return (
    <View
      accessibilityLabel="Answers"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
    >
      {answerKeys(
        question ? { options: question.options, text: "" } : null
      ).map((answer) => (
        <Button
          disabled={answering}
          key={answer.label}
          kind={answer.key === "\u001b" ? "ghost" : "amber"}
          label={answer.label}
          onPress={() => pick(answer)}
        />
      ))}
    </View>
  );
}
