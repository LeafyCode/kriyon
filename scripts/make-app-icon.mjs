#!/usr/bin/env node
// Composes app-icon.svg: the purple glass mark (logo/logo-purple.svg) centered
// on a navy squircle tile with proper padding, following the Apple macOS icon
// grid (824x824 art area, 100px margin in a 1024 canvas). The mark occupies
// ~66% of the tile so it has real breathing room instead of running edge to
// edge. Regenerate every platform format with:
//
//   node scripts/make-app-icon.mjs      # writes app-icon.svg
//   pnpm tauri icon app-icon.svg        # -> src-tauri/icons/* (uses resvg)
//
// or just `pnpm icons`, which chains both.
//
// Notes for future edits:
//  - We use the bare mark (logo-purple.svg), not logo-purple-with-bg.svg: the
//    with-bg artwork scales the mark to fill the whole canvas, leaving no
//    padding once clipped to the squircle. Composing our own tile lets us
//    control the margin.
//  - The tile recreates the source's look: navy backdrop (#1A1D27) + a soft
//    purple glow (rgb 105,120,228) behind the mark.
//  - Rasterize with resvg (via `tauri icon`), not QuickLook: QuickLook flattens
//    onto opaque white (destroying the transparent corners a macOS icon needs).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logoPath = resolve(root, "logo/logo-purple.svg");
// Root copy is the `tauri icon` source; the src/assets copy is what the app UI
// (About panel, etc.) imports. Both are generated so they never drift.
const svgOut = resolve(root, "app-icon.svg");
const assetOut = resolve(root, "src/assets/app-icon.svg");

// Extract the drawable content (glow ellipse + glass mark) of the source mark.
const logoSrc = readFileSync(logoPath, "utf8");
const inner = logoSrc
  .replace(/^[\s\S]*?<svg\b[^>]*>/i, "")
  .replace(/<\/svg>\s*$/i, "")
  .trim();
const logoViewBox = /viewBox="([^"]+)"/i.exec(logoSrc)?.[1] ?? "0 0 653 733";
const [, , vbW, vbH] = logoViewBox.split(/\s+/).map(Number);

// Canvas + tile geometry (Apple macOS Big Sur grid).
const CANVAS = 1024;
const MARGIN = 100; // transparent margin around the tile
const TILE = CANVAS - MARGIN * 2; // 824
const RADIUS = Math.round(TILE * 0.2255); // continuous-corner squircle ≈ 186

// Mark sized to ~66% of the tile, then centered — this is the padding.
const markH = TILE * 0.66;
const scale = markH / vbH;
const markW = vbW * scale;
const markX = (CANVAS - markW) / 2;
const markY = (CANVAS - markH) / 2;

// Rounded-square (squircle) path used both to clip the tile and to stroke its edge.
const squircle = ((x, y, s, r) =>
  `M${x + r},${y} H${x + s - r} A${r},${r} 0 0 1 ${x + s},${y + r} ` +
  `V${y + s - r} A${r},${r} 0 0 1 ${x + s - r},${y + s} ` +
  `H${x + r} A${r},${r} 0 0 1 ${x},${y + s - r} ` +
  `V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`)(MARGIN, MARGIN, TILE, RADIUS);

const icon = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linecap:round;stroke-linejoin:round;">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#222736"/>
      <stop offset="0.55" stop-color="#1A1D27"/>
      <stop offset="1" stop-color="#15171F"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.46" r="0.5">
      <stop offset="0" stop-color="#6978E4" stop-opacity="0.30"/>
      <stop offset="0.6" stop-color="#6978E4" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#6978E4" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="krSquircle"><path d="${squircle}"/></clipPath>
  </defs>
  <g clip-path="url(#krSquircle)">
    <rect x="${MARGIN}" y="${MARGIN}" width="${TILE}" height="${TILE}" fill="url(#bg)"/>
    <rect x="${MARGIN}" y="${MARGIN}" width="${TILE}" height="${TILE}" fill="url(#glow)"/>
    <g transform="translate(${markX.toFixed(3)} ${markY.toFixed(3)}) scale(${scale.toFixed(6)})">
      ${inner}
    </g>
  </g>
  <path d="${squircle}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.5"/>
</svg>
`;

writeFileSync(svgOut, icon);
writeFileSync(assetOut, icon);
process.stdout.write(
  "app-icon.svg written — run `pnpm tauri icon app-icon.svg`\n"
);
