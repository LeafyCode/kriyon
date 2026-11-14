import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { remoteLetDeviceType } from "../ipc/bridge.ts";
import { useControlAsks } from "../state/controlAsks.ts";
import { ControlAsks } from "./ControlAsks.tsx";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  remoteLetDeviceType: vi.fn(),
}));

const WANTS = /Phone wants to type/;

const ask = { deviceId: "ab".repeat(32), deviceName: "Phone", sessionId: "s1" };

beforeEach(() => {
  vi.resetAllMocks();
  useControlAsks.setState(useControlAsks.getInitialState());
});

test("shows nothing until a device asks", () => {
  const { container } = render(<ControlAsks />);
  expect(container).toBeEmptyDOMElement();
});

test("lets the asking device type, or not now", () => {
  vi.mocked(remoteLetDeviceType).mockResolvedValue();
  useControlAsks.getState().asked(ask, Date.now());
  render(<ControlAsks />);
  expect(screen.getByText(WANTS)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Let Phone type" }));
  expect(remoteLetDeviceType).toHaveBeenCalledWith("s1", "ab".repeat(32));
  expect(screen.queryByText(WANTS)).toBeNull();

  act(() => useControlAsks.getState().asked(ask, Date.now()));
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByText(WANTS)).toBeNull();
  expect(remoteLetDeviceType).toHaveBeenCalledTimes(1);
});
