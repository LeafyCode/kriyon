import { useEffect, useRef, useState } from "react";
import { agentGraph } from "../lib/icosahedron.ts";
import { useIsVisible } from "../lib/useIsVisible.ts";

/** Activity rows the loop lights up, in % of the screenshot (it scales). */
const HITS = [
  { top: 13.9, label: "2 FILES CHANGED", tone: "blue" },
  { top: 18.6, label: "2 TESTS PASSED", tone: "green" },
  { top: 50.3, label: "WEB REQUEST", tone: "amber" },
  { top: 55.2, label: "WEB REQUEST", tone: "amber" },
  { top: 75, label: "PACKAGE INSTALLED", tone: "amber" },
] as const;

const AGENTS = {
  left: [
    { n: "01", verb: "READS", size: 120, yaw: 0.5, pitch: 0.35, lit: 1 },
    { n: "02", verb: "RUNS", size: 84, yaw: 1.1, pitch: -0.4, lit: 8 },
  ],
  right: [
    { n: "03", verb: "FETCHES", size: 104, yaw: -0.7, pitch: 0.6, lit: 9 },
    { n: "04", verb: "WRITES", size: 130, yaw: 0.2, pitch: -0.2, lit: 5 },
  ],
} as const;

const ART_SIZES = "(min-width: 1440px) 1040px, (min-width: 1100px) 72vw, 94vw";

function art(name: string): { src: string; srcSet: string } {
  return {
    src: `/art/${name}-1600.webp`,
    srcSet: `/art/${name}-960.webp 960w, /art/${name}-1600.webp 1600w`,
  };
}

/**
 * FIG. 1, a 12 s loop: the pencil sketch of the app is painted into the real
 * screenshot, the Activity rows light up, and it fades back to the sketch.
 * It runs only while on screen, and has its own pause (WCAG 2.2.2).
 */
export function FigOne() {
  const ref = useRef<HTMLElement>(null);
  const visible = useIsVisible(ref, 0.2);
  const [paused, setPaused] = useState(false);
  // Until its first play the loop would sit on its empty first frame, so the
  // CSS shows the whole sketch while this is false.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (visible && !paused) {
      setStarted(true);
    }
  }, [visible, paused]);

  return (
    <figure
      className="fig1"
      data-playing={visible && !paused}
      data-started={started}
      id="fig-1"
      ref={ref}
    >
      <figcaption className="fig1-caption">
        <span>
          <b>FIG. 1</b> · orbit-web · STRUCTURED VIEW + ACTIVITY
        </span>
        <span className="fig1-caption-end">
          SKETCH → RECORD · 12 s LOOP · DEMO PROJECT
          <button
            className="mini-button"
            onClick={() => setPaused(!paused)}
            type="button"
          >
            {paused ? "▶ PLAY" : "❚❚ PAUSE"}
          </button>
        </span>
      </figcaption>

      <div className="fig1-stage">
        <AgentColumn agents={AGENTS.left} />
        <div className="fig1-window-wrap">
          <div className="fig1-window">
            <img
              alt="Kriyon showing a session in the Structured view with the Activity tab open"
              className="fig1-sketch"
              decoding="async"
              height={977}
              sizes={ART_SIZES}
              width={1600}
              {...art("fig1-sketch")}
            />
            <img
              alt=""
              className="fig1-paint"
              decoding="async"
              height={977}
              loading="lazy"
              sizes={ART_SIZES}
              width={1600}
              {...art("fig1-app")}
            />
            <span aria-hidden="true" className="fig1-beam" />
            {HITS.map((hit, i) => (
              <span
                aria-hidden="true"
                className={`fig1-hit tone-${hit.tone}`}
                key={hit.top}
                style={{ top: `${hit.top}%`, animationDelay: `${i * 0.45}s` }}
              >
                <span className="fig1-hit-label">{hit.label}</span>
              </span>
            ))}
            <span aria-hidden="true" className="fig1-status">
              <span className="blink-dot" />
              <span className="fig1-status-words">
                <span className="fig1-l1">DRAFTING</span>
                <span className="fig1-l2">RECORDING</span>
                <span className="fig1-l3">ACTIVITY · 19 EVENTS</span>
              </span>
            </span>
          </div>
          <div aria-hidden="true" className="fig1-dims">
            <span>├─ SIDEBAR</span>
            <span>├─ STRUCTURED VIEW ──────────────┤</span>
            <span>ACTIVITY ─┤</span>
          </div>
        </div>
        <AgentColumn agents={AGENTS.right} />
      </div>
    </figure>
  );
}

interface AgentSpec {
  lit: number;
  n: string;
  pitch: number;
  size: number;
  verb: string;
  yaw: number;
}

function AgentColumn({ agents }: Readonly<{ agents: readonly AgentSpec[] }>) {
  return (
    <div aria-hidden="true" className="fig1-agents">
      {agents.map((a) => (
        <Agent key={a.n} {...a} />
      ))}
    </div>
  );
}

function Agent({ size, yaw, pitch, lit, n, verb }: Readonly<AgentSpec>) {
  const { nodes, edges } = agentGraph(size, yaw, pitch);
  const c = size / 2;
  const pad = Math.round(size * 0.18);
  return (
    <div className="agent">
      <svg
        aria-hidden="true"
        className="agent-svg"
        height={size}
        viewBox={`${-pad} 0 ${size + pad * 2} ${size}`}
        width={size}
      >
        <ellipse
          className="agent-orbit"
          cx={c}
          cy={c}
          rx={size * 0.625}
          ry={size * 0.19}
          transform={`rotate(-14 ${c} ${c})`}
        />
        {edges.map((e) => (
          <line
            className="agent-edge"
            key={`${e.a}-${e.b}`}
            strokeOpacity={e.opacity}
            x1={nodes[e.a].x}
            x2={nodes[e.b].x}
            y1={nodes[e.a].y}
            y2={nodes[e.b].y}
          />
        ))}
        {nodes.map((p, i) =>
          i === lit ? null : (
            <circle
              className="agent-node"
              cx={p.x}
              cy={p.y}
              key={`${p.x},${p.y}`}
              r={2.2}
            />
          )
        )}
        <circle
          className="agent-glow blink"
          cx={nodes[lit].x}
          cy={nodes[lit].y}
          r={9}
        />
        <circle
          className="agent-lit"
          cx={nodes[lit].x}
          cy={nodes[lit].y}
          r={3.6}
        />
      </svg>
      <span className="agent-label">
        AGENT.{n} · {verb}
      </span>
    </div>
  );
}
