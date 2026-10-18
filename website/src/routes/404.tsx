import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "../components/NotFound.tsx";

/**
 * Prerendered to `/404.html` (see `vite.config.ts`), which is what Vercel's
 * static hosting serves for an unmatched path. Without this route the app's
 * not-found component never renders in production.
 */
export const Route = createFileRoute("/404")({
  head: () => ({
    meta: [
      { title: "Page not found — Kriyon" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NotFound,
});
