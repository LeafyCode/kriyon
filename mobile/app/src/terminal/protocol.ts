/** What the terminal page tells the app (see page.ts). */
import type { ScreenNote } from "../../../../src/remote/remoteScreen.ts";

export type PageMessage =
  | { type: "ready" }
  | { note: ScreenNote; type: "note" };

/** A message from the page, or `null` for anything else. */
export function readPageMessage(text: string): PageMessage | null {
  try {
    const message = JSON.parse(text) as PageMessage;
    switch (message?.type) {
      case "ready":
        return message;
      case "note":
        return message.note ? message : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
