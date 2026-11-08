import type { ProjectFolder } from "../state/projectFolders.ts";
import { isPinnedProject } from "../state/sessions.ts";
import type { ProjectRow } from "../types.ts";

export interface FolderSection {
  folder: ProjectFolder;
  /** Its projects on the rail, in the rail's order. */
  projects: ProjectRow[];
}

export interface RailSections {
  /** The folder in [Folder focus], and how many rail projects it hides. */
  focus: { folder: ProjectFolder; hiddenCount: number } | null;
  /** Folders with something to show, sorted by name. */
  folders: FolderSection[];
  /** Projects folded away as inactive (only the focused folder's, in focus). */
  inactive: ProjectRow[];
  /** Projects in no folder. */
  loose: ProjectRow[];
  /** Pinned projects. Never inactive, never in a folder's list, kept in focus. */
  pinned: ProjectRow[];
}

interface RailSectionsInput {
  /** The folder whose name field is open: drawn whatever it holds, so the
   *  field the person is typing in never sits in a hidden header. */
  editingFolderId?: string | null;
  /** Folders at least one project (on the rail or not) belongs to. A folder
   *  outside this set is brand new and empty, and is drawn so it can be filled. */
  filledFolderIds: ReadonlySet<string>;
  focusedFolderId: string | null;
  folders: ProjectFolder[];
  inactiveIds: ReadonlySet<string>;
  /** The projects on the rail, already sorted (manual, calm or triage). */
  projects: ProjectRow[];
}

/**
 * Split the rail's sorted projects into the sidebar's sections: Pinned, each
 * [Project folder], the loose list, and the "N inactive projects" fold — then
 * narrow to one folder under [Folder focus]. The one place these rules live,
 * so the Sidebar only draws what comes back.
 */
export function railSections({
  editingFolderId = null,
  filledFolderIds,
  focusedFolderId,
  folders,
  inactiveIds,
  projects,
}: RailSectionsInput): RailSections {
  const byId = new Map(folders.map((folder) => [folder.id, folder] as const));
  const focused =
    focusedFolderId === null ? undefined : byId.get(focusedFolderId);
  const pinned: ProjectRow[] = [];
  const inactive: ProjectRow[] = [];
  const loose: ProjectRow[] = [];
  const inFolder = new Map<string, ProjectRow[]>();
  let hiddenCount = 0;

  for (const project of projects) {
    const place = placeOf(project, byId, focused, inactiveIds);
    if (place === "pinned") {
      pinned.push(project);
    } else if (place === "hidden") {
      hiddenCount += 1;
    } else if (place === "inactive") {
      inactive.push(project);
    } else if (place === "loose") {
      loose.push(project);
    } else if (place !== "dropped") {
      inFolder.set(place.folderId, [
        ...(inFolder.get(place.folderId) ?? []),
        project,
      ]);
    }
  }

  return {
    focus: focused ? { folder: focused, hiddenCount } : null,
    folders: drawnFolders(
      folders,
      inFolder,
      new Set([...filledFolderIds].filter((id) => id !== editingFolderId)),
      focused
    ),
    inactive,
    loose,
    pinned,
  };
}

type Place =
  | "pinned"
  | "inactive"
  | "loose"
  /** Outside the focused folder, on the rail: counted in the banner. */
  | "hidden"
  /** Outside the focused folder and inactive: neither drawn nor counted. */
  | "dropped"
  | { folderId: string };

/** Where a project sits on the rail, before focus and the inactive fold. */
export type RailPlace =
  | { kind: "pinned" }
  | { kind: "loose" }
  | { folderId: string; kind: "folder" };

/**
 * The one placement rule: Pinned first, then a folder that exists, else the
 * plain list. A `folderId` no folder answers to reads as no folder. Both the
 * drawing ({@link railSections}) and the drag rules ({@link railPlaces}) ask
 * this, so a drop always acts on where the project is drawn.
 */
function basePlace(
  project: ProjectRow,
  folderIds: { has: (id: string) => boolean }
): RailPlace {
  if (isPinnedProject(project)) {
    return { kind: "pinned" };
  }
  return project.folderId && folderIds.has(project.folderId)
    ? { folderId: project.folderId, kind: "folder" }
    : { kind: "loose" };
}

/** Where each project sits, for the drag rules. */
export function railPlaces(
  projects: ProjectRow[],
  folders: ProjectFolder[]
): Map<string, RailPlace> {
  const known = new Set(folders.map((folder) => folder.id));
  return new Map(
    projects.map((project) => [project.id, basePlace(project, known)] as const)
  );
}

/** Which section one project belongs in. */
function placeOf(
  project: ProjectRow,
  byId: ReadonlyMap<string, ProjectFolder>,
  focused: ProjectFolder | undefined,
  inactiveIds: ReadonlySet<string>
): Place {
  const base = basePlace(project, byId);
  if (base.kind === "pinned") {
    return "pinned";
  }
  const folderId = base.kind === "folder" ? base.folderId : null;
  const isInactive = inactiveIds.has(project.id);
  if (focused && folderId !== focused.id) {
    return isInactive ? "dropped" : "hidden";
  }
  if (isInactive) {
    return "inactive";
  }
  return folderId === null ? "loose" : { folderId };
}

/**
 * The folders to draw, by name. A folder whose projects are all off the rail
 * is not drawn — except the focused one, which must say what the rail is
 * narrowed to, and a new one nothing has joined yet, which would otherwise
 * vanish as it is made. Under focus, only the focused folder.
 */
function drawnFolders(
  folders: ProjectFolder[],
  inFolder: ReadonlyMap<string, ProjectRow[]>,
  filledFolderIds: ReadonlySet<string>,
  focused: ProjectFolder | undefined
): FolderSection[] {
  const visible = focused ? [focused] : folders;
  return [...visible]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => ({ folder, projects: inFolder.get(folder.id) ?? [] }))
    .filter(
      ({ folder, projects }) =>
        projects.length > 0 ||
        folder.id === focused?.id ||
        !filledFolderIds.has(folder.id)
    );
}

/**
 * Where the [Folder focus] chord takes the rail: off when it is focused,
 * else onto the active session's folder. Null either way when there is
 * nothing to focus — a session in no folder, or a folder since deleted.
 */
export function folderFocusTarget(
  focusedFolderId: string | null,
  activeFolderId: string | null,
  folders: ProjectFolder[]
): string | null {
  if (focusedFolderId !== null) {
    return null;
  }
  return folders.some((folder) => folder.id === activeFolderId)
    ? activeFolderId
    : null;
}
