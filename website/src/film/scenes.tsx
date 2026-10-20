/* The eight scenes of the product film — ported from kriyon-video.jsx.
   Screen-Studio style: real screenshots, damped camera, one caption at a time. */

import { clamp, lerp, lerpCam, MOTION, proj } from "./motion.ts";
import {
  CAM,
  Caption,
  Cursor,
  DIM,
  Frame,
  IND,
  INK,
  Keycap,
  LAV,
  Marker,
  MONO,
  SANS,
  SHOTS,
} from "./parts.tsx";

export interface SceneProps {
  progress: number;
}

export function Opening({ progress: p }: SceneProps) {
  const cam = lerpCam(
    CAM.appOpen,
    CAM.appWide,
    MOTION.glide(p, 0, 1, 0.46, 0.94)
  );
  const dim = MOTION.glide(p, 0.86, 0, 0.44, 0.9);
  const lines = ["Every session.", "Every project.", "One window."];
  const blockOut = 1 - MOTION.glide(p, 0, 1, 0.7, 0.88);
  return (
    <Frame
      cam={cam}
      overlay={
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `rgba(4,5,10,${dim})`,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 124,
              top: 300,
              width: 1400,
              opacity: blockOut,
            }}
          >
            <div
              style={{
                font: `500 22px/1 ${MONO}`,
                letterSpacing: "0.22em",
                color: LAV,
                textTransform: "uppercase",
                marginBottom: 46,
                opacity: MOTION.enter(p, 0.02, 0.18),
              }}
            >
              Kriyon
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {lines.map((line, i) => {
                const op = MOTION.enter(p, 0.08 + i * 0.16, 0.2);
                return (
                  <div
                    key={line}
                    style={{
                      font: `400 92px/1.06 ${SANS}`,
                      letterSpacing: "-0.03em",
                      color: i === 2 ? INK : DIM,
                      opacity: op,
                      transform: `translateY(${(1 - op) * 22}px)`,
                    }}
                  >
                    {line}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      }
      p={p}
      shot={SHOTS.app}
    />
  );
}

export function Sessions({ progress: p }: SceneProps) {
  const cam = lerpCam(
    CAM.appWide,
    CAM.sidebar,
    MOTION.glide(p, 0, 1, 0.16, 0.62)
  );
  const cap = Math.min(
    MOTION.enter(p, 0.06, 0.16),
    1 - MOTION.glide(p, 0, 1, 0.88, 0.98)
  );
  const groups = [
    { y: 0.208, s: 0.34 },
    { y: 0.34, s: 0.44 },
    { y: 0.442, s: 0.54 },
    { y: 0.562, s: 0.64 },
  ];
  const fade = 1 - MOTION.glide(p, 0, 1, 0.86, 0.97);
  return (
    <Frame
      cam={cam}
      overlay={
        <>
          {groups.map((g) => (
            <Marker
              cam={cam}
              key={g.y}
              op={Math.min(MOTION.enter(p, g.s, 0.12), fade)}
              shot={SHOTS.app}
              x1={0.056}
              x2={0.225}
              y1={g.y - 0.015}
              y2={g.y + 0.016}
            />
          ))}
          <Caption
            head="Every session sits under the project it belongs to."
            kicker="Many sessions"
            op={cap}
          />
        </>
      }
      p={p}
      shot={SHOTS.app}
    />
  );
}

export function NeedsYou({ progress: p }: SceneProps) {
  const cam = lerpCam(
    CAM.sidebar,
    CAM.needs,
    MOTION.glide(p, 0, 1, 0.05, 0.42)
  );
  const cap = Math.min(
    MOTION.enter(p, 0.08, 0.16),
    1 - MOTION.glide(p, 0, 1, 0.9, 0.99)
  );
  const mark = MOTION.enter(p, 0.16, 0.16);
  const notif = MOTION.enter(p, 0.46, 0.18);
  return (
    <Frame
      cam={cam}
      overlay={
        <>
          <Marker
            cam={cam}
            fill
            op={mark}
            shot={SHOTS.app}
            x1={0.056}
            x2={0.225}
            y1={0.117}
            y2={0.176}
          />
          <div
            style={{
              position: "absolute",
              right: 96,
              top: 92,
              width: 604,
              opacity: notif,
              transform: `translateX(${(1 - notif) * 120}px)`,
              display: "flex",
              gap: 20,
              padding: "24px 26px",
              borderRadius: 20,
              background: "rgba(18,20,32,0.94)",
              border: "1px solid rgba(168,190,255,0.16)",
              boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
            }}
          >
            <img
              alt=""
              draggable={false}
              height={54}
              loading="lazy"
              src="/logo-purple-with-bg.svg"
              style={{
                width: 54,
                height: 54,
                borderRadius: 13,
                flex: "0 0 auto",
              }}
              width={54}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  font: `500 21px/1 ${SANS}`,
                  color: INK,
                  letterSpacing: "0.01em",
                }}
              >
                Kriyon · orbit-web
              </div>
              <div style={{ font: `400 20px/1.35 ${SANS}`, color: DIM }}>
                Choose onboarding empty state is waiting for your reply.
              </div>
            </div>
          </div>
          <Caption
            head="Blocked sessions get pinned to the top. And a notification."
            kicker="Needs you"
            op={cap}
          />
        </>
      }
      p={p}
      shot={SHOTS.app}
    />
  );
}

