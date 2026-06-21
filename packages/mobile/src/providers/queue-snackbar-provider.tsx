import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Tiny state container for the bottom snackbars. It is mounted ABOVE
 * QueueProvider so `addToQueue` can trigger the queue-added one, but it does NOT
 * render the overlays itself — those live in DrawerHostProvider (below
 * QueueProvider) where they can read the queue state for positioning and bind
 * their actions. This split avoids a circular provider dependency.
 *
 * It drives two independent snackbars:
 *   - "Climb added to queue" (Open → opens the queue sheet)
 *   - "Wall changed · Undo"  (Undo → re-lights the previous wall climb)
 * Each has its own visible/nonce pair so showing one doesn't disturb the other.
 */
type QueueSnackbarContextValue = {
  /** Show the snackbar (or re-show + reset its timer if already visible). */
  showQueueAddedSnackbar: () => void;
  visible: boolean;
  /** Bumped on every show so the overlay can reset its dismiss timer + replay its entrance. */
  nonce: number;
  dismissSnackbar: () => void;
  /**
   * Show the "you changed the wall · Undo" snackbar after this device reports a
   * wall change. The Undo action is wired by the host (DrawerHostProvider) to the
   * Bluetooth provider so it can re-light the prior climb before re-reporting.
   */
  showUndoWallChangeSnackbar: () => void;
  undoWallChangeVisible: boolean;
  undoWallChangeNonce: number;
  dismissUndoWallChangeSnackbar: () => void;
};

const QueueSnackbarContext = createContext<QueueSnackbarContextValue | null>(null);

export function useQueueSnackbar(): QueueSnackbarContextValue {
  const context = useContext(QueueSnackbarContext);
  if (!context) throw new Error('useQueueSnackbar must be used within QueueSnackbarProvider');
  return context;
}

export function QueueSnackbarProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [undoWallChangeVisible, setUndoWallChangeVisible] = useState(false);
  const [undoWallChangeNonce, setUndoWallChangeNonce] = useState(0);

  const showQueueAddedSnackbar = useCallback(() => {
    setNonce((current) => current + 1);
    setVisible(true);
  }, []);

  const dismissSnackbar = useCallback(() => setVisible(false), []);

  const showUndoWallChangeSnackbar = useCallback(() => {
    setUndoWallChangeNonce((current) => current + 1);
    setUndoWallChangeVisible(true);
  }, []);

  const dismissUndoWallChangeSnackbar = useCallback(() => setUndoWallChangeVisible(false), []);

  const value = useMemo(
    () => ({
      showQueueAddedSnackbar,
      visible,
      nonce,
      dismissSnackbar,
      showUndoWallChangeSnackbar,
      undoWallChangeVisible,
      undoWallChangeNonce,
      dismissUndoWallChangeSnackbar,
    }),
    [
      showQueueAddedSnackbar,
      visible,
      nonce,
      dismissSnackbar,
      showUndoWallChangeSnackbar,
      undoWallChangeVisible,
      undoWallChangeNonce,
      dismissUndoWallChangeSnackbar,
    ],
  );

  return <QueueSnackbarContext.Provider value={value}>{children}</QueueSnackbarContext.Provider>;
}
