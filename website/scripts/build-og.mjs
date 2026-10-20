/**
 * Renders the social card, `og/og.html`, to `public/og.jpg` (1200x630) with
 * the local Chrome in headless mode, then recompresses it with sharp.
 *
 * Run after changing the card or the release it names:  node scripts/build-og.mjs
 * Set CHROME to the browser binary when it is not in the macOS default place.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OG = { width: 1200, height: 630 };

const dir = mkdtempSync(path.join(tmpdir(), "kriyon-og-"));
const png = path.join(dir, "og.png");
try {
  execFileSync(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    // The card loads its fonts and images from sibling folders on disk.
    "--allow-file-access-from-files",
    "--force-device-scale-factor=1",
    `--window-size=${OG.width},${OG.height}`,
    "--virtual-time-budget=3000",
    `--screenshot=${png}`,
    pathToFileURL(path.join(ROOT, "og", "og.html")).href,
  ]);
  await sharp(png)
    .resize(OG)
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(path.join(ROOT, "public", "og.jpg"));
  process.stdout.write("og.jpg: 1200x630\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
