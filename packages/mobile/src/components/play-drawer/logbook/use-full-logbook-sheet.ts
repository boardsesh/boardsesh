import { useCallback, useState } from 'react';

/**
 * Open/close state for the full-logbook sheet, pinned to the climb it was
 * opened on.
 *
 * The displayed climb can change by a route the drawer does not own (a party
 * peer advancing the queue, a reorder, the accessory bar). The sheet has to
 * close then, and it has to FORGET the climb too: ModalSheet's `onClose` only
 * fires for a pan-down, never when `visible` flips to false, so a uuid left in
 * state would present the sheet again, untapped, the next time the climber
 * landed back on that climb.
 */
export function useFullLogbookSheet(displayedClimbUuid: string | null | undefined): {
  /** The climb the sheet is open for; null while it is closed. */
  climbUuid: string | null;
  open: () => void;
  close: () => void;
} {
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // Adjust state when a prop changes (the pattern `useLogbook` uses for its
  // board reset), so no render can show the sheet open over another climb.
  if (openedFor !== null && openedFor !== displayedClimbUuid) {
    setOpenedFor(null);
  }

  const open = useCallback(() => {
    setOpenedFor(displayedClimbUuid ?? null);
  }, [displayedClimbUuid]);
  const close = useCallback(() => {
    setOpenedFor(null);
  }, []);

  return { climbUuid: openedFor === displayedClimbUuid ? openedFor : null, open, close };
}
