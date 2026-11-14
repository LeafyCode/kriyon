import { expect, test } from "@jest/globals";
import { steel } from "../../../src/theme/themes/steel.ts";
import appJson from "../app.json" with { type: "json" };
import { storeVersion } from "./storeVersion.ts";

test("the Android icon tile is the app's own window colour", () => {
  expect(appJson.expo.android.adaptiveIcon.backgroundColor).toBe(
    steel.colors.chromeWindow
  );
});

test("nothing of the app's is backed up: the phone's keys never leave it", () => {
  expect(appJson.expo.android.allowBackup).toBe(false);
});

test("the stores get the release's plain x.y.z, even from a pre-release", () => {
  expect(storeVersion("0.17.0")).toBe("0.17.0");
  expect(storeVersion("0.17.0-beta.2")).toBe("0.17.0");
  expect(storeVersion("0.17.0-nightly.20261114.3")).toBe("0.17.0");
  expect(storeVersion("0.17.0+ci.5")).toBe("0.17.0");
  expect(storeVersion("0.17.0-beta.1+abc")).toBe("0.17.0");
});
