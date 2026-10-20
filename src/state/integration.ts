import { create } from "zustand";
import {
  type IntegrationPrefs,
  type IntegrationStatus,
  integrationSet,
  integrationStatus,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";

/**
 * The frontend's copy of the [Integration]. `status` is `null` until loaded;
 * the app shows the welcome screen until `status.prefs.consented`.
 */
interface IntegrationStore {
  /** Why the last update failed (e.g. an unreadable settings file), if it did. */
  error: string | null;
  load: () => Promise<void>;
  /** The backend changed the integration on its own (a refused plugin). */
  replace: (status: IntegrationStatus) => void;
  status: IntegrationStatus | null;
  update: (prefs: IntegrationPrefs) => Promise<void>;
}

export const useIntegration = create<IntegrationStore>((set) => ({
  error: null,
  load: async () => {
    try {
      set({ error: null, status: await integrationStatus() });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  },
  replace: (status) => set({ status }),
  status: null,
  update: async (prefs) => {
    try {
      set({ error: null, status: await integrationSet(prefs) });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  },
}));
