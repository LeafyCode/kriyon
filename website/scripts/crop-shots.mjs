/**
 * Cuts each raw macOS window capture (⇧⌘4, Space) off its white margin and
 * drop shadow, rounds the corners back to transparent, and writes the result
 * to `shots-src/` for `build-shots.mjs` to turn into width ladders.
 *
 * The window is found as the bounding box of its dark pixels, so the capture
 * offset (it moves 50–90 px between shots) never has to be measured by hand.
 *
 *   node scripts/crop-shots.mjs <folder of raw captures>
 *
 * Only the captures named in SHOTS are cut; the rest of the folder is ignored.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "shots-src");

/** Output name → the capture's clock time in its macOS file name. */
const SHOTS = {
  session: "4.56.00",
  structured: "4.52.27",
  changes: "4.49.06",
  activity: "4.48.37",
  "menu-bar": "4.55.44",
};

/** Darker than this is window; the shadow and margin are all lighter. */
const DARK = 90;
/** The menu bar capture has the system's own icons along its top edge. */
const MENU_BAR_TOP = 50;
const WEBP = { quality: 92, effort: 6 };

function windowBox(data, width, height, top) {
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = top; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      if ((data[i] + data[i + 1] + data[i + 2]) / 3 < DARK) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** The corner radius: how far along the top edge the first dark pixel sits. */
function cornerRadius(data, width, box) {
  for (let x = box.left; x < box.left + box.width; x += 1) {
    const i = (box.top * width + x) * 3;
    if ((data[i] + data[i + 1] + data[i + 2]) / 3 < DARK) {
      return x - box.left;
    }
  }
  return 0;
}

async function cut(src, name) {
  const { data, info } = await sharp(src)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const top = name === "menu-bar" ? MENU_BAR_TOP : 0;
  const box = windowBox(data, info.width, info.height, top);
  const r = cornerRadius(data, info.width, box);
  const mask = Buffer.from(
    `<svg width="${box.width}" height="${box.height}"><rect width="100%" height="100%" rx="${r}" ry="${r}"/></svg>`
  );
  await sharp(src)
    .extract(box)
    .composite([{ input: mask, blend: "dest-in" }])
    .webp(WEBP)
    .toFile(path.join(OUT_DIR, `${name}.webp`));
  process.stdout.write(`${name}: ${box.width}x${box.height}, r=${r}\n`);
}

async function main() {
  const [, , dir] = process.argv;
  if (!dir) {
    throw new Error("usage: node scripts/crop-shots.mjs <captures folder>");
  }
  const files = await readdir(dir);
  for (const [name, time] of Object.entries(SHOTS)) {
    const file = files.find((f) => f.includes(time) && f.endsWith(".png"));
    if (!file) {
      throw new Error(`no capture at ${time} in ${dir}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: one 4K image at a time keeps memory flat.
    await cut(path.join(dir, file), name);
  }
}

await main();
