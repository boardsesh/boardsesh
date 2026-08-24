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
/**
 * Which copy the queue snackbar shows. `'added'` is the plain append;
 * `'playNext'` confirms a Play next — the climb jumped to the slot right behind
 * the one on the wall, which reads as a broken button if the snackbar still says
 * "added to queue".
 */
export type QueueAddedSnackbarKind = 'added' | 'playNext';

export type QueueAddedSnackbarOptions = {
  kind: QueueAddedSnackbarKind;
  /**
   * How many climbs the confirmation covers, for a plural.
   *
   * Deliberately unused by this feature — a Play next is always exactly one
   * climb. It exists so the bulk playlist append (#4673) resolves its plural
   * against this same confirmation vocabulary instead of standing up a second,
   * near-identical snackbar. Not dead API: an in-flight sibling PR consumes it.
   */
  count?: number;
};

type QueueSnackbarContextValue = {
  /** Show the snackbar (or re-show + reset its timer if already visible). */
  showQueueAddedSnackbar: (options?: QueueAddedSnackbarOptions) => void;
  visible: boolean;
  /** Copy for the currently-showing queue snackbar. */
  queueAdded: QueueAddedSnackbarOptions;
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
  const [queueAdded, setQueueAdded] = useState<QueueAddedSnackbarOptions>({ kind: 'added' });
  const [undoWallChangeVisible, setUndoWallChangeVisible] = useState(false);
  const [undoWallChangeNonce, setUndoWallChangeNonce] = useState(0);

  const showQueueAddedSnackbar = useCallback((options: QueueAddedSnackbarOptions = { kind: 'added' }) => {
    setQueueAdded(options);
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
      queueAdded,
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
      queueAdded,
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
