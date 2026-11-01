/**
 * Make the test's webview report macOS or Windows, so platform copy is
 * asserted as a literal string rather than worked out by the code under test.
 * Returns the undo; call it in `afterEach`.
 */
export function pretendPlatform(platform: "mac" | "windows"): () => void {
  const values =
    platform === "mac"
      ? {
          platform: "MacIntel",
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
        }
      : {
          platform: "Win32",
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(navigator, key, { configurable: true, value });
  }
  return () => {
    for (const key of Object.keys(values)) {
      // Removing the own property brings back jsdom's own getter.
      Reflect.deleteProperty(navigator, key);
    }
  };
}
