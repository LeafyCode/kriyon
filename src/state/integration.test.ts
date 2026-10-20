import { beforeEach, expect, test, vi } from "vitest";
import {
  DEFAULT_INTEGRATION_PREFS,
  type IntegrationStatus,
  integrationSet,
  integrationStatus,
} from "../ipc/bridge.ts";
import { useIntegration } from "./integration.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  integrationSet: vi.fn(),
  integrationStatus: vi.fn(),
}));

const base: IntegrationStatus = {
  companionDir: null,
  originalStatusLine: null,
  prefs: DEFAULT_INTEGRATION_PREFS,
  companionAvailable: true,
  plannedReason: "plugin",
  plannedRoute: "plugin",
  route: "off",
  routeReason: "off",
  sideload: "allowed",
};

beforeEach(() => {
  useIntegration.setState({ error: null, status: null });
  vi.mocked(integrationStatus).mockResolvedValue(base);
});

test("load reads the integration, which gates the app until consent", async () => {
  await useIntegration.getState().load();
  expect(useIntegration.getState().status?.prefs.consented).toBe(false);
});

test("update applies new prefs and keeps what the backend answered", async () => {
  const applied = {
    ...base,
    prefs: { ...base.prefs, consented: true },
    route: "plugin" as const,
  };
  vi.mocked(integrationSet).mockResolvedValue(applied);
  await useIntegration.getState().update({ ...base.prefs, consented: true });
  expect(useIntegration.getState().status).toEqual(applied);
});

test("a failed update keeps the old status and says why", async () => {
  useIntegration.setState({ status: base });
  vi.mocked(integrationSet).mockRejectedValue(
    "settings.json is not valid JSON"
  );
  await useIntegration.getState().update({ ...base.prefs, consented: true });
  expect(useIntegration.getState().status).toEqual(base);
  expect(useIntegration.getState().error).toContain("not valid JSON");
});

test("a failure shows the backend's words, not an Error wrapper or kind tag", async () => {
  vi.mocked(integrationStatus).mockRejectedValue(
    new Error("kind:file-missing: settings.json vanished")
  );
  await useIntegration.getState().load();
  expect(useIntegration.getState().error).toBe("settings.json vanished");

  vi.mocked(integrationSet).mockRejectedValue(new Error("disk full"));
  await useIntegration.getState().update({ ...base.prefs, consented: true });
  expect(useIntegration.getState().error).toBe("disk full");
});
