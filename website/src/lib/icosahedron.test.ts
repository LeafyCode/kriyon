import { expect, test } from "vitest";
import { agentGraph } from "./icosahedron.ts";

test("an icosahedron has 12 corners and 30 edges", () => {
  const { nodes, edges } = agentGraph(120, 0.5, 0.35);
  expect(nodes).toHaveLength(12);
  expect(edges).toHaveLength(30);
});

test("every corner fits the square it is drawn in", () => {
  const size = 84;
  for (const { x, y } of agentGraph(size, 1.1, -0.4).nodes) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(size);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(size);
  }
});

test("back edges are fainter than front edges, within the set range", () => {
  const opacities = agentGraph(100, 0.2, -0.2).edges.map((e) => e.opacity);
  expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.3);
  expect(Math.max(...opacities)).toBeLessThanOrEqual(0.68);
  expect(Math.max(...opacities)).toBeGreaterThan(Math.min(...opacities));
});
