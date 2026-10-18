import type { ClipboardEvent } from "react";
import { useEffect, useState } from "react";
import {
  type Attachment,
  clipboardAttachments,
  onAttachmentDrag,
  pickAttachments,
  savePastedImage,
} from "../ipc/bridge.ts";
import { onEvent } from "../ipc/onEvent.ts";
import { useAttachments } from "../state/attachments.ts";
import { showToast } from "../ui/Toast.tsx";

/**
 * The three ways an [Attachment] reaches the composer: the + button's file
 * picker, a paste (files copied in Finder, or a screenshot), and a drop on
 * the window. Every path is admitted by the backend first (ADR-0037).
 */

function added(sessionId: string, attachments: Attachment[]): void {
  if (attachments.length === 0) {
    return;
  }
  useAttachments.getState().add(sessionId, attachments);
  const warned = attachments.find((a) => a.caution !== null);
  if (warned?.caution) {
    showToast(`${warned.name}: ${warned.caution}`, "error");
  }
  const converted = attachments.filter((a) => a.convertedFrom !== null);
  if (converted.length > 0) {
    showToast(convertedNote(converted));
  }
}

/** "Converted IMG_1.heic to JPEG so Claude can see it." — what Kriyon did
 *  to a picture Claude can't view, said plainly. */
export function convertedNote(converted: Attachment[]): string {
  const [first] = converted;
  if (converted.length === 1 && first) {
    const to = first.name.split(".").pop()?.toUpperCase() ?? "a picture";
    return `Converted ${first.convertedFrom} to ${to === "JPG" ? "JPEG" : to} so Claude can see it.`;
  }
  return `Converted ${converted.length} pictures to JPEG or PNG so Claude can see them.`;
}

/** What a paste holds, read while the paste event is live. */
export interface PastedFiles {
  files: File[];
  /** `file://` URLs the pasteboard named (a Finder copy). */
  fileUrls: string[];
}

const LINE_BREAK = /\r?\n/;

/** Read a paste's files: `null` when it holds none (a text paste). */
export function pastedFiles(data: DataTransfer): PastedFiles | null {
  const files = Array.from(data.files);
  const types = Array.from(data.types);
  const fileUrls = types.includes("text/uri-list")
    ? data
        .getData("text/uri-list")
        .split(LINE_BREAK)
        .filter((u) => u.startsWith("file://"))
    : [];
  if (files.length === 0 && fileUrls.length === 0 && !types.includes("Files")) {
    return null;
  }
  return { fileUrls, files };
}

/** Whether a paste is of files someone copied (in Finder), not of a picture
 *  (a screenshot). A copied file brings its icon along as an image, which
 *  must never be attached in the file's place. */
export function isFileCopy(pasted: PastedFiles): boolean {
  return (
    pasted.fileUrls.length > 0 ||
    pasted.files.some((f) => !f.type.startsWith("image/"))
  );
}

/** Files on the clipboard: Finder's copy names real files; otherwise any
 *  pasted image (a screenshot) is saved and attached. */
async function intakeClipboard(
  sessionId: string,
  pasted: PastedFiles
): Promise<void> {
  const fromFinder = await clipboardAttachments().catch(() => []);
  if (fromFinder.length > 0) {
    added(sessionId, fromFinder);
    return;
  }
  if (isFileCopy(pasted)) {
    // Never the picture a copied file brings along: that is its icon.
    showToast("Couldn't read the copied file. Drag it in or use +.", "error");
    return;
  }
  const images = pasted.files.filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) {
    showToast("Couldn't attach that. Drag it in or use +.", "error");
    return;
  }
  const saved: Attachment[] = [];
  for (const image of images) {
    try {
      saved.push(
        // biome-ignore lint/performance/noAwaitInLoops: attachments keep the order they were pasted in.
        await savePastedImage(new Uint8Array(await image.arrayBuffer()))
      );
    } catch (error) {
      showToast(String(error), "error");
    }
  }
  added(sessionId, saved);
}

export interface AttachmentIntake {
  /** A drag of files is over the window and the composer will take it. */
  dragging: boolean;
  /** Take a paste of files or images as attachments. Returns whether it
   *  did; text is left to the caller. */
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => boolean;
  /** Open the file picker. */
  pick: () => void;
}

export function useAttachmentIntake(
  sessionId: string | null,
  enabled: boolean
): AttachmentIntake {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!(enabled && sessionId)) {
      setDragging(false);
      return;
    }
    return onEvent(onAttachmentDrag, (drag) => {
      setDragging(drag.phase === "over");
      if (drag.phase === "drop") {
        added(sessionId, drag.attachments);
      }
    });
  }, [enabled, sessionId]);

  function onPaste(event: ClipboardEvent<HTMLDivElement>): boolean {
    if (!sessionId) {
      return false;
    }
    const pasted = pastedFiles(event.clipboardData);
    if (pasted === null) {
      return false;
    }
    event.preventDefault();
    intakeClipboard(sessionId, pasted).catch(() => undefined);
    return true;
  }

  function pick(): void {
    if (!sessionId) {
      return;
    }
    pickAttachments()
      .then((chosen) => added(sessionId, chosen))
      .catch((error) => showToast(String(error), "error"));
  }

  return { dragging, onPaste, pick };
}
