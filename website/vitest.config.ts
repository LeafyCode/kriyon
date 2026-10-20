import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/* Tests run without the TanStack Start plugin: they exercise components and
   pure logic, never the router's build-time codegen or prerender pass. */
export default defineConfig({
  plugins: [viteReact()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