export function MenuBar({ progress: p }: SceneProps) {
  const shot = SHOTS.pop;
  const cam = lerpCam(
    CAM.popWide,
    CAM.popRows,
    MOTION.glide(p, 0, 1, 0.1, 0.9)
  );
  const cap = Math.min(
    MOTION.enter(p, 0.1, 0.16),
    1 - MOTION.glide(p, 0, 1, 0.9, 0.99)
  );
  // cursor: menu-bar icon → the row that needs you → the running row
  const t1 = MOTION.glide(p, 0, 1, 0.16, 0.36);
  const t2 = MOTION.glide(p, 0, 1, 0.6, 0.8);
  const a = proj(cam, shot, 0.104, 0.076);
  const b = proj(cam, shot, 0.35, 0.325);
  const c = proj(cam, shot, 0.38, 0.57);
  const cx = lerp(lerp(a.x, b.x, t1), c.x, t2);
  const cy = lerp(lerp(a.y, b.y, t1), c.y, t2);
  const click = MOTION.pop(p, 0.4, 0.54);
  return (
    <Frame
      cam={cam}
      overlay={
        <>
          <Marker
            cam={cam}
            fill
            op={Math.min(
              MOTION.enter(p, 0.36, 0.1),
              1 - MOTION.glide(p, 0, 1, 0.62, 0.72)
            )}
            shot={shot}
            x1={0.07}
            x2={0.93}
            y1={0.295}
            y2={0.355}
          />
          <Cursor click={click} x={cx} y={cy} />
          <Caption
            head="Or glance at it without opening the app."
            kicker="Menu bar"
            op={cap}
          />
        </>
      }
      p={p}
      shot={shot}
    />
  );
}

export function Palette({ progress: p }: SceneProps) {
  const shot = SHOTS.palette;
  const cam = lerpCam(
    CAM.appWide,
    CAM.palette,
    MOTION.glide(p, 0, 1, 0.06, 0.5)
  );
  const cap = Math.min(
    MOTION.enter(p, 0.08, 0.16),
    1 - MOTION.glide(p, 0, 1, 0.9, 0.99)
  );
  const rows = [0.212, 0.268, 0.326];
  const step = MOTION.glide(p, 0, 2, 0.3, 0.66);
  const i = Math.min(Math.floor(step), 1);
  const y = lerp(rows[i], rows[i + 1], step - i);
  const band = MOTION.enter(p, 0.26, 0.14);
  return (
    <Frame
      cam={cam}
      overlay={
        <>
          <Marker
            cam={cam}
            fill
            op={band}
            r={8}
            shot={shot}
            x1={0.33}
            x2={0.672}
            y1={y - 0.025}
            y2={y + 0.025}
          />
          <Caption
            head={
              <span>
                Jump to any session, or run any action, from anywhere.{" "}
                <Keycap label="⌘K" />
              </span>
            }
            kicker="Command palette"
            op={cap}
          />
        </>
      }
      p={p}
      shot={shot}
    />
  );
}

export function Prompts({ progress: p }: SceneProps) {
  const shot = SHOTS.prompts;
  const cam = lerpCam(
    CAM.appWide,
    CAM.prompts,
    MOTION.glide(p, 0, 1, 0.06, 0.48)
  );
  const cap = Math.min(
    MOTION.enter(p, 0.08, 0.16),
    1 - MOTION.glide(p, 0, 1, 0.9, 0.99)
  );
  const y = lerp(0.339, 0.401, MOTION.glide(p, 0, 1, 0.34, 0.56));
  const band = MOTION.enter(p, 0.28, 0.14);
  const cur = proj(cam, shot, 0.4, y);
  const preview = Math.min(
    MOTION.enter(p, 0.62, 0.16),
    1 - MOTION.glide(p, 0, 1, 0.92, 0.99)
  );
  return (
    <Frame
      cam={cam}
      overlay={
        <>
          <Marker
            cam={cam}
            fill
            op={band}
            r={8}
            shot={shot}
            x1={0.235}
            x2={0.56}
            y1={y - 0.028}
            y2={y + 0.028}
          />
          <Marker
            cam={cam}
            op={preview}
            shot={shot}
            x1={0.57}
            x2={0.775}
            y1={0.245}
            y2={0.415}
          />
          <Cursor
            click={MOTION.pop(p, 0.58, 0.7)}
            op={band}
            x={cur.x}
            y={cur.y}
          />
          <Caption
            head={
              <span>
                Insert a saved prompt. Kriyon never sends it for you.{" "}
                <Keycap label="⌘⇧P" />
              </span>
            }
            kicker="Prompt library"
            op={cap}
          />
        </>
      }
      p={p}
      shot={shot}
    />
  );
}

