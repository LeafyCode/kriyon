import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type RelayView,
  type RemoteStatus,
  relayView,
  remoteDevices,
  remoteEnterCode,
  remoteHostForget,
  remoteHostPair,
  remoteHosts,
  remotePairingQr,
  remoteRemoveDevice,
  remoteRenameDevice,
  remoteSetDeviceRole,
  remoteSetEnabled,
  remoteSetPort,
  remoteStartPairing,
  remoteStatus,
} from "../ipc/bridge.ts";
import { RELAY_CONSENT_LINE } from "../state/relay.ts";
import { CONSENT_LINES, useRemote } from "../state/remote.ts";
import { useRemoteHosts } from "../state/remoteHosts.ts";
import { RemoteSection } from "./RemoteSection.tsx";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  onRemoteCodeWanted: vi.fn(() => Promise.resolve(() => undefined)),
  remoteHostForget: vi.fn(),
  remoteHostPair: vi.fn(),
  remoteHosts: vi.fn(),
  remoteDevices: vi.fn(),
  remoteEnterCode: vi.fn(),
  remotePairingQr: vi.fn(),
  remoteRemoveDevice: vi.fn(),
  remoteRenameDevice: vi.fn(),
  remoteSetDeviceRole: vi.fn(),
  remoteSetEnabled: vi.fn(),
  remoteSetPort: vi.fn(),
  remoteStartPairing: vi.fn(),
  remoteStatus: vi.fn(),
  remoteStopPairing: vi.fn(),
  relayView: vi.fn(),
}));

const EXPIRED = /QR code expired/;
const QR_CODE = /QR code/;
const COUNTDOWN = /^[45]:\d\d$/;
const SHELL_ACCESS = /full shell access as you/;
const NAMED_BY_DEVICE = /named by the device/;
const RECONNECTS = /reconnects/;
const DARK_MODULE = /h1v1h-1z/g;
const TYPE_THIS_CODE = /Type this code on the other computer/;

const off: RemoteStatus = {
  enabled: false,
  hostId: null,
  pairing: { state: "idle" },
  port: 49_731,
  routes: null,
};
const on: RemoteStatus = { ...off, enabled: true, hostId: "ab".repeat(32) };
const phone = {
  id: "cd".repeat(32),
  name: "Test phone",
  pairedAt: Date.UTC(2026, 10, 13),
  role: "viewer" as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  useRemote.setState(useRemote.getInitialState());
  useRemoteHosts.setState(useRemoteHosts.getInitialState());
  vi.mocked(remoteStatus).mockResolvedValue(off);
  vi.mocked(remoteDevices).mockResolvedValue([]);
  vi.mocked(remoteHosts).mockResolvedValue([]);
  vi.mocked(relayView).mockResolvedValue(noRelay);
});

const noRelay: RelayView = {
  available: false,
  on: false,
  passExpiresAt: null,
  problem: null,
  signedIn: false,
  signIn: null,
};

test("the consent screen says nothing of our relay unless it is on", async () => {
  render(<RemoteSection />);
  fireEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
  expect((await screen.findByRole("dialog")).textContent).not.toContain(
    RELAY_CONSENT_LINE
  );
});

test("with our relay on, the consent screen says what passes through it", async () => {
  vi.mocked(relayView).mockResolvedValue({
    ...noRelay,
    available: true,
    on: true,
  });
  render(<RemoteSection />);
  await screen.findByLabelText("Our relay (paid)");
  fireEvent.click(screen.getByRole("switch", { name: "Remote access" }));
  expect((await screen.findByRole("dialog")).textContent).toContain(
    RELAY_CONSENT_LINE
  );
});

test("turning on shows the consent screen, and Cancel leaves it off", async () => {
  render(<RemoteSection />);
  fireEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
  const dialog = await screen.findByRole("dialog");
  for (const line of CONSENT_LINES) {
    expect(dialog.textContent).toContain(line);
  }
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(remoteSetEnabled).not.toHaveBeenCalled();
});

