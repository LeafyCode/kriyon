import "./mascot.css";
import type { ComponentType, CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type MascotHue, type MascotId, useLayout } from "../state/layout.ts";
import { tokens } from "../theme/tokens.ts";
import { GemArt, HexArt, VisorArt } from "./mascotArt.tsx";
import {
  type FaceId,
  faceFor,
  MOVE_MS,
  type MoveId,
  nextDelay,
  nextIdleFace,
  nextMove,
} from "./mascotMoves.ts";

/**
 * The [Mascot]: a small glowing AI orb at the top of the [Structured view],
 * picked in Settings with its hue — the Visor (default), the Gem or the Hex.
 * Drawn as layered vector art (`scripts/mascots.py`), it just floats; every
 * few seconds, and on a click, it plays a random trick (`mascotMoves.ts`)
 * with a face to match, and while Claude works it wears its thinking face,
 * thought bubbles rising. The motion is CSS (`mascot.css`); with reduced
 * motion it plays no tricks. Kriyon's own characters, not Claude Code's: no
 * Anthropic marks.
 */

export interface MascotChoice {
  Art: ComponentType;
  id: Exclude<MascotId, "none">;
  name: string;
}

export const MASCOTS: readonly MascotChoice[] = [
  { Art: VisorArt, id: "visor", name: "Visor" },
  { Art: GemArt, id: "gem", name: "Gem" },
  { Art: HexArt, id: "hex", name: "Hex" },
];

/** The hues, in the order Settings offers them. */
export const MASCOT_HUES: readonly { id: MascotHue; name: string }[] = [
  { id: "cobalt", name: "Cobalt" },
  { id: "violet", name: "Violet" },
  { id: "teal", name: "Teal" },
  { id: "amber", name: "Amber" },
  { id: "rose", name: "Rose" },
  { id: "graphite", name: "Graphite" },
];

/** The `--kr-m-*` variables that draw a mascot in `hue`. */
function hueVars(hue: MascotHue): CSSProperties {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens.mascot.hues[hue])) {
    vars[`--kr-m-${name}`] = value;
  }
  return vars as CSSProperties;
}

function prefersStillness(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** How often the idle face drifts to another: every 4–9 s. */
function faceDelay(): number {
  return 4000 + Math.random() * 5000;
}

/** The idle face of the moment, drifting while `lively`. */
function useIdleFace(lively: boolean): FaceId {
  const [face, setFace] = useState<FaceId>("happy");
  useEffect(() => {
    if (!lively || prefersStillness()) {
      return;
    }
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setFace((last) => nextIdleFace(last));
        schedule();
      }, faceDelay());
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [lively]);
  return face;
}

/**
 * The trick playing now, if any, and a way to play one at once. While
 * `lively`, a random one comes every few seconds — sooner while `busy` —
 * never the same twice in a row.
 */
function useMascotMoves(
  kind: MascotId,
  busy: boolean,
  lively: boolean
): { move: MoveId | null; play: () => void } {
  const [move, setMove] = useState<MoveId | null>(null);
  const last = useRef<MoveId | null>(null);
  const ending = useRef<number | undefined>(undefined);
  const play = useCallback(() => {
    if (kind === "none" || prefersStillness()) {
      return;
    }
    const next = nextMove(kind, busy, last.current);
    last.current = next;
    window.clearTimeout(ending.current);
    // Off for a frame first, so the same attribute value restarts it.
    setMove(null);
    window.requestAnimationFrame(() => setMove(next));
    ending.current = window.setTimeout(() => setMove(null), MOVE_MS[next]);
  }, [busy, kind]);
  useEffect(() => {
    if (!lively || kind === "none" || prefersStillness()) {
      return;
    }
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        play();
        schedule();
      }, nextDelay(busy));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [busy, kind, lively, play]);
  useEffect(() => () => window.clearTimeout(ending.current), []);
  return { move, play };
}

const buttonStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  display: "flex",
  padding: 0,
};

export function Mascot({
  busy,
  hue,
  kind,
  lively = false,
  size = 40,
}: {
  busy: boolean;
  /** Its hue; the user's choice when not given. */
  hue?: MascotHue;
  kind: MascotId;
  /** Plays random tricks, and one on a click. Off for a static preview. */
  lively?: boolean;
  size?: number;
}) {
  const { move, play } = useMascotMoves(kind, busy, lively);
  const idleFace = useIdleFace(lively);
  const chosenHue = useLayout((state) => state.layout.mascotHue);
  const choice = MASCOTS.find((m) => m.id === kind);
  if (choice === undefined) {
    return null;
  }
  const { Art } = choice;
  const art = (
    <svg
      aria-hidden="true"
      className="kr-mascot"
      data-busy={busy ? "" : undefined}
      data-face={faceFor(move, busy, idleFace)}
      data-mascot={choice.id}
      data-move={move ?? undefined}
      height={size}
      style={hueVars(hue ?? chosenHue)}
      viewBox="0 0 200 200"
      width={size}
    >
      <g className="whole">
        <Art />
      </g>
    </svg>
  );
  if (!lively) {
    return art;
  }
  return (
    <button
      aria-label={`${choice.name}: play a trick`}
      className="kr-focusable"
      onClick={play}
      style={buttonStyle}
      title="Play a trick"
      type="button"
    >
      {art}
    </button>
  );
}
