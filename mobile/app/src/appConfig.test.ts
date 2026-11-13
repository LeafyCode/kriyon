import { expect, test } from "@jest/globals";
import { steel } from "../../../src/theme/themes/steel.ts";
import appJson from "../app.json" with { type: "json" };

test("the Android icon tile is the app's own window colour", () => {
  expect(appJson.expo.android.adaptiveIcon.backgroundColor).toBe(
    steel.colors.chromeWindow
  );
});
