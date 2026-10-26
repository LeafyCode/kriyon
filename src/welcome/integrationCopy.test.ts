import { expect, test } from "vitest";
import type { IntegrationStatus } from "../ipc/bridge.ts";
import { DEFAULT_INTEGRATION_PREFS } from "../ipc/bridge.ts";
import {
  companionHint,
  hooksHint,
  liveUsageHint,
  REFUSED_TOAST,
} from "./integrationCopy.ts";

const ON_PLUGIN = /only in Kriyon's sessions.*settings file has none/;
const ORG = /organization blocks.*~\/\.claude\/settings\.json/;
const UNKNOWN = /couldn't read your organization's policy/;
const REFUSED = /refused Kriyon's per-session plugin/;
const OFF = /Status unavailable/;
const SETTINGS_FILE = /~\/\.claude\/settings\.json/;

function status(over: Partial<IntegrationStatus>): IntegrationStatus {
  return {
    companionAvailable: true,
    companionDir: null,
    originalStatusLine: null,
    plannedReason: "plugin",
    plannedRoute: "plugin",
    prefs: { ...DEFAULT_INTEGRATION_PREFS, consented: true },
    route: "plugin",
    routeReason: "plugin",
    sideload: "allowed",
    ...over,
  };
}

test("the hooks hint says where the hooks live and why", () => {
  expect(hooksHint("plugin")).toMatch(ON_PLUGIN);
  expect(hooksHint("orgBlocks")).toMatch(ORG);
  expect(hooksHint("policyUnknown")).toMatch(UNKNOWN);
  expect(hooksHint("refused")).toMatch(REFUSED);
  expect(hooksHint("off")).toMatch(OFF);
});

test("the live usage hint names the user's own status line when there is one", () => {
  expect(liveUsageHint(status({ originalStatusLine: "my-bar" }))).toContain(
    "my-bar"
  );
  expect(liveUsageHint(status({}))).toMatch(SETTINGS_FILE);
});

test("the refusal toast says what changed and what to do", () => {
  expect(REFUSED_TOAST.toLowerCase()).toContain("restart");
});

test("the companion hint says what it sees and what it never does", () => {
  const hint = companionHint(true);
  expect(hint).toContain("only to Kriyon on this Mac");
  expect(hint).toContain("never approves, blocks or changes anything");
  // Nested sessions spend plan use, so the hint says when one starts.
  expect(hint).toContain("only when you asked for it in your own words");
  expect(companionHint(false)).toContain("per-session plugin");
});
