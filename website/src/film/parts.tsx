/* Shared building blocks of the product film — ported from kriyon-video.jsx.
   Everything is positioned on a fixed 1920×1080 stage, so literal px values
   are the coordinate system, not styling to tokenize. The palette and the
   Helvetica-based SANS stack are intentionally frozen to the video port —
   they do not follow the site's CSS tokens. */

import type { CSSProperties, ReactNode } from "react";
import { shotAt } from "../lib/shots.ts";
import { type Camera, proj, type Shot, STAGE_H, STAGE_W } from "./motion.ts";

export const INK = "#eef1ff";
export const DIM = "rgba(226,232,255,0.66)";
export const LAV = "#a8beff";
export const IND = "#6978e4";
export const SANS =
  '"Helvetica Neue", Helvetica, "Segoe UI", system-ui, sans-serif';
export const MONO =
  '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace';

/* The stage-space size each capture is drawn at. The 4K app captures are 2×
   retina, so they halve; the menu-bar capture is already 1× at 800×1080.
   The stage is a fixed coordinate system scaled by CSS, so the browser cannot
   choose a rung from a `sizes` hint — each source is pinned to the one width
   the stage actually draws it at. */
export const SHOTS = {
  app: { src: shotAt("02-live-session", 1800), w: 1800, h: 1084 },
  palette: { src: shotAt("03-command-palette", 1800), w: 1800, h: 1084 },
  prompts: { src: shotAt("04-prompt-library", 1800), w: 1800, h: 1084 },
  changes: { src: shotAt("01-changes-review", 1800), w: 1800, h: 1084 },
  pop: { src: shotAt("05-menu-bar-triage-portrait", 800), w: 800, h: 1080 },
} satisfies Record<string, Shot>;

/* cameras: z = zoom, cx/cy = focus point in normalized screenshot space */
export const CAM = {
  appOpen: { z: 1.04, cx: 0.5, cy: 0.5 },
  appWide: { z: 1.0, cx: 0.5, cy: 0.5 },
  sidebar: { z: 1.4, cx: 0.42, cy: 0.4 },
  needs: { z: 1.5, cx: 0.4, cy: 0.36 },
  popWide: { z: 1.05, cx: 0.5, cy: 0.46 },
  popRows: { z: 1.22, cx: 0.5, cy: 0.45 },
  palette: { z: 1.35, cx: 0.5, cy: 0.4 },
  prompts: { z: 1.35, cx: 0.5, cy: 0.45 },
  changes: { z: 1.04, cx: 0.5, cy: 0.45 },
  diff: { z: 1.5, cx: 0.55, cy: 0.36 },
  merge: { z: 1.12, cx: 0.52, cy: 0.42 },
} satisfies Record<string, Camera>;

interface FrameProps {
  cam: Camera;
  inShot?: ReactNode;
  overlay?: ReactNode;
  p: number;
  shot: Shot;
}

/** A screenshot under a damped camera, with the film's vignette + floor fade. */
export function Frame({ shot, cam, p, inShot, overlay }: FrameProps) {
  const breathe = Math.sin(p * Math.PI);
  const x = STAGE_W / 2 - cam.cx * shot.w * cam.z;
  const y = STAGE_H / 2 - cam.cy * shot.h * cam.z;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "#05060b",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          marginLeft: -1000,
          top: -560 - breathe * 14,
          width: 2000,
          height: 1120,
          borderRadius: "50%",
          background:
            "radial-gradient(closest-side, rgba(105,120,228,0.20), rgba(105,120,228,0))",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: shot.w,
          height: shot.h,
          transformOrigin: "0 0",
          transform: `translate(${x}px, ${y}px) scale(${cam.z})`,
        }}
      >
        {/* `lazy` keeps React from hoisting a preload for it: the film sits far
            below the fold, and a ~90KB capture in the head competes with the
            hero for the LCP. FilmStage warms every shot itself on first sighting. */}
        <img
          alt=""
          draggable={false}
          height={shot.h}
          loading="lazy"
          src={shot.src}
          style={{ display: "block", width: shot.w, height: shot.h }}
          width={shot.w}
        />
        {inShot}
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(125% 85% at 50% 48%, rgba(0,0,0,0) 42%, rgba(0,0,0,0.5) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 320,
          pointerEvents: "none",
          background:
            "linear-gradient(to top, rgba(4,5,10,0.94) 0%, rgba(4,5,10,0.72) 38%, rgba(4,5,10,0) 100%)",
        }}
      />
      {overlay}
    </div>
  );
}

export function Caption({
  kicker,
  head,
  op,
}: {
  kicker: string;
  head: ReactNode;
  op: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 124,
        bottom: 108,
        width: 1260,
        opacity: op,
        transform: `translateY(${(1 - op) * 16}px)`,
      }}
    >
      <div
        style={{
          font: `500 22px/1 ${MONO}`,
          letterSpacing: "0.22em",
          color: LAV,
          textTransform: "uppercase",
          marginBottom: 22,
        }}
      >
        {kicker}
      </div>
      <div
        style={
          {
            font: `400 52px/1.18 ${SANS}`,
            color: INK,
            letterSpacing: "-0.015em",
            textWrap: "pretty",
            maxWidth: 1180,
          } as CSSProperties
        }
      >
        {head}
      </div>
    </div>
  );
}

interface MarkerProps {
  cam: Camera;
  fill?: boolean;
  op: number;
  r?: number;
  shot: Shot;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** selection / focus outline drawn in screenshot space */
export function Marker({
  cam,
  shot,
  x1,
  y1,
  x2,
  y2,
  op,
  fill = false,
  r = 10,
}: MarkerProps) {
  const a = proj(cam, shot, x1, y1);
  const b = proj(cam, shot, x2, y2);
  return (
    <div
      style={{
        position: "absolute",
        left: a.x,
        top: a.y,
        width: b.x - a.x,
        height: b.y - a.y,
        border: `2px solid rgba(168,190,255,${0.92 * op})`,
        borderRadius: r,
        background: fill ? `rgba(105,120,228,${0.24 * op})` : "transparent",
        boxShadow: `0 0 ${28 * op}px rgba(105,120,228,${0.5 * op})`,
        pointerEvents: "none",
      }}
    />
  );
}

export function Cursor({
  x,
  y,
  click = 0,
  op = 1,
}: {
  x: number;
  y: number;
  click?: number;
  op?: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        opacity: op,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: -46,
          top: -46,
          width: 92,
          height: 92,
          borderRadius: "50%",
          border: `2px solid rgba(168,190,255,${0.75 * click})`,
          transform: `scale(${0.35 + click * 0.85})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -13,
          top: -13,
          width: 26,
          height: 26,
          borderRadius: "50%",
          background: "#fdfdff",
          border: "2px solid rgba(10,12,24,0.55)",
          boxShadow: "0 6px 18px rgba(0,0,0,0.55)",
          transform: `scale(${1 - click * 0.12})`,
        }}
      />
    </div>
  );
}

export function Keycap({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "6px 12px",
        borderRadius: 8,
        border: "1px solid rgba(168,190,255,0.28)",
        background: "rgba(105,120,228,0.16)",
        font: `500 26px/1 ${MONO}`,
        color: INK,
        verticalAlign: "middle",
      }}
    >
      {label}
    </span>
  );
}
