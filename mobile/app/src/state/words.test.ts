import { expect, test } from "@jest/globals";
import { wordsOf } from "./words.ts";

test("a native call's refusal reads as its reason, not Expo's wrapper", () => {
  // Seen on the Android emulator, under Settings' relay section.
  const error = new Error(
    "Call to function 'KriyonNative.relayAccount' has been rejected.\n→ Caused by: Can't reach our relay's service. Try again later"
  );
  expect(wordsOf(error)).toBe(
    "Can't reach our relay's service. Try again later"
  );
});

test("a reason wrapped more than once reads as the innermost", () => {
  expect(
    wordsOf(
      new Error(
        "Call to function 'KriyonNative.input' has been rejected.\n→ Caused by: java.lang.Exception\n→ Caused by: Not connected."
      )
    )
  ).toBe("Not connected.");
});

test("plain errors and other values read as they are", () => {
  expect(wordsOf(new Error("Not connected."))).toBe("Not connected.");
  expect(wordsOf("gone")).toBe("gone");
});
