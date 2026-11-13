import { beforeEach, expect, test, vi } from "vitest";
import {
  type RemoteStatus,
  remoteDevices,
  remoteEnterCode,
  remotePairingQr,
  remoteRemoveDevice,
  remoteRenameDevice,
  remoteSetDeviceRole,
  remoteSetEnabled,
  remoteStartPairing,
  remoteStatus,
  remoteStopPairing,
} from "../ipc/bridge.ts";
import {
  CONSENT_LINES,
  codeResultLine,
  countdownText,
  useRemote,
} from "./remote.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  remoteDevices: vi.fn(),
  remoteEnterCode: vi.fn(),
  remotePairingQr: vi.fn(),
  remoteRemoveDevice: vi.fn(),
  remoteRenameDevice: vi.fn(),
  remoteSetDeviceRole: vi.fn(),
  remoteSetEnabled: vi.fn(),
  remoteStartPairing: vi.fn(),
  remoteStatus: vi.fn(),
  remoteStopPairing: vi.fn(),
}));

/** Words the consent copy must not use: hosts aren't only Macs, and there is
 *  no relay yet. */
const PROMISES_TOO_MUCH = /Mac|relay/;

const off: RemoteStatus = {
  enabled: false,
  hostId: null,
  pairing: { state: "idle" },
};
const on: RemoteStatus = { ...off, enabled: true, hostId: "ab".repeat(32) };
const phone = {
  id: "cd".repeat(32),
  name: "Test phone",
  pairedAt: 1_700_000_000_000,
  role: "viewer" as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  useRemote.setState(useRemote.getInitialState());
  vi.mocked(remoteStatus).mockResolvedValue(off);
  vi.mocked(remoteDevices).mockResolvedValue([]);
});

test("loading reads the switch and the paired devices", async () => {
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  await useRemote.getState().load();
  expect(useRemote.getState().status).toEqual(on);
  expect(useRemote.getState().devices).toEqual([phone]);
});

test("turning on asks first, and only turns on after consent", async () => {
  useRemote.getState().askToTurnOn();
  expect(useRemote.getState().consentOpen).toBe(true);
  expect(remoteSetEnabled).not.toHaveBeenCalled();

  useRemote.getState().cancelConsent();
  expect(useRemote.getState().consentOpen).toBe(false);
  expect(remoteSetEnabled).not.toHaveBeenCalled();

  vi.mocked(remoteSetEnabled).mockResolvedValue(on);
  useRemote.getState().askToTurnOn();
  await useRemote.getState().turnOn();
  expect(remoteSetEnabled).toHaveBeenCalledWith(true);
  expect(useRemote.getState().consentOpen).toBe(false);
  expect(useRemote.getState().status).toEqual(on);
});

test("turning on is refused without the consent screen open", async () => {
  await useRemote.getState().turnOn();
  expect(remoteSetEnabled).not.toHaveBeenCalled();
});

test("turning off needs no consent, and drops the QR code", async () => {
  useRemote.setState({ qr: { dark: "1", size: 1 }, status: on });
  vi.mocked(remoteSetEnabled).mockResolvedValue(off);
  await useRemote.getState().turnOff();
  expect(remoteSetEnabled).toHaveBeenCalledWith(false);
  expect(useRemote.getState().qr).toBeNull();
  expect(useRemote.getState().status).toEqual(off);
});

test("a failure to turn on is shown, and the switch stays off", async () => {
  vi.mocked(remoteSetEnabled).mockRejectedValue(
    "remote access needs macOS or Linux for now"
  );
  useRemote.getState().askToTurnOn();
  await useRemote.getState().turnOn();
  expect(useRemote.getState().error).toContain("needs macOS or Linux");
  expect(useRemote.getState().status).toBeNull();
});

test("pairing fetches the QR code for the invite Rust made", async () => {
  vi.mocked(remoteStartPairing).mockResolvedValue("kriyon-pair:1:00");
  vi.mocked(remotePairingQr).mockResolvedValue({ dark: "1010", size: 2 });
  const waiting: RemoteStatus = {
    ...on,
    pairing: { expiresAtMs: 1, role: "controller", state: "waiting" },
  };
  vi.mocked(remoteStatus).mockResolvedValue(waiting);
  await useRemote.getState().startPairing("controller");
  expect(remoteStartPairing).toHaveBeenCalledWith("controller");
  expect(remotePairingQr).toHaveBeenCalledWith("kriyon-pair:1:00");
  expect(useRemote.getState().qr).toEqual({ dark: "1010", size: 2 });
  expect(useRemote.getState().status).toEqual(waiting);
});

