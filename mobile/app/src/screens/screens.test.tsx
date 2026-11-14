import { beforeEach, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import fixture from "../../../../src/remote/fixtures/summaries.json" with {
  type: "json",
};
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import {
  KriyonNative,
  type PairedHost,
} from "../../modules/kriyon-native/index.ts";
import { usePhone } from "../state/phone.ts";
import { HomeScreen } from "./HomeScreen.tsx";
import { PairScreen } from "./PairScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    cancelPairing: jest.fn(() => Promise.resolve()),
    finishPairing: jest.fn(),
    forget: jest.fn(() => Promise.resolve()),
    hosts: jest.fn(() => Promise.resolve([])),
    pair: jest.fn(),
    setAlerts: jest.fn(),
    setAppLock: jest.fn(() => Promise.resolve()),
    setPrivateInSwitcher: jest.fn(() => Promise.resolve()),
    start: jest.fn(),
    wake: jest.fn(),
  },
}));

jest.mock("./RelaySection.tsx", () => ({ RelaySection: () => null }));

const native = jest.mocked(KriyonNative);
const MORE = /\+1 more/;
const ASKING = /^Asking/;
const MAC = "ab".repeat(32);

const paired: PairedHost = {
  addrs: [],
  hostId: MAC,
  name: "Mac",
  pairedAtMs: 1,
  relayUrl: null,
};

const connected: HostSummary = {
  hostId: MAC,
  hostName: "Mac",
  link: "connected",
  mayStart: false,
  projects: [],
  refused: null,
  role: "controller",
  sessions: [
    {
      dialogOpen: true,
      id: "s1",
      lastChangeMs: 2,
      needsYou: true,
      projectId: "p",
      standing: "awaiting_input",
      status: "waiting",
      title: "Fix the build",
      mayType: false,
      typing: null,
    },
    {
      dialogOpen: false,
      id: "s2",
      lastChangeMs: 1,
      needsYou: false,
      projectId: "p",
      standing: "running",
      status: "running",
      title: "Write the docs",
      mayType: false,
      typing: null,
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
});

const session = (
  over: Partial<HostSummary["sessions"][number]>
): HostSummary["sessions"][number] => ({
  dialogOpen: false,
  id: "s",
  lastChangeMs: 0,
  mayType: false,
  needsYou: false,
  projectId: "api",
  standing: "idle",
  status: "idle",
  title: "A session",
  typing: null,
  ...over,
});

test("with no computer yet, home offers pairing", async () => {
  await render(<HomeScreen />);
  expect(screen.getByText("No computers yet.")).toBeOnTheScreen();
  await fireEvent.press(
    screen.getAllByRole("button", { name: "Pair a computer" })[0]
  );
  expect(usePhone.getState().screen).toEqual({ kind: "pair" });
});

test("home leads with the sessions at a glance and what needs you, in words", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: connected } });
  await render(<HomeScreen />);
  expect(screen.getByText("sessions · 1 needs you")).toBeOnTheScreen();
  expect(
    screen.getByLabelText("1 asking, 0 your turn, 1 running, 0 idle")
  ).toBeOnTheScreen();
  expect(screen.getByText("Needs you")).toBeOnTheScreen();
  // Under Needs you only: its computer lists the rest.
  expect(screen.getAllByText("Fix the build")).toHaveLength(1);
  expect(screen.getByText(ASKING)).toBeOnTheScreen();
  expect(screen.getByText("Write the docs")).toBeOnTheScreen();
  expect(screen.getByText("Running")).toBeOnTheScreen();
  await fireEvent.press(screen.getByText("Fix the build"));
  expect(usePhone.getState().screen).toEqual({
    hostId: MAC,
    kind: "session",
    sessionId: "s1",
    view: "readable",
  });
});

test("a question is answered in the terminal, with its first two options shown", async () => {
  const question = {
    options: ["Attach the listener", "Mock the network", "Retry"],
    text: "Which fix do you want?",
  };
  usePhone.setState({
    hosts: [paired],
    states: {
      [MAC]: {
        ...connected,
        sessions: [{ ...connected.sessions[0], question }],
      },
    },
  });
  await render(<HomeScreen />);
  expect(screen.getByText("Which fix do you want?")).toBeOnTheScreen();
  expect(screen.getByText(MORE)).toBeOnTheScreen();
  expect(screen.queryByText("Retry")).toBeNull();
  await fireEvent.press(
    screen.getByRole("button", { name: "Answer in the terminal" })
  );
  expect(usePhone.getState().screen).toMatchObject({ view: "terminal" });
});

