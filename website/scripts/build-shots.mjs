/**
 * Regenerates every derived image under `public/shots/` from the 4K originals
 * in `shots-src/`, plus the social card at `public/og.jpg`.
 *
 * The originals are 2x retina captures of the app (3600x2168). Nothing on the
 * page ever renders one at full width — the hero peaks around 1300 device px
 * and the scene shots around 800 — so shipping the original as the only source
 * costs roughly 200KB and a 20ms decode per image for pixels no one sees.
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
const WIDTHS = [640, 960, 1280, 1920, 2560];
const WEBP = { quality: 82, effort: 6 };

/** The capture the social card is cropped from, and the card's fixed size. */
const OG_SOURCE = "02-live-session.webp";
const OG = { width: 1200, height: 630 };

const CAPTURE_RE = /\.(webp|png)$/;

async function emitLadder(file) {
  const src = path.join(SRC_DIR, file);
  const base = path.basename(file, path.extname(file));
  const { width: srcWidth, height: srcHeight } = await sharp(src).metadata();
  const widths = WIDTHS.filter((w) => w < srcWidth).concat(srcWidth);

  for (const width of widths) {
    const out = path.join(OUT_DIR, `${base}-${width}.webp`);
    // biome-ignore lint/performance/noAwaitInLoops: one resize at a time keeps memory flat.
    await sharp(src).resize({ width }).webp(WEBP).toFile(out);
  }
  return { base, widths, srcWidth, srcHeight };
}

async function emitSocialCard() {
  const src = path.join(SRC_DIR, OG_SOURCE);
  // `cover` rather than `contain`: a letterboxed card reads as a broken image
  // in a feed. Anchored north so the window chrome and sidebar survive the crop.
  await sharp(src)
    .resize({ ...OG, fit: "cover", position: "north" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(ROOT, "public", "og.jpg"));
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

  await emitSocialCard();
  process.stdout.write("og.jpg: 1200x630\n");

  // Consumed by src/lib/shots.ts so the srcset strings can never drift from
  // what is actually on disk.
  await writeFile(
    path.join(ROOT, "src", "lib", "shots.generated.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

await main();
