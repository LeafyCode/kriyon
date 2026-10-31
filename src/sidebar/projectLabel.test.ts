import { expect, test } from "vitest";
import type { ProjectRow } from "../types.ts";
import { projectLabels } from "./projectLabel.ts";

function project(name: string, path: string): ProjectRow {
  return {
    color: null,
    id: path,
    name,
    path,
    parkedAt: null,
    setupCommand: null,
  };
}

/** A rail like a real one: three `acme`, two `bisbig`, two `globex-app`. */
const REAL = [
  project("acme", "/Users/p/Projects/Acme/acme"),
  project("acme", "/Users/p/Projects/Acme/review/acme"),
  project("acme", "/Users/p/Projects/Acme/review2/acme"),
  project("bisbig", "/Users/p/Projects/BisBig/bisbig"),
  project("bisbig", "/Users/p/Projects/BisBig/review/bisbig"),
  project("globex-app", "/Users/p/Projects/Globex/globex-app"),
  project("globex-app", "/Users/p/Projects/Initech/globex-app"),
  project("kriyon", "/Users/p/Projects/kriyon"),
  project("globex-mint", "/Users/p/Projects/Globex/globex-mint"),
];

test("a name nothing collides with carries no qualifier", () => {
  // The whole point of the *minimal* rule: the 10 projects that are already
  // unambiguous must render exactly as they did before.
  const labels = projectLabels(REAL);
  expect(labels.get("/Users/p/Projects/kriyon")).toEqual({
    name: "kriyon",
    qualifier: null,
  });
  expect(
    labels.get("/Users/p/Projects/Globex/globex-mint")?.qualifier
  ).toBeNull();
});

test("colliding names take the shallowest parent segment that separates them", () => {
  const labels = projectLabels(REAL);
  expect(labels.get("/Users/p/Projects/Acme/acme")?.qualifier).toBe("Acme/");
  expect(labels.get("/Users/p/Projects/Acme/review/acme")?.qualifier).toBe(
    "review/"
  );
  expect(labels.get("/Users/p/Projects/Acme/review2/acme")?.qualifier).toBe(
    "review2/"
  );
  // Two-way collisions resolve at the same depth.
  expect(labels.get("/Users/p/Projects/Globex/globex-app")?.qualifier).toBe(
    "Globex/"
  );
  expect(labels.get("/Users/p/Projects/Initech/globex-app")?.qualifier).toBe(
    "Initech/"
  );
});

test("the name is always carried through unchanged", () => {
  for (const [, label] of projectLabels(REAL)) {
    expect(REAL.some((row) => row.name === label.name)).toBe(true);
  }
});

test("a shared parent forces the qualifier one segment deeper", () => {
  // `review/` alone would be ambiguous here, so both must grow to two segments.
  const labels = projectLabels([
    project("api", "/w/alpha/review/api"),
    project("api", "/w/beta/review/api"),
  ]);
  expect(labels.get("/w/alpha/review/api")?.qualifier).toBe("alpha/review/");
  expect(labels.get("/w/beta/review/api")?.qualifier).toBe("beta/review/");
});

test("only the ambiguous depth grows — a sibling that separated early stays short", () => {
  // `solo/` is unique at depth 1, so it must not be dragged deeper just
  // because its two peers needed another segment to come apart.
  const labels = projectLabels([
    project("api", "/w/solo/api"),
    project("api", "/w/alpha/review/api"),
    project("api", "/w/beta/review/api"),
  ]);
  expect(labels.get("/w/solo/api")?.qualifier).toBe("solo/");
  expect(labels.get("/w/alpha/review/api")?.qualifier).toBe("alpha/review/");
  expect(labels.get("/w/beta/review/api")?.qualifier).toBe("beta/review/");
});

test("a user rename that breaks the collision drops both qualifiers", () => {
  // Renaming is the manual escape hatch; once the names differ there is
  // nothing to disambiguate and the rail must go quiet again.
  const labels = projectLabels([
    project("acme", "/Users/p/Projects/Acme/acme"),
    project("acme review", "/Users/p/Projects/Acme/review/acme"),
  ]);
  expect(labels.get("/Users/p/Projects/Acme/acme")?.qualifier).toBeNull();
  expect(
    labels.get("/Users/p/Projects/Acme/review/acme")?.qualifier
  ).toBeNull();
});

test("paths that never diverge fall back to a qualifier rather than looping", () => {
  // Two rows on the identical path is a corrupt-ish state, but the rail still
  // has to render: exhausting the segments must terminate, not hang.
  const a: ProjectRow = { ...project("api", "/w/api"), id: "a" };
  const b: ProjectRow = { ...project("api", "/w/api"), id: "b" };
  const labels = projectLabels([a, b]);
  expect(labels.get("a")?.qualifier).toBe("w/");
  expect(labels.get("b")?.qualifier).toBe("w/");
});

test("a project at the filesystem root has no parent to borrow", () => {
  const labels = projectLabels([
    project("api", "/api"),
    project("api", "/w/api"),
  ]);
  expect(labels.get("/api")?.qualifier).toBeNull();
  expect(labels.get("/w/api")?.qualifier).toBe("w/");
});

test("an empty rail yields an empty map", () => {
  expect(projectLabels([]).size).toBe(0);
});
