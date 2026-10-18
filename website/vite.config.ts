import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: true,
      },
      // Vercel's static hosting serves `404.html` for an unmatched path, so the
      // not-found route has to land there rather than at `/404/index.html`.
      pages: [
        {
          path: "/404",
          prerender: { enabled: true, outputPath: "/404.html" },
        },
      ],
    }),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
  ],
});
