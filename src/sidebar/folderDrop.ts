/**
 * What dropping a dragged project does to [Project folder]s. Pure, so the
 * rules are tested without pointer simulation; the Sidebar's drag wiring
 * applies the result.
 */
import {
  type CollisionDetection,
  closestCenter,
  pointerWithin,
} from "@dnd-kit/core";

import type { ProjectFolder } from "../state/projectFolders.ts";
import type { ProjectRow } from "../types.ts";

/** How long a project must hover over another before a drop merges them. */
export const MERGE_DWELL_MS = 500;

const FOLDER_DROP_PREFIX = "folder-drop:";

/** The droppable id of a folder's header. */
export function folderDropId(folderId: string): string {
  return `${FOLDER_DROP_PREFIX}${folderId}`;
}

/** The folder a droppable id names, or null for a project id. */
export function folderOfDropId(id: string): string | null {
  return id.startsWith(FOLDER_DROP_PREFIX)
    ? id.slice(FOLDER_DROP_PREFIX.length)
    : null;
}

/** Where a project sits on the rail. */
export type RailPlace =
  | { kind: "pinned" }
  | { kind: "loose" }
  | { folderId: string; kind: "folder" };

export type ProjectDropAction =
  | { kind: "none" }
  /** Reorder inside the section it is already in. */
  | { kind: "reorder" }
  /** Into this folder; order unchanged. */
  | { folderId: string; kind: "join" }
  /** Into the section of the project it was dropped on, at that spot. */
  | { folderId: string | null; kind: "move" }
  /** Make a new folder holding both. */
  | { kind: "merge"; withId: string };

function folderOf(place: RailPlace | undefined): string | null {
  return place?.kind === "folder" ? place.folderId : null;
}

/**
 * Decide one project drop. `mergeTargetId` is the project the pointer has
 * rested on for {@link MERGE_DWELL_MS} (null when it moved on). Pinned
 * projects live outside folders, so a drop that involves one only reorders.
 */
export function projectDropAction({
  activeId,
  mergeTargetId,
  overId,
  places,
}: {
  activeId: string;
  mergeTargetId: string | null;
  overId: string | null;
  places: ReadonlyMap<string, RailPlace>;
}): ProjectDropAction {
  if (overId === null || overId === activeId) {
    return { kind: "none" };
  }
  const active = places.get(activeId);
  const headerFolder = folderOfDropId(overId);
  if (headerFolder !== null) {
    return active?.kind === "pinned" || folderOf(active) === headerFolder
      ? { kind: "none" }
      : { folderId: headerFolder, kind: "join" };
  }
  const over = places.get(overId);
  const pinnedInvolved = active?.kind === "pinned" || over?.kind === "pinned";
  if (pinnedInvolved) {
    return active?.kind === over?.kind ? { kind: "reorder" } : { kind: "none" };
  }
  const target = folderOf(over);
  const sameSection = folderOf(active) === target;
  // A held hover: onto a project in no folder makes one; onto one in another
  // folder joins it. Inside the same folder it is just a reorder.
  if (mergeTargetId === overId) {
    if (target === null) {
      return { kind: "merge", withId: overId };
    }
    if (!sameSection) {
      return { folderId: target, kind: "join" };
    }
  }
  return sameSection
    ? { kind: "reorder" }
    : { folderId: folderOf(over), kind: "move" };
}

/**
 * Folder headers win when the pointer is inside one, so a drop aimed at a
 * header never lands on the project nearest to it; everything else is the
 * usual closest-centre reorder.
 */
export const folderAwareCollision: CollisionDetection = (args) => {
  const headers = args.droppableContainers.filter(
    (container) => folderOfDropId(String(container.id)) !== null
  );
  const onHeader = pointerWithin({ ...args, droppableContainers: headers });
  if (onHeader.length > 0) {
    return onHeader;
  }
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => folderOfDropId(String(container.id)) === null
    ),
  });
};

/** Where each project sits: Pinned, a folder that exists, or the plain list. */
export function railPlaces(
  projects: ProjectRow[],
  folders: ProjectFolder[]
): Map<string, RailPlace> {
  const known = new Set(folders.map((folder) => folder.id));
  return new Map(
    projects.map((project): [string, RailPlace] => {
      if ((project.pinnedAt ?? null) !== null) {
        return [project.id, { kind: "pinned" }];
      }
      return project.folderId && known.has(project.folderId)
        ? [project.id, { folderId: project.folderId, kind: "folder" }]
        : [project.id, { kind: "loose" }];
    })
  );
}
