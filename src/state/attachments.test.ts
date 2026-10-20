import { beforeEach, expect, test } from "vitest";
import type { Attachment } from "../ipc/bridge.ts";
import { useAttachments } from "./attachments.ts";

const a = (path: string): Attachment => ({
  bytes: 1,
  caution: null,
  convertedFrom: null,
  kind: "image",
  name: path.split("/").pop() ?? path,
  path,
});

beforeEach(() => useAttachments.setState({ bySession: {} }));

test("attachments are per session, deduped by path, and removable", () => {
  const store = useAttachments.getState();
  store.add("s1", [a("/x.png"), a("/y.png")]);
  store.add("s1", [a("/x.png")]);
  store.add("s2", [a("/z.png")]);
  expect(useAttachments.getState().bySession.s1?.map((x) => x.path)).toEqual([
    "/x.png",
    "/y.png",
  ]);
  store.remove("s1", "/x.png");
  expect(useAttachments.getState().bySession.s1?.map((x) => x.path)).toEqual([
    "/y.png",
  ]);
  store.clear("s1");
  expect(useAttachments.getState().bySession.s1).toBeUndefined();
  expect(useAttachments.getState().bySession.s2).toHaveLength(1);
});
