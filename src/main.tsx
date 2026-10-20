import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { installQaHook } from "./dev/qaHook.ts";
import { applyTheme } from "./theme/applyTheme.ts";
import { themeById } from "./theme/themes/index.ts";

// Publish the default palette before first paint; the persisted choice is
// re-applied once the layout hydrates.
applyTheme(themeById(undefined));

if (import.meta.env.DEV) {
  installQaHook();
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
