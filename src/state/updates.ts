import { create } from "zustand";
import {
  type AvailableUpdate,
  checkForUpdate,
  type DownloadProgress,
  installUpdate,
  setUpdatePrefs,
  skipUpdate,
  type UpdateChannel,
  type UpdateSnapshot,
  updateStatus,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { plural } from "./stopCost.ts";

/**
 * The frontend's copy of the in-app updater. Rust checks, decides what is on
 * offer and installs; this holds what it reported and whether the update
 * dialog is open.
 */
interface UpdatesStore {
  /**
   * Rust's answer to a channel move (`update-channel-answered`): the switch
   * prompt, when the new feed offers an older build or says to wait.
   */
  answerMove: (snapshot: UpdateSnapshot) => void;
  /** Replace the snapshot (an `update-changed` event). */
  apply: (snapshot: UpdateSnapshot) => void;
  /** "Check now". Resolves to whether anything is on offer. */
  check: () => Promise<boolean>;
  closeDialog: () => void;
  dialogOpen: boolean;
  /** Why the last command failed, if it did. */
  error: string | null;
  install: () => Promise<void>;
  installing: boolean;
  load: () => Promise<void>;
  openDialog: () => void;
  progress: DownloadProgress | null;
  setPrefs: (channel: UpdateChannel, autoCheck: boolean) => Promise<void>;
  skip: () => Promise<void>;
  snapshot: UpdateSnapshot | null;
}

/** Whether this offer is one the switch prompt is for. */
function promptsSwitch(snapshot: UpdateSnapshot): boolean {
  const offer = snapshot.available?.offer;
  return offer === "stepDown" || offer === "waitForChannel";
}

export const useUpdates = create<UpdatesStore>((set, get) => ({
  answerMove: (snapshot) => {
    get().apply(snapshot);
    if (promptsSwitch(snapshot)) {
      set({ dialogOpen: true, error: null });
    }
  },
  apply: (snapshot) =>
    set((state) => ({
      dialogOpen: state.dialogOpen && snapshot.available !== null,
      snapshot,
    })),
  check: async () => {
    try {
      const snapshot = await checkForUpdate();
      get().apply(snapshot);
      const found = snapshot.available !== null;
      set({ dialogOpen: found, error: null });
      return found;
    } catch (error) {
      set({ error: failureMessage(error) });
      return false;
    }
  },
  closeDialog: () => set({ dialogOpen: false, error: null }),
  dialogOpen: false,
  error: null,
  install: async () => {
    set({ error: null, installing: true, progress: null });
    try {
      // On success the app restarts, so this only returns on failure.
      await installUpdate((progress) => set({ progress }));
    } catch (error) {
      set({ error: failureMessage(error) });
    }
    set({ installing: false, progress: null });
  },
  installing: false,
  load: async () => {
    try {
      get().apply(await updateStatus());
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  },
  openDialog: () => set({ dialogOpen: true, error: null }),
  progress: null,
  setPrefs: async (channel, autoCheck) => {
    // A channel move's switch prompt comes from Rust (`answerMove`), once the
    // new feed has answered, which may be after this reply.
    try {
      get().apply(await setUpdatePrefs(channel, autoCheck));
      set({ error: null });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  },
  skip: async () => {
    const version = get().snapshot?.available?.version;
    if (!version) {
      return;
    }
    try {
      get().apply(await skipUpdate(version));
      set({ dialogOpen: false, error: null });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  },
  snapshot: null,
}));

/** Whether the sidebar shows the "Update available" pill: Rust's call. */
export function showsPill(snapshot: UpdateSnapshot | null): boolean {
  return snapshot?.available?.installable === true;
}

/**
 * The update dialog's wording. `confirm` is the install button's label, or
 * `null` when Rust says the offer can't be installed.
 */
export function offerCopy(
  available: AvailableUpdate,
  channel: UpdateChannel,
  running: string
): { body: string; confirm: string | null; title: string } {
  const copy = offerWording(
    available.version,
    available.offer,
    channel,
    running
  );
  return { ...copy, confirm: available.installable ? copy.confirm : null };
}

function offerWording(
  version: string,
  offer: AvailableUpdate["offer"],
  channel: UpdateChannel,
  running: string
): { body: string; confirm: string; title: string } {
  switch (offer) {
    case "stepDown":
      return {
        body: `${version} is older than ${running}, the build you run now. Kriyon backs up its data first, then installs it. After that, updates work as usual.`,
        confirm: "Install older build & restart",
        title: `Switch to the ${channel} build ${version}?`,
      };
    case "waitForChannel":
      return {
        body: `${version} is too far behind ${running} to be sure it can read the data this build saved. Kriyon stays on ${running} and moves to ${channel} with its next release.`,
        confirm: "Install & restart",
        title: `Wait for the next ${channel} release`,
      };
    default:
      return {
        body: `You run ${running}.`,
        confirm: "Install & restart",
        title: `Kriyon ${version} is available`,
      };
  }
}

/**
 * What the restart means for sessions mid-turn, or `null` with none. The
 * restart is a [Handover]: their daemons keep running and the new build
 * reattaches.
 */
export function restartNote(working: number): string | null {
  if (working === 0) {
    return null;
  }
  const [verb, pronoun, reconnect] =
    working === 1
      ? ["is", "It keeps", "reconnects"]
      : ["are", "They keep", "reconnect"];
  return `${plural(working, "session")} ${verb} mid-turn. ${pronoun} running while Kriyon restarts, and ${reconnect} when Kriyon opens again.`;
}

/** The download's whole percent, or `null` while the size is unknown. */
export function progressPercent(
  progress: DownloadProgress | null
): number | null {
  if (!progress?.total) {
    return null;
  }
  return Math.min(
    100,
    Math.floor((progress.downloaded / progress.total) * 100)
  );
}
