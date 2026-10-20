import type { ProjectRow } from "../types.ts";

/**
 * How many parent segments a qualifier may grow to before the rail gives up
 * and lets two projects share one. A folder basename is the project name, so
 * collisions are almost always siblings one or two levels apart
 * (`Acme/acme` vs `Acme/review/acme`); past three segments the
 * qualifier costs more rail width than the ambiguity costs the reader, and the
 * header's `title` still carries the full path.
 */
const MAX_SEGMENTS = 3;

/** A project's rail label: its name, and the parent path that separates it. */
export interface ProjectLabel {
  name: string;
  /**
   * The trailing-slashed parent segments that make {@link name} unique on the
   * rail (`"Acme/"`, `"alpha/review/"`), or `null` when nothing collides —
   * the common case, and the one that must stay visually unchanged.
   */
  qualifier: string | null;
}

/** The path's parent segments, outermost first, with the leaf dropped. */
function parentSegments(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.slice(0, -1);
}

/** The trailing `depth` parent segments, rendered as a qualifier. */
function qualifierAt(segments: string[], depth: number): string | null {
  if (depth < 1 || segments.length === 0) {
    return null;
  }
  return `${segments.slice(-Math.min(depth, segments.length)).join("/")}/`;
}

/**
 * Deepen the qualifiers of one same-named group until they come apart.
 *
 * Each member starts at one segment and only grows while it is still tied with
 * another member, so a project that separated early keeps the short label its
 * neighbours' deeper ambiguity would otherwise force on it. Growth stops when
 * every qualifier is distinct, or when no tied member has a segment left to
 * add — two rows on the same path can never separate, and the rail must render
 * rather than loop.
 */
function resolveGroup(group: ProjectRow[]): Map<string, string | null> {
  const segments = new Map(
    group.map((project) => [project.id, parentSegments(project.path)] as const)
  );
  const depth = new Map<string, number>(
    group.map((project) => [project.id, 1] as const)
  );
  const current = () =>
    group.map((project) => ({
      id: project.id,
      value: qualifierAt(
        segments.get(project.id) ?? [],
        depth.get(project.id) ?? 1
      ),
    }));

  for (;;) {
    const labels = current();
    const tally = new Map<string, number>();
    for (const { value } of labels) {
      const key = value ?? "";
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const tied = labels.filter(
      ({ value }) => (tally.get(value ?? "") ?? 0) > 1
    );
    if (tied.length === 0) {
      break;
    }
    let grew = false;
    for (const { id } of tied) {
      const available = Math.min(segments.get(id)?.length ?? 0, MAX_SEGMENTS);
      const next = (depth.get(id) ?? 1) + 1;
      if (next <= available) {
        depth.set(id, next);
        grew = true;
      }
    }
    // Nothing could deepen: the remaining ties are unresolvable (identical
    // paths, or the segment cap). Render them alike rather than spinning.
    if (!grew) {
      break;
    }
  }
  return new Map(current().map(({ id, value }) => [id, value] as const));
}

/**
 * Rail labels for every project, keyed by project id.
 *
 * A project name is the folder's basename, so distinct checkouts of the same
 * repo — a worktree, a review clone — land on the rail as several identically
 * named groups that only a color swatch tells apart. This resolves each set of
 * colliding names to the *shallowest* parent path that separates them, and
 * leaves every unique name untouched so the disambiguation only shows up where
 * it is actually earning its space.
 */
export function projectLabels(
  projects: ProjectRow[]
): Map<string, ProjectLabel> {
  const byName = new Map<string, ProjectRow[]>();
  for (const project of projects) {
    const bucket = byName.get(project.name);
    if (bucket) {
      bucket.push(project);
    } else {
      byName.set(project.name, [project]);
    }
  }
  const labels = new Map<string, ProjectLabel>();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      const [only] = group;
      if (only !== undefined) {
        labels.set(only.id, { name, qualifier: null });
      }
      continue;
    }
    const resolved = resolveGroup(group);
    for (const project of group) {
      labels.set(project.id, {
        name,
        qualifier: resolved.get(project.id) ?? null,
      });
    }
  }
  return labels;
}