test("a turn waiting for you shows its summary and diff once the computer sends them", async () => {
  const turn = session({
    id: "t",
    needsYou: true,
    standing: "awaiting_input",
    status: "waiting",
    title: "Add rate limits",
  });
  usePhone.setState({
    hosts: [paired],
    states: { [MAC]: { ...connected, sessions: [turn] } },
  });
  const view = await render(<HomeScreen />);
  expect(screen.getByText("Your turn")).toBeOnTheScreen();
  expect(screen.queryByText("4 files")).toBeNull();
  await view.unmount();
  usePhone.setState({
    states: {
      [MAC]: {
        ...connected,
        sessions: [
          {
            ...turn,
            diff: { added: 128, files: 4, removed: 31 },
            turnSummary: "Added a token bucket per IP.",
          },
        ],
      },
    },
  });
  await render(<HomeScreen />);
  expect(screen.getByText("Added a token bucket per IP.")).toBeOnTheScreen();
  expect(screen.getByText("4 files")).toBeOnTheScreen();
  expect(screen.getByText("+128")).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Reply" }));
  expect(usePhone.getState().screen).toMatchObject({ sessionId: "t" });
});

test("a computer folds its idle sessions, and says what a running one runs", async () => {
  usePhone.setState({
    hosts: [paired],
    states: {
      [MAC]: {
        ...connected,
        sessions: [
          session({
            activity: "Bash · pnpm test",
            id: "r",
            standing: "running",
            status: "running",
            title: "Migrate auth",
          }),
          session({ id: "i1", title: "Old one" }),
          session({ id: "i2", title: "Older one" }),
        ],
        usage: { resetsAtMs: null, usedPercent: 62, window: "5-hour window" },
      },
    },
  });
  await render(<HomeScreen />);
  expect(screen.getByText("Bash · pnpm test")).toBeOnTheScreen();
  expect(screen.getByLabelText("62 percent used")).toBeOnTheScreen();
  expect(screen.queryByText("Old one")).toBeNull();
  await fireEvent.press(
    screen.getByRole("button", { name: "2 idle sessions" })
  );
  expect(screen.getByText("Old one")).toBeOnTheScreen();
  expect(screen.getAllByText("Idle")).toHaveLength(2);
});

test("the filters show what needs you, or only what runs", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: connected } });
  await render(<HomeScreen />);
  await fireEvent.press(screen.getByRole("tab", { name: "Running · 1" }));
  expect(screen.queryByText("Fix the build")).toBeNull();
  expect(screen.getByText("Write the docs")).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("tab", { name: "Needs you · 1" }));
  expect(screen.getByText("Fix the build")).toBeOnTheScreen();
  expect(screen.queryByText("Write the docs")).toBeNull();
});

test("a computer that is away is dimmed, says so, and its sessions don't need you here", async () => {
  usePhone.setState({
    hosts: [paired],
    states: { [MAC]: { ...connected, link: "lost" } },
  });
  await render(<HomeScreen />);
  expect(screen.getByText("Reconnecting · Controller")).toBeOnTheScreen();
  expect(screen.queryByText("Needs you")).toBeNull();
});

test("pairing takes the pasted code and shows the digits to type there", async () => {
  native.pair.mockResolvedValue("123456");
  native.finishPairing.mockReturnValue(new Promise(() => undefined));
  usePhone.setState({ screen: { kind: "pair" } });
  await render(<PairScreen />);
  expect(screen.getByLabelText("Step 1 of 2: Scan the code")).toBeOnTheScreen();
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code from the computer"),
    "kriyon-pair:1:abc"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(
    await screen.findByLabelText("Pairing code 1 2 3 4 5 6")
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText("Step 2 of 2: Confirm on the computer")
  ).toBeOnTheScreen();
  expect(screen.getByText("Waiting for the computer…")).toBeOnTheScreen();
  // Not sent yet: nothing said about the role or when the code runs out.
  expect(screen.queryByText("Role on this computer")).toBeNull();
  expect(native.pair).toHaveBeenCalledWith("kriyon-pair:1:abc");
  await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  expect(native.cancelPairing).toHaveBeenCalled();
  expect(usePhone.getState().screen).toEqual({ kind: "home" });
});

test("the code step says the role and the time left once the computer sends them", async () => {
  usePhone.setState({
    pairing: {
      code: "482913",
      expiresAtMs: Date.now() + 252_000,
      phase: "code",
      role: "controller",
    },
  });
  await render(<PairScreen />);
  expect(screen.getByText("Controller")).toBeOnTheScreen();
  expect(screen.getByText("Code expires in")).toBeOnTheScreen();
});