test("Turn on on the consent screen turns it on", async () => {
  vi.mocked(remoteSetEnabled).mockResolvedValue(on);
  render(<RemoteSection />);
  fireEvent.click(await screen.findByRole("switch", { name: "Remote access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(remoteSetEnabled).toHaveBeenCalledWith(true));
  expect(
    await screen.findByRole("button", { name: "Pair a device" })
  ).toBeTruthy();
});

test("with it off, there is no pairing", async () => {
  render(<RemoteSection />);
  await screen.findByRole("switch", { name: "Remote access" });
  expect(screen.queryByRole("button", { name: "Pair a device" })).toBeNull();
});

test("a paired device can be removed while remote access is off", async () => {
  // A stolen phone must not need the door opened to be removed.
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  render(<RemoteSection />);
  expect(
    await screen.findByRole("button", { name: "Remove Test phone" })
  ).toBeTruthy();
});

test("choosing the role a device already has changes nothing", async () => {
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  render(<RemoteSection />);
  const group = await screen.findByRole("tablist", {
    name: "Role of Test phone",
  });
  fireEvent.click(
    Array.from(group.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Viewer"
    ) as HTMLElement
  );
  expect(remoteSetDeviceRole).not.toHaveBeenCalled();
});

test("a code the field refuses stays there to be fixed", async () => {
  vi.mocked(remoteStatus).mockResolvedValue({
    ...on,
    pairing: {
      deviceName: "Test phone",
      expiresAtMs: Date.now() + 200_000,
      role: "viewer",
      state: "codeWanted",
    },
  });
  render(<RemoteSection />);
  const field = await screen.findByRole("textbox", { name: "Pairing code" });
  fireEvent.change(field, { target: { value: "12345" } });
  fireEvent.submit(field);
  expect(await screen.findByText("The code is six digits.")).toBeTruthy();
  expect((field as HTMLInputElement).value).toBe("12345");
});

test("a Controller is paired only after the shell-access warning shows", async () => {
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteStartPairing).mockResolvedValue("kriyon-pair:1:00");
  vi.mocked(remotePairingQr).mockResolvedValue({ dark: "1001", size: 2 });
  render(<RemoteSection />);
  const viewer = await screen.findByRole("tab", { name: "Viewer" });
  expect(viewer.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Controller" }));
  expect(screen.getByText(SHELL_ACCESS)).toBeTruthy();
  vi.mocked(remoteStatus).mockResolvedValue({
    ...on,
    pairing: {
      expiresAtMs: Date.now() + 300_000,
      role: "controller",
      state: "waiting",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Pair a device" }));
  await waitFor(() =>
    expect(remoteStartPairing).toHaveBeenCalledWith("controller")
  );
  const code = await screen.findByRole("img", { name: QR_CODE });
  // "1001": two dark modules, drawn as two unit squares in one path.
  const d = code.querySelector("path")?.getAttribute("d") ?? "";
  expect(d.match(DARK_MODULE)?.length).toBe(2);
  expect(screen.getByText(COUNTDOWN)).toBeTruthy();
});

test("the device that took the pairing is named as it named itself, and its code is asked for", async () => {
  vi.mocked(remoteStatus).mockResolvedValue({
    ...on,
    pairing: {
      deviceName: "Test phone",
      expiresAtMs: Date.now() + 200_000,
      role: "viewer",
      state: "codeWanted",
    },
  });
  vi.mocked(remoteEnterCode).mockResolvedValue({
    outcome: "wrong",
    triesLeft: 2,
  });
  render(<RemoteSection />);
  expect(await screen.findByText("Test phone")).toBeTruthy();
  expect(screen.getByText(NAMED_BY_DEVICE)).toBeTruthy();
  const field = screen.getByRole("textbox", { name: "Pairing code" });
  fireEvent.change(field, { target: { value: "123456" } });
  fireEvent.submit(field);
  await waitFor(() => expect(remoteEnterCode).toHaveBeenCalledWith("123456"));
  expect(
    await screen.findByText("That code is wrong. 2 tries left.")
  ).toBeTruthy();
});

test("an expired pairing says so and offers to start again", async () => {
  vi.mocked(remoteStatus).mockResolvedValue({
    ...on,
    pairing: { state: "expired" },
  });
  render(<RemoteSection />);
  expect(await screen.findByText(EXPIRED)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pair a device" })).toBeTruthy();
});

test("a paired device can be renamed inline", async () => {
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  vi.mocked(remoteRenameDevice).mockResolvedValue();
  render(<RemoteSection />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Rename Test phone" })
  );
  const field = screen.getByRole("textbox", { name: "Name for Test phone" });
  fireEvent.change(field, { target: { value: "Work phone" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(remoteRenameDevice).toHaveBeenCalledWith(phone.id, "Work phone")
  );
});

test("Escape leaves a rename without saving", async () => {
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  render(<RemoteSection />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Rename Test phone" })
  );
  const field = screen.getByRole("textbox", { name: "Name for Test phone" });
  fireEvent.keyDown(field, { key: "Escape" });
  expect(
    screen.queryByRole("textbox", { name: "Name for Test phone" })
  ).toBeNull();
  expect(remoteRenameDevice).not.toHaveBeenCalled();
});

test("changing a device's role says it reconnects", async () => {
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  vi.mocked(remoteSetDeviceRole).mockResolvedValue();
  render(<RemoteSection />);
  const group = await screen.findByRole("tablist", {
    name: "Role of Test phone",
  });
  expect(screen.getByText(RECONNECTS)).toBeTruthy();
  fireEvent.click(
    Array.from(group.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Controller"
    ) as HTMLElement
  );
  await waitFor(() =>
    expect(remoteSetDeviceRole).toHaveBeenCalledWith(phone.id, "controller")
  );
});

test("removing a device asks first", async () => {
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  vi.mocked(remoteRemoveDevice).mockResolvedValue();
  render(<RemoteSection />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove Test phone" })
  );
  expect(remoteRemoveDevice).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Test phone");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(remoteRemoveDevice).toHaveBeenCalledWith(phone.id)
  );
});

test("this computer pairs with another from its pasted code, with remote access off", async () => {
  vi.mocked(remoteHostPair).mockResolvedValue("654321");
  render(<RemoteSection />);
  const field = await screen.findByRole("textbox", {
    name: "Pairing code from the other computer",
  });
  fireEvent.change(field, { target: { value: "kriyon-pair:1:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(remoteHostPair).toHaveBeenCalledWith("kriyon-pair:1:00")
  );
  expect(await screen.findByText("654321")).toBeTruthy();
  expect(screen.getByText(TYPE_THIS_CODE)).toBeTruthy();
});

test("a paired computer is listed and can be forgotten", async () => {
  vi.mocked(remoteHosts).mockResolvedValue([
    { hostId: "ab".repeat(32), name: "Studio", pairedAt: 0 },
  ]);
  vi.mocked(remoteHostForget).mockResolvedValue();
  render(<RemoteSection />);
  await useRemoteHosts.getState().load();
  fireEvent.click(await screen.findByRole("button", { name: "Forget Studio" }));
  await waitFor(() =>
    expect(remoteHostForget).toHaveBeenCalledWith("ab".repeat(32))
  );
});

test("a pairing can be copied as text for a computer that can't scan", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  vi.mocked(remoteStatus).mockResolvedValue({
    ...on,
    pairing: {
      expiresAtMs: Date.now() + 300_000,
      role: "viewer",
      state: "waiting",
    },
  });
  useRemote.setState({
    qr: { dark: "1", size: 1 },
    qrText: "kriyon-pair:1:ab",
  });
  render(<RemoteSection />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Copy pairing code" })
  );
  expect(writeText).toHaveBeenCalledWith("kriyon-pair:1:ab");
});

test("while on, it says which ways devices can reach it, and why the port isn't the chosen one", async () => {
  vi.mocked(remoteStatus).mockResolvedValue({
    ...on,
    routes: {
      portNote: "Port 49731 is in use by another program.",
      relay: false,
      tailscale: ["100.101.102.103"],
    },
  });
  render(<RemoteSection />);
  expect(
    await screen.findByText(
      "Reachable over: this network, Tailscale (100.101.102.103)."
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText("Port 49731 is in use by another program.")
  ).toBeInTheDocument();
});

test("the port can be changed, and only a whole number is sent", async () => {
  vi.mocked(remoteStatus).mockResolvedValue({
    ...on,
    routes: { portNote: null, relay: false, tailscale: [] },
  });
  vi.mocked(remoteSetPort).mockResolvedValue({
    ...on,
    port: 50_000,
    routes: { portNote: null, relay: false, tailscale: [] },
  });
  render(<RemoteSection />);
  const field = await screen.findByRole("spinbutton", { name: "Port" });
  expect(field).toHaveValue(49_731);
  fireEvent.change(field, { target: { value: "50000" } });
  fireEvent.click(screen.getByRole("button", { name: "Use this port" }));
  await waitFor(() => expect(remoteSetPort).toHaveBeenCalledWith(50_000));
});
