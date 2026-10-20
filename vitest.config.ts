import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  // Mirrors vite.config.ts so tests see the same injected version.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Vitest owns src/ tests. The *.test.mjs files elsewhere use node:test
    // and run via `pnpm test:node` (pnpm check, pre-push and CI), not Vitest.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
