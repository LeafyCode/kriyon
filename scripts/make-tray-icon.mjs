#!/usr/bin/env node
// Generates the macOS menu-bar (tray) icon: the Kriyon "fi" gem mark as a
// monochrome template image. macOS treats a template image as an alpha mask and
// tints it itself — dark on a light menu bar, light on a dark one — so a SINGLE
// image covers both appearances. That is why we do NOT ship a separate dark
// variant, and why the source colour here is irrelevant (we use black; only the
// alpha matters). The tray builder sets `.icon_as_template(true)`.
//
//   node scripts/make-tray-icon.mjs   # -> src-tauri/icons/menubar-icon.png
//
// or `pnpm icons`, which regenerates every icon.
//
// Design notes for future edits:
//  - The facet seams are rendered as TRANSPARENT gaps (the menu bar shows
//    through) via a luminance mask — see below. In both light and dark bars
//    those gaps are the gem's internal definition; a solid silhouette loses it.
//  - Border boldness comes from the source's stroke width. logo-fi-white.svg
//    ships a thick stroke on purpose; leave its fills/strokes untouched so the
//    mask picks them up. The mark is portrait, so it is fitted to the tile
//    height with ~9% vertical padding for menu-bar breathing room.
//  - Rasterised with resvg via `tauri icon --png` (preserves real alpha; note
//    QuickLook would flatten it onto opaque white).

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logoPath = resolve(root, "logo/logo-fi-white.svg");
const outPng = resolve(root, "src-tauri/icons/menubar-icon.png");

// 22pt menu bar at @2x = 44px; macOS/tray-icon downsamples the source to fit the
// bar, so this is the crisp retina target.
const PX = 44;

// Extract the drawable content of the mark (drop the <svg> wrapper).
const logoSrc = readFileSync(logoPath, "utf8");
const inner = logoSrc
  .replace(/^[\s\S]*?<svg\b[^>]*>/i, "")
  .replace(/<\/svg>\s*$/i, "")
  .trim();
const logoViewBox = /viewBox="([^"]+)"/i.exec(logoSrc)?.[1] ?? "0 0 1339 1487";
const [, , vbW, vbH] = logoViewBox.split(/\s+/).map(Number);

// Square tile; fit the (portrait) mark to the tile height with padding.
// macOS scales the WHOLE tile (padding included) down to the menu-bar height, so
// any padding here directly shrinks the glyph relative to neighbouring extras.
// Keep it minimal — just enough breathing room that the mark does not touch the
// bar's top/bottom edge.
const TILE = vbH;
const PAD = Math.round(TILE * 0.03);
const scale = (TILE - PAD * 2) / vbH;
const tx = (TILE - vbW * scale) / 2;
const ty = PAD;

// The facet borders must read in the menu bar. In a template image (alpha mask)
// the borders can only show by being TRANSPARENT so the bar shows through — a
// flat black fill would swallow them. So we drive an SVG luminance mask with the
// source art unchanged: its white facets (luminance 1) become opaque, its black
// strokes (luminance 0) become transparent gaps. The mask is applied to a black
// rectangle, yielding an opaque gem cut by transparent facet seams. The source's
// stroke width (thick, per the artwork) sets how bold those seams are.
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;">
  <defs>
    <mask id="gem" maskUnits="userSpaceOnUse" x="0" y="0" width="${TILE}" height="${TILE}">
      <g transform="translate(${tx.toFixed(3)} ${ty}) scale(${scale.toFixed(6)})">
        ${inner}
      </g>
    </mask>
  </defs>
  <rect width="${TILE}" height="${TILE}" fill="#000000" mask="url(#gem)"/>
</svg>
`;

// `tauri icon --png <n>` writes `<n>x<n>.png` into its output dir; rasterise in a
// temp dir, then copy the single file we want to its committed home.
const work = mkdtempSync(join(tmpdir(), "kriyon-tray-"));
try {
  const svgPath = join(work, "menubar.svg");
  writeFileSync(svgPath, svg);
  execFileSync(
    "pnpm",
    ["tauri", "icon", svgPath, "-o", work, "--png", String(PX)],
    {
      cwd: root,
      stdio: "inherit",
    }
  );
  copyFileSync(join(work, `${PX}x${PX}.png`), outPng);
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write(`menu-bar icon written -> ${outPng}\n`);
