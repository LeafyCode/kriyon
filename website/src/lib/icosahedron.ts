/**
 * A wireframe icosahedron, turned and projected flat: the "agents" that stand
 * beside FIG. 1. Computed rather than pasted so each agent can lean its own way.
 */

const PHI = (1 + Math.sqrt(5)) / 2;

const VERTICES: readonly (readonly [number, number, number])[] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];

/** Neighbouring vertices sit exactly 2 apart; every other pair is farther. */
const EDGES: readonly (readonly [number, number])[] = VERTICES.flatMap((a, i) =>
  VERTICES.slice(i + 1).flatMap((b, k) =>
    Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - 2) < 1e-9
      ? [[i, i + 1 + k] as const]
      : []
  )
);

export interface AgentGraph {
  edges: { a: number; b: number; opacity: number }[];
  nodes: { x: number; y: number }[];
}

/** Edges at the back fade to this; edges at the front reach FRONT_OPACITY. */
const BACK_OPACITY = 0.3;
const FRONT_OPACITY = 0.68;

/**
 * The solid turned by `yaw` then `pitch` (radians) and fitted to a `size`
 * square. Depth only sets edge opacity, which is what makes it read as 3D.
 */
export function agentGraph(size: number, yaw: number, pitch: number) {
  const turned = VERTICES.map(([x, y, z]) => {
    const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
    const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
    const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch);
    return [x1, y2, z2] as const;
  });
  const reach = Math.max(...turned.map(([x, y]) => Math.max(-x, x, -y, y)));
  const scale = size / 2 / reach;
  const nodes = turned.map(([x, y]) => ({
    x: round(size / 2 + x * scale),
    y: round(size / 2 - y * scale),
  }));
  const depth = Math.hypot(1, PHI);
  const edges = EDGES.map(([a, b]) => {
    const z = (turned[a][2] + turned[b][2]) / 2 / depth;
    const t = (z + 1) / 2;
    return {
      a,
      b,
      opacity: round(BACK_OPACITY + (FRONT_OPACITY - BACK_OPACITY) * t),
    };
  });
  return { nodes, edges } satisfies AgentGraph;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
