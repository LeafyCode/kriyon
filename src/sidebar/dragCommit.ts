/**
 * The drag pipeline's store-facing half: dnd-kit hands `ProjectGroup` a drop
 * event, this module turns it into a saved manual order. Split from the
 * component so the id coercion / no-op / pin-and-toast rules are unit-testable
 * without simulating pointer events.
 */
import {
  type DragEndEvent,
  PointerSensor,
  type SensorDescriptor,
  type SensorOptions,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useState } from "react";
import { effectiveSessionSort, useLayout } from "../state/layout.ts";
import { showToast } from "../ui/Toast.tsx";
import { dropOrder, EMPTY_ORDER } from "./sessionOrder.ts";

/**
 * The row sensor: a {@link PointerSensor} that refuses to start a drag from
 * anything marked `data-no-dnd` — the hover action cluster (close ×, ⋯) and
 * the anchored popovers live inside the row's drag surface, and a press that
 * travels 6px mid-menu-interaction must not turn into a row drag.
 */
export class RowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }): boolean =>
        nativeEvent.isPrimary &&
        nativeEvent.button === 0 &&
        !(
          nativeEvent.target instanceof Element &&
          nativeEvent.target.closest("[data-no-dnd]")
        ),
    },
  ];
}

/** Stable sensor options — an inline literal would defeat dnd-kit's
 *  `useSensor` memo and re-identify the DndContext every render, cascading a
 *  re-render of every row in the group. Drag starts only after 6px of travel,
 *  so plain clicks still select rows. */
export const ROW_SENSOR_OPTIONS = {
  activationConstraint: { distance: 6 },
} as const;

interface FrozenDrag {
  /** The items as displayed — frozen to the drag-start snapshot mid-drag. */
  display: string[];
  onDragCancel: () => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragStart: () => void;
  sensors: SensorDescriptor<SensorOptions>[];
}

/**
 * The drag wiring shared by the session-row and project-group reorders: the
 * {@link RowPointerSensor} (so a press on a `data-no-dnd` control never starts
 * a drag), and the mid-drag freeze — a list that re-sorts under the pointer (a
 * session status flip re-ranks rows/projects in triage) would make the user
 * drop onto an item they never aimed at, so the order shown is snapshotted at
 * drag-start. On drop it hands the active/over ids and the frozen order to
 * `onDrop`, which is the only part that differs between the two lists.
 */
function useFrozenDrag(
  items: string[],
  onDrop: (activeId: string, overId: string | null, display: string[]) => void
): FrozenDrag {
  const sensors = useSensors(useSensor(RowPointerSensor, ROW_SENSOR_OPTIONS));
  const [dragItems, setDragItems] = useState<string[] | null>(null);
  const display = dragItems ?? items;
  return {
    display,
    onDragCancel: () => setDragItems(null),
    onDragEnd: (event: DragEndEvent) => {
      setDragItems(null);
      onDrop(
        String(event.active.id),
        event.over ? String(event.over.id) : null,
        display
      );
    },
    onDragStart: () => setDragItems(items),
    sensors,
  };
}

interface RowDrag extends Omit<FrozenDrag, "display"> {
  /** The rows as displayed — frozen to the drag-start snapshot mid-drag. */
  displayRows: string[];
}

/** One project group's session-reorder drag wiring (see {@link useFrozenDrag}). */
export function useRowDrag(args: {
  collapsedDone: string[];
  projectId: string;
  projectName: string;
  rows: string[];
}): RowDrag {
  const { display, ...rest } = useFrozenDrag(
    args.rows,
    (activeId, overId, rows) =>
      commitSessionDrop({
        activeId,
        collapsedDone: args.collapsedDone,
        overId,
        projectId: args.projectId,
        projectName: args.projectName,
        rows,
      })
  );
  return { displayRows: display, ...rest };
}

interface ProjectDrag extends Omit<FrozenDrag, "display"> {
  /** Project ids as displayed — frozen to the drag-start snapshot mid-drag. */
  displayIds: string[];
}

/** The sidebar's project-reorder drag wiring (see {@link useFrozenDrag}). */
export function useProjectDrag(projectIds: string[]): ProjectDrag {
  const { display, ...rest } = useFrozenDrag(
    projectIds,
    (activeId, overId, ids) => commitProjectDrop({ activeId, ids, overId })
  );
  return { displayIds: display, ...rest };
}

/**
 * Commit one project drop: merge it into the global manual project order
 * ({@link dropOrder}, with no folded-away ids) and write it. The first drag —
 * when no manual order existed yet — flips project ordering away from the
 * sidebar mode's calm/triage sort for good, so it gets a toast (an invisible
 * change otherwise). Returns whether anything was written.
 */
export function commitProjectDrop(args: {
  activeId: string;
  ids: string[];
  overId: string | null;
}): boolean {
  const state = useLayout.getState();
  const prev = state.layout.manualProjectOrder;
  const next = dropOrder(
    prev,
    args.ids,
    EMPTY_ORDER,
    args.activeId,
    args.overId
  );
  if (!next) {
    return false;
  }
  const wasManual = prev.length > 0;
  state.setManualProjectOrder(next);
  if (!wasManual) {
    showToast("Projects now sort by your arrangement");
  }
  return true;
}

interface DropArgs {
  activeId: string;
  collapsedDone: string[];
  overId: string | null;
  projectId: string;
  projectName: string;
  /** The rows as displayed at drop time (the frozen drag snapshot). */
  rows: string[];
}

/**
 * Commit one drop: merge it into the project's saved manual order
 * ({@link dropOrder}) and write it, which pins the project's sort to manual.
 * The pin gets a toast — silently flipping a triage list to manual on a 6px
 * drag was invisible otherwise. Returns whether anything was written.
 */
export function commitSessionDrop(args: DropArgs): boolean {
  const state = useLayout.getState();
  const prev = state.layout.manualSessionOrder[args.projectId] ?? [];
  const next = dropOrder(
    prev,
    args.rows,
    args.collapsedDone,
    args.activeId,
    args.overId
  );
  if (!next) {
    return false;
  }
  const wasManual =
    effectiveSessionSort(state.layout, args.projectId) === "manual";
  state.setManualSessionOrder(args.projectId, next);
  if (!wasManual) {
    showToast(`Sorted manually — ${args.projectName} now overrides the sort`);
  }
  return true;
}
