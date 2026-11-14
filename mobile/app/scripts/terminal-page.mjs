// Builds the phone's terminal page (src/terminal/page.ts, xterm.js and its
// stylesheet) into one HTML string the web view loads with no network:
// src/terminal/page.generated.ts. Run before tests, type checks and builds.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { steel } from "../../../src/theme/themes/steel.ts";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(app, "package.json"));

const bundle = await rolldown({
  input: join(app, "src/terminal/page.ts"),
  platform: "browser",
});
const { output } = await bundle.generate({ format: "iife", minify: true });
await bundle.close();
// Inside <script>, "</script" in any case ends it and "<!--" can change how
// it is read: neither may appear as is.
const script = output[0].code
  .replace(/<\/(script)/gi, "<\\/$1")
  .replaceAll("<!--", "<\\!--");
const css = readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8");

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>${css}
html, body, #terminal { height: 100%; margin: 0; background: ${steel.colors.chromeWindow}; }
</style></head>
<body><div id="terminal"></div><script>${script}</script></body></html>`;

writeFileSync(
  join(app, "src/terminal/page.generated.ts"),
  `// Made by scripts/terminal-page.mjs from src/terminal/page.ts. Don't edit.\nexport const TERMINAL_PAGE = ${JSON.stringify(html)};\n`
);
