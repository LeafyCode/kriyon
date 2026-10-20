import { beforeEach, expect, test, vi } from "vitest";
import {
  type AvailableUpdate,
  checkForUpdate,
  installUpdate,
  setUpdatePrefs,
  skipUpdate,
  type UpdateSnapshot,
} from "../ipc/bridge.ts";
import {
  offerCopy,
  progressPercent,
  restartNote,
  showsPill,
  useUpdates,
} from "./updates.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  setUpdatePrefs: vi.fn(),
  skipUpdate: vi.fn(),
}));

const upgrade: AvailableUpdate = {
  notes: "### Features\n- A thing",
  installable: true,
  offer: "upgrade",
  version: "0.13.0",
};

const base: UpdateSnapshot = {
  available: null,
  checking: false,
  error: null,
  lastCheckedMs: null,
  prefs: { autoCheck: true, channel: "stable", skipped: null },
  running: "0.12.0",
  supported: true,
};

beforeEach(() => {
  useUpdates.setState({
    dialogOpen: false,
    error: null,
    installing: false,
    progress: null,
    snapshot: null,
  });
  vi.mocked(checkForUpdate).mockReset();
  vi.mocked(installUpdate).mockReset();
  vi.mocked(setUpdatePrefs).mockReset();
  vi.mocked(skipUpdate).mockReset();
});

test("the pill shows for what Rust says can be installed", () => {
  expect(showsPill(null)).toBe(false);
  expect(showsPill(base)).toBe(false);
  expect(showsPill({ ...base, available: upgrade })).toBe(true);
  // The pill reads Rust's answer, never the offer's name.
  expect(
    showsPill({ ...base, available: { ...upgrade, installable: false } })
  ).toBe(false);
});

test("an upgrade offers install and restart", () => {
  const copy = offerCopy(upgrade, base.prefs.channel, "0.12.0");
  expect(copy.title).toBe("Kriyon 0.13.0 is available");
  expect(copy.confirm).toBe("Install & restart");
});

test("a step-down says the build is older and that data is backed up", () => {
  const copy = offerCopy(
    { ...upgrade, offer: "stepDown", version: "0.13.0-beta.2" },
    "beta",
    "0.13.0-nightly.20261017.2"
  );
  expect(copy.title).toBe("Switch to the beta build 0.13.0-beta.2?");
  expect(copy.body).toContain("older than 0.13.0-nightly.20261017.2");
  expect(copy.body).toContain("backs up its data");
  expect(copy.confirm).toBe("Install older build & restart");
});

test("a step-down that can't read newer data says to wait, with no install", () => {
  const copy = offerCopy(
    {
      ...upgrade,
      installable: false,
      offer: "waitForChannel",
      version: "0.12.4",
    },
    "stable",
    "0.14.0-beta.1"
  );
  expect(copy.title).toBe("Wait for the next stable release");
  expect(copy.confirm).toBeNull();
});

test("the restart note names sessions mid-turn, and says they carry on", () => {
  expect(restartNote(0)).toBeNull();
  expect(restartNote(1)).toBe(
    "1 session is mid-turn. It keeps running while Kriyon restarts, and reconnects when Kriyon opens again."
  );
  expect(restartNote(2)).toBe(
    "2 sessions are mid-turn. They keep running while Kriyon restarts, and reconnect when Kriyon opens again."
  );
});

test("progress is a whole percent, or unknown without a total", () => {
  expect(progressPercent(null)).toBeNull();
  expect(progressPercent({ downloaded: 5, total: null })).toBeNull();
  expect(progressPercent({ downloaded: 1, total: 3 })).toBe(33);
  expect(progressPercent({ downloaded: 3, total: 3 })).toBe(100);
});

const stepDown: AvailableUpdate = {
  ...upgrade,
  offer: "stepDown",
  version: "0.13.0-beta.2",
};

test("Rust's answer to a channel move opens the switch prompt", () => {
  useUpdates.getState().answerMove({ ...base, available: stepDown });
  expect(useUpdates.getState().dialogOpen).toBe(true);

  useUpdates.setState({ dialogOpen: false });
  useUpdates.getState().answerMove({
    ...base,
    available: { ...stepDown, installable: false, offer: "waitForChannel" },
  });
  expect(useUpdates.getState().dialogOpen).toBe(true);
});

test("an answer with a plain upgrade or nothing leaves it to the pill", () => {
  useUpdates.getState().answerMove({ ...base, available: upgrade });
  expect(useUpdates.getState().dialogOpen).toBe(false);
  useUpdates.getState().answerMove(base);
  expect(useUpdates.getState().dialogOpen).toBe(false);
  expect(useUpdates.getState().snapshot).toEqual(base);
});

test("only the answer opens the prompt, never a reply or a plain update", async () => {
  vi.mocked(setUpdatePrefs).mockResolvedValue({
    ...base,
    available: stepDown,
    prefs: { ...base.prefs, channel: "beta" },
  });
  useUpdates.setState({ snapshot: base });

  await useUpdates.getState().setPrefs("beta", true);
  useUpdates.getState().apply({ ...base, available: stepDown });

  expect(setUpdatePrefs).toHaveBeenCalledWith("beta", true);
  expect(useUpdates.getState().dialogOpen).toBe(false);
});

test("check now opens the dialog when it finds something", async () => {
  vi.mocked(checkForUpdate).mockResolvedValue({ ...base, available: upgrade });

  const found = await useUpdates.getState().check();

  expect(found).toBe(true);
  expect(useUpdates.getState().dialogOpen).toBe(true);
});

test("skip hides the version and closes the dialog", async () => {
  vi.mocked(skipUpdate).mockResolvedValue({
    ...base,
    prefs: { ...base.prefs, skipped: "0.13.0" },
  });
  useUpdates.setState({
    dialogOpen: true,
    snapshot: { ...base, available: upgrade },
  });

  await useUpdates.getState().skip();

  expect(skipUpdate).toHaveBeenCalledWith("0.13.0");
  expect(useUpdates.getState().dialogOpen).toBe(false);
  expect(useUpdates.getState().snapshot?.available).toBeNull();
});

test("install shows progress, and a failure says why and lets the user retry", async () => {
  vi.mocked(installUpdate).mockImplementation((onProgress) => {
    onProgress({ downloaded: 1, total: 2 });
    expect(useUpdates.getState().progress).toEqual({ downloaded: 1, total: 2 });
    return Promise.reject(new Error("signature mismatch"));
  });
  useUpdates.setState({ snapshot: { ...base, available: upgrade } });

  await useUpdates.getState().install();

  const state = useUpdates.getState();
  expect(state.installing).toBe(false);
  expect(state.progress).toBeNull();
  expect(state.error).toContain("signature mismatch");
});

test("a snapshot with nothing on offer closes the dialog", () => {
  useUpdates.setState({
    dialogOpen: true,
    snapshot: { ...base, available: upgrade },
  });
  useUpdates.getState().apply(base);
  expect(useUpdates.getState().dialogOpen).toBe(false);
});