test("a failed pairing says why", async () => {
  usePhone.setState({
    pairing: { phase: "failed", reason: "that isn't a Kriyon pairing code" },
  });
  await render(<PairScreen />);
  expect(
    screen.getByText("that isn't a Kriyon pairing code")
  ).toBeOnTheScreen();
});

test("the app lock is a switch with its time, kept as the person sets them", async () => {
  usePhone.setState({
    appLock: { afterS: 300, on: null },
    states: { [MAC]: connected },
  });
  await render(<SettingsScreen />);
  // A Controller's phone: on, not chosen yet.
  const lock = screen.getByRole("switch", { name: "App lock" });
  expect(lock).toBeChecked();
  expect(screen.getByRole("tab", { name: "5 min" })).toBeSelected();
  await fireEvent.press(screen.getByRole("tab", { name: "1 min" }));
  expect(native.setAppLock).toHaveBeenLastCalledWith(null, 60);
  await fireEvent(lock, "valueChange", false);
  expect(native.setAppLock).toHaveBeenLastCalledWith(false, 60);
  expect(screen.getByRole("switch", { name: "App lock" })).not.toBeChecked();
  // Off: no time to choose.
  expect(screen.queryByRole("tab", { name: "1 min" })).toBeNull();
});

test("alerts are a switch that says whether they are on, and turns them off", async () => {
  usePhone.setState({ alertsOn: true, push: "on" });
  native.setAlerts.mockResolvedValue();
  await render(<SettingsScreen />);
  const alerts = screen.getByRole("switch", { name: "Alerts" });
  expect(alerts).toBeChecked();
  await fireEvent(alerts, "valueChange", false);
  expect(native.setAlerts).toHaveBeenCalledWith(false);
  expect(screen.getByRole("switch", { name: "Alerts" })).not.toBeChecked();
});

test("settings say where alerts stand, in a word and in full", async () => {
  usePhone.setState({ push: "unavailable: no aps-environment" });
  await render(<SettingsScreen />);
  expect(screen.getByText("Unavailable")).toBeOnTheScreen();
  expect(
    screen.getByText("Alerts: unavailable: no aps-environment")
  ).toBeOnTheScreen();
});

test("an Android build without Firebase says so in plain words", async () => {
  usePhone.setState({ push: "needs Firebase" });
  await render(<SettingsScreen />);
  expect(
    screen.getByText("Alerts need a Firebase setup on this build.")
  ).toBeOnTheScreen();
});

test("a computer can be forgotten from settings, and this phone's key shows", async () => {
  usePhone.setState({
    deviceId: "a09aa5f47a67beef",
    hosts: [paired],
    states: { [MAC]: connected },
  });
  await render(<SettingsScreen />);
  expect(screen.getByText("a09a·a5f4·7a67")).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Forget Mac" }));
  expect(native.forget).toHaveBeenCalledWith(MAC);
  expect(usePhone.getState().hosts).toEqual([]);
});

// The computer's own words, from the fixture Rust writes and checks.
test("home shows every part a computer sends, from Rust's own fixture", async () => {
  const sent = fixture.hostSummary as HostSummary;
  usePhone.setState({ hosts: [paired], states: { [MAC]: sent } });
  await render(<HomeScreen />);
  // The question and its options, the running tool, how the link runs, the plan's use.
  expect(screen.getByText("Which db?")).toBeOnTheScreen();
  expect(screen.getByText("Postgres", { exact: false })).toBeOnTheScreen();
  expect(screen.getByText("SQLite", { exact: false })).toBeOnTheScreen();
  expect(screen.getByText("Bash · pnpm test")).toBeOnTheScreen();
  expect(screen.getByText("Connected · direct · Controller")).toBeOnTheScreen();
  expect(screen.getByText("Claude usage · 5-hour limit")).toBeOnTheScreen();
  expect(screen.getByLabelText("40 percent used")).toBeOnTheScreen();
});

test("a finished turn from Rust's fixture shows its summary and diff", async () => {
  const sent = fixture.hostSummary as HostSummary;
  const [asking, ...rest] = sent.sessions;
  // The same session, its dialog closed: a turn waiting for a reply.
  const turn = {
    ...asking,
    dialogOpen: false,
    question: null,
  } as HostSummary["sessions"][number];
  usePhone.setState({
    hosts: [paired],
    states: { [MAC]: { ...sent, sessions: [turn, ...rest] } },
  });
  await render(<HomeScreen />);
  expect(screen.getByText("Fixed it.")).toBeOnTheScreen();
  expect(
    screen.getByLabelText("2 files changed, 10 lines added, 3 removed")
  ).toBeOnTheScreen();
});
