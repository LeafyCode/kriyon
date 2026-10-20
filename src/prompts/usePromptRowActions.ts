import { useCallback, useState } from "react";
import { usePromptLibrary } from "../state/promptLibrary.ts";
import { useUi } from "../state/ui.ts";
import type { SavedPrompt } from "../types.ts";

/**
 * The shared stateful half of the [Prompt row actions]: the armed two-click
 * delete, plus favourite / edit / mark-used wired to the prompt library and the
 * editor. Both the [Prompt library view] and the [Prompt picker] render the
 * same row controls, so they share this hook instead of each re-declaring the
 * arming state and the identical `usePromptLibrary.getState()` calls.
 *
 * `deleteRow` arms on the first call and removes on the second for the same
 * prompt; any navigation or query change should call `disarmDelete` so a stale
 * armed row can't be deleted by a later click landing on a different prompt.
 */
export function usePromptRowActions(): {
  deleteArmedId: string | null;
  disarmDelete: () => void;
  deleteRow: (p: SavedPrompt) => void;
  favouriteRow: (p: SavedPrompt) => void;
  editRow: (p: SavedPrompt) => void;
  markUsed: (p: SavedPrompt) => void;
} {
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);

  const disarmDelete = useCallback(() => setDeleteArmedId(null), []);

  const deleteRow = useCallback(
    (p: SavedPrompt) => {
      if (deleteArmedId === p.id) {
        usePromptLibrary.getState().remove(p.id);
        setDeleteArmedId(null);
      } else {
        setDeleteArmedId(p.id);
      }
    },
    [deleteArmedId]
  );

  const favouriteRow = useCallback((p: SavedPrompt) => {
    usePromptLibrary.getState().toggleFavourite(p.id, Date.now());
  }, []);

  const editRow = useCallback((p: SavedPrompt) => {
    useUi.getState().openPromptEditor({
      body: p.body,
      id: p.id,
      tags: p.tags,
      title: p.title,
    });
  }, []);

  const markUsed = useCallback((p: SavedPrompt) => {
    usePromptLibrary.getState().markUsed(p.id, Date.now());
  }, []);

  return {
    deleteArmedId,
    disarmDelete,
    deleteRow,
    favouriteRow,
    editRow,
    markUsed,
  };
}
