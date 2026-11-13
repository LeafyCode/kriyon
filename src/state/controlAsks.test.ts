import { beforeEach, expect, test, vi } from "vitest";
import { remoteLetDeviceType } from "../ipc/bridge.ts";
import { ASK_SHOWN_MS, useControlAsks } from "./controlAsks.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  remoteLetDeviceType: vi.fn(),
}));

const ask = { deviceId: "ab".repeat(32), deviceName: "Phone", sessionId: "s1" };

beforeEach(() => {
  vi.resetAllMocks();
  useControlAsks.setState(useControlAsks.getInitialState());
});

test("a device that asked to type is shown once, newest first", () => {
  useControlAsks.getState().asked(ask, 1000);
  useControlAsks.getState().asked(ask, 2000);
  useControlAsks
    .getState()
    .asked({ ...ask, deviceName: "Tablet", deviceId: "cd".repeat(32) }, 3000);
  const asks = useControlAsks.getState().current(3000);
  expect(asks.map((one) => one.deviceName)).toEqual(["Tablet", "Phone"]);
});

test("an ask goes after a while unanswered", () => {
  useControlAsks.getState().asked(ask, 1000);
  expect(useControlAsks.getState().current(1000 + ASK_SHOWN_MS)).toEqual([]);
});

test("letting it type asks Rust and clears the ask; a refusal says why", async () => {
  vi.mocked(remoteLetDeviceType).mockResolvedValue();
  useControlAsks.getState().asked(ask, 1000);
  await useControlAsks.getState().letType(ask);
  expect(remoteLetDeviceType).toHaveBeenCalledWith("s1", "ab".repeat(32));
  expect(useControlAsks.getState().current(1000)).toEqual([]);

  vi.mocked(remoteLetDeviceType).mockRejectedValue(
    "That device isn't connected now."
  );
  useControlAsks.getState().asked(ask, 1000);
  await useControlAsks.getState().letType(ask);
  expect(useControlAsks.getState().error).toBe(
    "That device isn't connected now."
  );
});

test("not now clears it without asking Rust", () => {
  useControlAsks.getState().asked(ask, 1000);
  useControlAsks.getState().dismiss(ask);
  expect(useControlAsks.getState().current(1000)).toEqual([]);
  expect(remoteLetDeviceType).not.toHaveBeenCalled();
});
