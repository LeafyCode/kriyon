import { structuredTurns, submitPrompt } from "../ipc/bridge.ts";
import { useAttachments } from "../state/attachments.ts";
import { useDrafts } from "../state/drafts.ts";
import { type SentPrompt, useSentPrompts } from "../state/sentPrompts.ts";
import { showToast, type ToastKind } from "../ui/Toast.tsx";
import { followCliDialog } from "./cliDialog.ts";
import { sentSettled } from "./sentPrompt.ts";

/**
 * Sending the composer's message: the backend types it the way the CLI takes
 * it — text, `@` mentions, pasted image paths, each image given time to be
 * read — then a standalone Enter (ADR-0037). That takes from a fraction of a
 * second to a few, so a session's sends are typed one after another, and an
 * Esc waits for the one in flight ({@link untilSent}): keys landing in the
 * middle of a message would garble it.
 *
 * A [Sent prompt] is then kept until it settles ({@link settleWhenDone}),
 * whichever view is on screen: the composer's Stop and Esc lean on it too.
 */

/** Per session, the newest send; it settles once every earlier one has. */
const inFlight = new Map<string, Promise<void>>();

/** How often the turns are read for a [Sent prompt] waiting to settle. */
const SETTLE_POLL_MS = 1000;

/**
 * Clear `sent` once it is done with: Claude started on its turn, it grew too
 * old ({@link sentSettled}), or a [CLI dialog] that opened after it closed —
 * a slash command's menu closed with Esc writes no turn at all (ADR-0040).
 * Stops by itself once `sent` is no longer the session's sent prompt (taken
 * back, handed back, or replaced by a newer send).
 */
function settleWhenDone(sessionId: string, sent: SentPrompt): void {
  const isCurrent = () => useSentPrompts.getState().sent[sessionId] === sent;
  let dialogOpened = false;
  const stops: (() => void)[] = [];
  const stop = () => {
    for (const each of stops.splice(0)) {
      each();
    }
  };
  const settle = () => {
    stop();
    if (isCurrent()) {
      useSentPrompts.getState().clear(sessionId);
    }
  };
  stops.push(
    followCliDialog(sessionId, (open) => {
      if (open) {
        dialogOpened = true;
      } else if (dialogOpened) {
        settle();
      }
    })
  );
  const check = () =>
    structuredTurns(sessionId)
      .catch(() => null)
      .then((turns) => {
        if (isCurrent() && sentSettled(sent, turns, Date.now())) {
          settle();
        }
      });
  const timer = window.setInterval(check, SETTLE_POLL_MS);
  stops.push(() => window.clearInterval(timer));
  stops.push(
    useSentPrompts.subscribe((state) => {
      if (state.sent[sessionId] !== sent) {
        stop();
      }
    })
  );
}

/** Put a [Sent prompt] back in the composer: its attachments and its draft. */
export function handBack(
  sessionId: string,
  sent: SentPrompt,
  message: string,
  kind?: ToastKind
): void {
  if (useSentPrompts.getState().sent[sessionId] === sent) {
    useSentPrompts.getState().clear(sessionId);
  }
  useAttachments.getState().add(sessionId, sent.attachments);
  if (sent.draft.length > 0) {
    useDrafts.getState().requestInsert(sessionId, sent.draft);
  }
  showToast(message, kind);
}

/** Send `sent` to the session's terminal. Noted at once, for the
 *  [Structured view]; handed back to the composer if it can't be typed. */
export function sendPrompt(sessionId: string, sent: SentPrompt): void {
  useSentPrompts.getState().note(sessionId, sent);
  const noted = useSentPrompts.getState().sent[sessionId] ?? sent;
  settleWhenDone(sessionId, noted);
  const type = () =>
    submitPrompt(
      sessionId,
      noted.text,
      noted.attachments.map((a) => a.path)
    );
  const previous = inFlight.get(sessionId);
  // Nothing ahead of it: typed now, not a tick later.
  const typing = (
    previous === undefined ? Promise.resolve(type()) : previous.then(type)
  )
    .catch((error) => {
      handBack(
        sessionId,
        noted,
        `Couldn't send: ${String(error)}. Your message is back in the composer.`,
        "error"
      );
    })
    .finally(() => {
      if (inFlight.get(sessionId) === typing) {
        inFlight.delete(sessionId);
      }
    });
  inFlight.set(sessionId, typing);
}

/** Resolves once every send to the session so far has been typed (or has
 *  failed); `null` when none is being typed. */
export function untilSent(sessionId: string): Promise<void> | null {
  return inFlight.get(sessionId) ?? null;
}