test("a QR code that can't be drawn stops the pairing it was for", async () => {
  vi.mocked(remoteStartPairing).mockResolvedValue("kriyon-pair:1:00");
  vi.mocked(remotePairingQr).mockRejectedValue("not a pairing invite");
  vi.mocked(remoteStopPairing).mockResolvedValue();
  vi.mocked(remoteStatus).mockResolvedValue(on);
  await useRemote.getState().startPairing("viewer");
  expect(remoteStopPairing).toHaveBeenCalled();
  expect(useRemote.getState().qr).toBeNull();
  expect(useRemote.getState().error).toContain("not a pairing invite");
  expect(useRemote.getState().status).toEqual(on);
});

test("enterCode says whether the code was sent", async () => {
  expect(await useRemote.getState().enterCode("12")).toBe(false);
  vi.mocked(remoteEnterCode).mockResolvedValue({ outcome: "burned" });
  expect(await useRemote.getState().enterCode("123456")).toBe(true);
});

test("a code that isn't six digits never reaches Rust", async () => {
  await useRemote.getState().enterCode("12 34");
  expect(remoteEnterCode).not.toHaveBeenCalled();
  expect(useRemote.getState().codeError).toBe("The code is six digits.");
});

test("a wrong code says how many tries are left", async () => {
  vi.mocked(remoteEnterCode).mockResolvedValue({
    outcome: "wrong",
    triesLeft: 2,
  });
  await useRemote.getState().enterCode("123456");
  expect(useRemote.getState().codeResult).toEqual({
    outcome: "wrong",
    triesLeft: 2,
  });
});

test("the right code ends the pairing and lists the new device", async () => {
  useRemote.setState({ qr: { dark: "1", size: 1 }, status: on });
  vi.mocked(remoteEnterCode).mockResolvedValue({
    deviceId: phone.id,
    name: phone.name,
    outcome: "paired",
    role: "viewer",
  });
  vi.mocked(remoteStatus).mockResolvedValue(on);
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  await useRemote.getState().enterCode("123456");
  expect(useRemote.getState().qr).toBeNull();
  expect(useRemote.getState().devices).toEqual([phone]);
});

test("cancelling a pairing stops it and drops the QR code", async () => {
  useRemote.setState({ qr: { dark: "1", size: 1 } });
  vi.mocked(remoteStopPairing).mockResolvedValue();
  await useRemote.getState().stopPairing();
  expect(remoteStopPairing).toHaveBeenCalled();
  expect(useRemote.getState().qr).toBeNull();
});

test("renaming, changing the role and removing refresh the list", async () => {
  vi.mocked(remoteRenameDevice).mockResolvedValue();
  vi.mocked(remoteSetDeviceRole).mockResolvedValue();
  vi.mocked(remoteRemoveDevice).mockResolvedValue();
  vi.mocked(remoteDevices).mockResolvedValue([phone]);
  await useRemote.getState().rename(phone.id, "Work phone");
  expect(remoteRenameDevice).toHaveBeenCalledWith(phone.id, "Work phone");
  await useRemote.getState().setRole(phone.id, "controller");
  expect(remoteSetDeviceRole).toHaveBeenCalledWith(phone.id, "controller");
  vi.mocked(remoteDevices).mockResolvedValue([]);
  await useRemote.getState().remove(phone.id);
  expect(remoteRemoveDevice).toHaveBeenCalledWith(phone.id);
  expect(useRemote.getState().devices).toEqual([]);
});

test("a rename Rust refuses is shown", async () => {
  vi.mocked(remoteRenameDevice).mockRejectedValue(
    "a device name is 1 to 64 bytes of plain text"
  );
  await useRemote.getState().rename(phone.id, "");
  expect(useRemote.getState().error).toContain("1 to 64 bytes");
});

test("the countdown is minutes and seconds, never below zero", () => {
  expect(countdownText(300_000, 0)).toBe("5:00");
  expect(countdownText(300_000, 1000)).toBe("4:59");
  expect(countdownText(300_000, 291_500)).toBe("0:09");
  expect(countdownText(300_000, 400_000)).toBe("0:00");
});

test("each code outcome has its line", () => {
  expect(codeResultLine({ outcome: "wrong", triesLeft: 1 })).toBe(
    "That code is wrong. 1 try left."
  );
  expect(codeResultLine({ outcome: "wrong", triesLeft: 2 })).toBe(
    "That code is wrong. 2 tries left."
  );
  expect(codeResultLine({ outcome: "burned" })).toContain("Start again");
  expect(codeResultLine({ outcome: "noAttempt" })).toContain("No device");
});

test("the consent screen says what changes, plainly", () => {
  const text = CONSENT_LINES.join(" ");
  expect(text).toContain("full shell access as you");
  expect(text).toContain("including any secret printed there");
  expect(text).toContain("lost or stolen");
  expect(text).toContain("this computer");
  expect(text).toContain("end-to-end encrypted");
  expect(text).not.toMatch(PROMISES_TOO_MUCH);
});
