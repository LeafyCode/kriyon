import type {
  DragEndEvent,
  DragOverEvent,
  SensorDescriptor,
  SensorOptions,
} from "@dnd-kit/core";
import { useEffect, useRef, useState } from "react";
import {
  createProjectFolder,
  DEFAULT_FOLDER_NAME,
  type ProjectFolder,
  useProjectFolders,
} from "../state/projectFolders.ts";
import { useSessions } from "../state/sessions.ts";
import { useProjectDrag } from "./dragCommit.ts";
import {
  folderOfDropId,
  MERGE_DWELL_MS,
  type ProjectDropAction,
  projectDropAction,
  type RailPlace,
} from "./folderDrop.ts";

interface FolderDrag {
  /** Project ids as displayed — frozen to the drag-start snapshot mid-drag. */
  displayIds: string[];
  /** The project a dragged one has rested on, and what dropping there does. */
  merge: { hint: string; targetId: string } | null;
  onDragCancel: () => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragStart: () => void;
  sensors: SensorDescriptor<SensorOptions>[];
}

function mergeHint(
  action: ProjectDropAction,
  folders: ProjectFolder[]
): string | null {
  if (action.kind === "merge") {
    return "Drop to make a folder";
  }
  if (action.kind === "join") {
    const name = folders.find((f) => f.id === action.folderId)?.name;
    return name ? `Drop to add to ${name}` : null;
  }
  return null;
}

/**
 * The rail's one project drag: reorder as before, plus [Project folder]s —
 * drop on a folder header to join it, rest on another project for
 * {@link MERGE_DWELL_MS} and drop to make a folder of the two (or join its
 * folder), or drop among another section's projects to move there. The rules
 * live in {@link projectDropAction}; this hook only times the hover and
 * applies the result.
 */
export function useFolderDrag(
  projectIds: string[],
  places: ReadonlyMap<string, RailPlace>
): FolderDrag {
  const base = useProjectDrag(projectIds);
  const folders = useProjectFolders((state) => state.folders);
  const [merge, setMerge] = useState<FolderDrag["merge"]>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopDwell = () => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    setMerge(null);
  };
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const onDragOver = ({ active, over }: DragOverEvent) => {
    stopDwell();
    const overId = over ? String(over.id) : null;
    if (overId === null || folderOfDropId(overId) !== null) {
      return;
    }
    // Only start the clock where resting would change something.
    const held = projectDropAction({
      activeId: String(active.id),
      mergeTargetId: overId,
      overId,
      places,
    });
    const hint = mergeHint(held, folders);
    if (hint === null) {
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setMerge({ hint, targetId: overId });
    }, MERGE_DWELL_MS);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const action = projectDropAction({
      activeId,
      mergeTargetId: merge?.targetId ?? null,
      overId: event.over ? String(event.over.id) : null,
      places,
    });
    stopDwell();
    const sessions = useSessions.getState();
    switch (action.kind) {
      case "reorder":
        base.onDragEnd(event);
        return;
      case "move":
        sessions.setProjectFolder(activeId, action.folderId);
        base.onDragEnd(event);
        return;
      case "join":
        sessions.setProjectFolder(activeId, action.folderId);
        base.onDragCancel();
        return;
      case "merge": {
        const id = createProjectFolder(DEFAULT_FOLDER_NAME, action.withId);
        sessions.setProjectFolder(activeId, id);
        useProjectFolders.getState().setEditingFolder(id);
        base.onDragCancel();
        return;
      }
      default:
        base.onDragCancel();
    }
  };

  return {
    displayIds: base.displayIds,
    merge,
    onDragCancel: () => {
      stopDwell();
      base.onDragCancel();
    },
    onDragEnd,
    onDragOver,
    onDragStart: base.onDragStart,
    sensors: base.sensors,
  };
}
