/**
 * Regenerates every derived image under `public/shots/` from the 4K originals
 * in `shots-src/`. The social card is separate: `build-og.mjs`.
 *
 * The originals are 2x retina window captures (3390x2064, cut by
 * `crop-shots.mjs`). Nothing on the page renders one wider than about 1400
 * device px — the /views card peaks near 680 CSS px — so the ladder stops at
 * 1920 and the 4K original never ships.
 *
 * Run after replacing any capture:  node scripts/build-shots.mjs
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "shots-src");
const OUT_DIR = path.join(ROOT, "public", "shots");

/** Widths emitted for each app capture, in device pixels. */
const WIDTHS = [640, 960, 1280, 1920];
const WEBP = { quality: 82, effort: 6 };

const CAPTURE_RE = /\.(webp|png)$/;

async function emitLadder(file) {
  const src = path.join(SRC_DIR, file);
  const base = path.basename(file, path.extname(file));
  const { width: srcWidth, height: srcHeight } = await sharp(src).metadata();
  const below = WIDTHS.filter((w) => w < srcWidth);
  // A small capture (the menu bar) ships at its own width as the top rung.
  const widths =
    below.length === WIDTHS.length ? below : below.concat(srcWidth);

  for (const width of widths) {
    const out = path.join(OUT_DIR, `${base}-${width}.webp`);
    // biome-ignore lint/performance/noAwaitInLoops: one resize at a time keeps memory flat.
    await sharp(src).resize({ width }).webp(WEBP).toFile(out);
  }
  return { base, widths, srcWidth, srcHeight };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const files = (await readdir(SRC_DIR)).filter((f) => CAPTURE_RE.test(f));
  if (files.length === 0) {
    throw new Error(`no source captures in ${SRC_DIR}`);
  }

  const manifest = {};
  for (const file of files.sort()) {
    // biome-ignore lint/performance/noAwaitInLoops: one image at a time keeps memory flat.
    const { base, widths, srcWidth, srcHeight } = await emitLadder(file);
    manifest[base] = {
      widths,
      intrinsicWidth: srcWidth,
      intrinsicHeight: srcHeight,
    };
    process.stdout.write(`${base}: ${widths.join(", ")}\n`);
  }

  // Consumed by src/lib/shots.ts so the srcset strings can never drift from
  // what is actually on disk.
  await writeFile(
    path.join(ROOT, "src", "lib", "shots.generated.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

await main();
