import { beforeEach, expect, test, vi } from "vitest";
import { remoteLetDeviceType } from "../ipc/bridge.ts";
import { showToast } from "../ui/Toast.tsx";
import { ASK_SHOWN_MS, useControlAsks } from "./controlAsks.ts";

vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));

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

test("letting it type asks Rust and clears the ask", async () => {
  vi.mocked(remoteLetDeviceType).mockResolvedValue();
  useControlAsks.getState().asked(ask, 1000);
  await useControlAsks.getState().letType(ask);
  expect(remoteLetDeviceType).toHaveBeenCalledWith("s1", "ab".repeat(32));
  expect(useControlAsks.getState().current(1000)).toEqual([]);
  expect(showToast).not.toHaveBeenCalled();
});

test("every refusal says why, the same one twice too", async () => {
  vi.mocked(remoteLetDeviceType).mockRejectedValue("Not watching.");
  await useControlAsks.getState().letType(ask);
  await useControlAsks.getState().letType(ask);
  expect(showToast).toHaveBeenCalledTimes(2);
  expect(showToast).toHaveBeenLastCalledWith("Not watching.", "error");
});

test("pruning forgets asks no longer shown", () => {
  useControlAsks.getState().asked(ask, 1000);
  useControlAsks.getState().prune(1000 + ASK_SHOWN_MS);
  expect(useControlAsks.getState().asks).toEqual([]);
});

test("not now clears it without asking Rust", () => {
  useControlAsks.getState().asked(ask, 1000);
  useControlAsks.getState().dismiss(ask);
  expect(useControlAsks.getState().current(1000)).toEqual([]);
  expect(remoteLetDeviceType).not.toHaveBeenCalled();
});
