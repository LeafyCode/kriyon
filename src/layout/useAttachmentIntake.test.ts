import { expect, test } from "vitest";
import type { Attachment } from "../ipc/bridge.ts";
import {
  convertedNote,
  isFileCopy,
  pastedFiles,
} from "./useAttachmentIntake.ts";

const copy = (name: string, from: string): Attachment => ({
  bytes: 1,
  caution: null,
  convertedFrom: from,
  kind: "image",
  name,
  path: `/a/${name}`,
});

test("a converted picture is named, with what it became", () => {
  expect(convertedNote([copy("IMG_1.jpg", "IMG_1.HEIC")])).toBe(
    "Converted IMG_1.HEIC to JPEG so Claude can see it."
  );
  expect(convertedNote([copy("scan.png", "scan.tiff")])).toBe(
    "Converted scan.tiff to PNG so Claude can see it."
  );
  expect(convertedNote([copy("a.jpg", "a.heic"), copy("b.png", "b.bmp")])).toBe(
    "Converted 2 pictures to JPEG or PNG so Claude can see them."
  );
});

const transfer = (types: string[], files: File[], uriList = ""): DataTransfer =>
  ({
    files,
    getData: (type: string) => (type === "text/uri-list" ? uriList : ""),
    types,
  }) as unknown as DataTransfer;

test("a Finder copy is files, never the icon that comes along with it", () => {
  const icon = new File([""], "image.tiff", { type: "image/tiff" });
  const copy = pastedFiles(
    transfer(["Files", "text/uri-list"], [icon], "file:///a/slip.pdf\r\n")
  );
  expect(copy?.fileUrls).toEqual(["file:///a/slip.pdf"]);
  expect(copy && isFileCopy(copy)).toBe(true);
  const pdf = pastedFiles(
    transfer(
      ["Files"],
      [new File([""], "slip.pdf", { type: "application/pdf" })]
    )
  );
  expect(pdf && isFileCopy(pdf)).toBe(true);
});

test("a screenshot is a picture, and text is no files at all", () => {
  const shot = pastedFiles(
    transfer(["Files"], [new File([""], "image.png", { type: "image/png" })])
  );
  expect(shot && isFileCopy(shot)).toBe(false);
  expect(pastedFiles(transfer(["text/plain"], []))).toBeNull();
});
