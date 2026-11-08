import { create } from "zustand";
import { useLayout } from "./layout.ts";
import { useSessions } from "./sessions.ts";

/**
 * A [Project folder]: a named, one-level bucket of projects in the sidebar.
 * Sorting only — it stops nothing. A project names its folder through
 * `ProjectRow.folderId`; the list of folders lives here, persisted under its
 * own app-state key so a layout reset cannot wipe it.
 */
export interface ProjectFolder {
  id: string;
  name: string;
}

/** Longest folder name kept; a pasted paragraph is cut, not refused. */
export const FOLDER_NAME_MAX = 60;

/** The name a folder gets when the person leaves the field empty. */
export const DEFAULT_FOLDER_NAME = "New folder";

/** A folder name as stored: trimmed, single-line, capped, never empty. */
export function cleanFolderName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX);
  return name === "" ? DEFAULT_FOLDER_NAME : name;
}

/**
 * Parse the persisted folder list. Anything malformed is dropped entry by
 * entry, so one bad record (or a blob from a newer build) never loses the rest.
 */
export function parseProjectFolders(json: string | null): ProjectFolder[] {
  if (!json) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const seen = new Set<string>();
  const out: ProjectFolder[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { id, name } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || seen.has(id)) {
      continue;
    }
    if (typeof name !== "string") {
      continue;
    }
    seen.add(id);
    out.push({ id, name: cleanFolderName(name) });
  }
  return out;
}

interface ProjectFoldersState {
  /** The folder whose name field is open in its header, or null. View state
   *  only: never persisted. */
  editingFolderId: string | null;
  folders: ProjectFolder[];
  setEditingFolder: (folderId: string | null) => void;
  setFolders: (folders: ProjectFolder[]) => void;
}

export const useProjectFolders = create<ProjectFoldersState>((set) => ({
  editingFolderId: null,
  folders: [],
  setEditingFolder: (editingFolderId) => set({ editingFolderId }),
  setFolders: (folders) => set({ folders }),
}));

function newFolderId(): string {
  return `folder-${crypto.randomUUID()}`;
}

/**
 * Make a folder. With `projectId` the folder is born holding that project, so
 * the menu path never leaves an empty folder on the rail. Returns the new id.
 */
export function createProjectFolder(name: string, projectId?: string): string {
  const id = newFolderId();
  const { folders } = useProjectFolders.getState();
  useProjectFolders
    .getState()
    .setFolders([...folders, { id, name: cleanFolderName(name) }]);
  if (projectId) {
    useSessions.getState().setProjectFolder(projectId, id);
  }
  return id;
}

export function renameProjectFolder(id: string, name: string): void {
  const { folders } = useProjectFolders.getState();
  useProjectFolders
    .getState()
    .setFolders(
      folders.map((folder) =>
        folder.id === id ? { ...folder, name: cleanFolderName(name) } : folder
      )
    );
}

/**
 * Delete a folder. Its projects go back to the plain list, and a focus on it
 * ends; nothing about the projects themselves changes.
 */
export function deleteProjectFolder(id: string): void {
  const { folders } = useProjectFolders.getState();
  useProjectFolders
    .getState()
    .setFolders(folders.filter((folder) => folder.id !== id));
  useSessions.getState().clearProjectFolder(id);
  const layout = useLayout.getState();
  if (layout.layout.focusedFolderId === id) {
    layout.setFocusedFolder(null);
  }
}