export function Worktrees({ progress: p }: SceneProps) {
  const shot = SHOTS.changes;
  const camA = lerpCam(
    CAM.changes,
    CAM.diff,
    MOTION.glide(p, 0, 1, 0.14, 0.42)
  );
  const cam = lerpCam(camA, CAM.merge, MOTION.glide(p, 0, 1, 0.56, 0.74));
  const cap = Math.min(
    MOTION.enter(p, 0.06, 0.14),
    1 - MOTION.glide(p, 0, 1, 0.92, 0.99)
  );
  const branch = Math.min(
    MOTION.enter(p, 0.05, 0.1),
    1 - MOTION.glide(p, 0, 1, 0.2, 0.3)
  );
  const card = MOTION.enter(p, 0.6, 0.16);
  const done = MOTION.glide(p, 0, 1, 0.84, 0.92);
  const btn = { x: 1300, y: 664 };
  const from = proj(cam, shot, 0.58, 0.34);
  const t = MOTION.glide(p, 0, 1, 0.68, 0.8);
  const merged = done > 0.5;
  return (
    <Frame
      cam={cam}
      overlay={
        <>
          <Marker
            cam={cam}
            op={branch}
            r={8}
            shot={shot}
            x1={0.435}
            x2={0.53}
            y1={0.07}
            y2={0.102}
          />
          <div
            style={{
              position: "absolute",
              left: 540,
              top: 596,
              width: 860,
              opacity: card,
              transform: `translateY(${(1 - card) * 40}px)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 32,
              padding: "26px 30px",
              borderRadius: 20,
              background: "rgba(16,18,30,0.95)",
              border: "1px solid rgba(168,190,255,0.16)",
              boxShadow: "0 30px 90px rgba(0,0,0,0.65)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div
                style={{
                  font: `500 20px/1 ${MONO}`,
                  color: LAV,
                  letterSpacing: "0.04em",
                }}
              >
                {merged ? "merged" : "worktree"}
              </div>
              <div style={{ font: `400 26px/1.3 ${SANS}`, color: INK }}>
                {merged
                  ? "feat/command-palette is in main. Worktree removed."
                  : "feat/command-palette · 3 files, +184 −26"}
              </div>
            </div>
            <div
              style={{
                padding: "16px 26px",
                borderRadius: 12,
                whiteSpace: "nowrap",
                background: merged ? "rgba(105,120,228,0.18)" : IND,
                border: `1px solid rgba(168,190,255,${merged ? 0.3 : 0.5})`,
                font: `500 24px/1 ${SANS}`,
                color: merged ? LAV : "#0b0d18",
              }}
            >
              {merged ? "Archived" : "Merge into main"}
            </div>
          </div>
          <Cursor
            click={MOTION.pop(p, 0.8, 0.9)}
            op={card}
            x={lerp(from.x, btn.x, t)}
            y={lerp(from.y, btn.y, t)}
          />
          <Caption
            head="Each session on its own branch. Review the diff, then merge."
            kicker="Worktrees"
            op={cap}
          />
        </>
      }
      p={p}
      shot={shot}
    />
  );
}

export function EndCard({ progress: p }: SceneProps) {
  const drift = Math.sin(clamp(p, 0, 1) * Math.PI);
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
          top: "50%",
          width: 1700,
          height: 1700,
          marginLeft: -850,
          marginTop: -850 - drift * 10,
          borderRadius: "50%",
          background:
            "radial-gradient(closest-side, rgba(105,120,228,0.26), rgba(105,120,228,0))",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
          transform: `translateY(${-drift * 10}px)`,
        }}
      >
        <img
          alt=""
          draggable={false}
          height={224}
          loading="lazy"
          src="/logo-purple.svg"
          style={{
            width: 200,
            height: 224,
            transform: `scale(${1 + drift * 0.02})`,
          }}
          width={200}
        />
        <div
          style={{
            font: `400 104px/1 ${SANS}`,
            color: INK,
            letterSpacing: "-0.03em",
          }}
        >
          Kriyon
        </div>
        <div
          style={{
            font: `400 40px/1.35 ${SANS}`,
            color: DIM,
            textAlign: "center",
            maxWidth: 1180,
          }}
        >
          Run many Claude Code sessions without losing track of any of them.
        </div>
        <div
          style={{
            marginTop: 18,
            font: `500 24px/1 ${MONO}`,
            color: LAV,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          macOS · wraps your own claude CLI
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 56,
          textAlign: "center",
          font: `400 20px/1 ${SANS}`,
          color: "rgba(226,232,255,0.4)",
        }}
      >
        Not affiliated with Anthropic.
      </div>
    </div>
  );
}
