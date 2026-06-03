import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Tiny state container for the "Climb added to queue" snackbar. It is mounted
 * ABOVE QueueProvider so `addToQueue` can trigger it, but it does NOT render the
 * overlay itself — the overlay lives in DrawerHostProvider (below QueueProvider)
 * where it can read the queue state for positioning and bind its "Open" button
 * to `openQueueSheet`. This split avoids a circular provider dependency.
 */
type QueueSnackbarContextValue = {
  /** Show the snackbar (or re-show + reset its timer if already visible). */
  showQueueAddedSnackbar: () => void;
  visible: boolean;
  /** Bumped on every show so the overlay can reset its dismiss timer + replay its entrance. */
  nonce: number;
  dismissSnackbar: () => void;
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

  const showQueueAddedSnackbar = useCallback(() => {
    setNonce((current) => current + 1);
    setVisible(true);
  }, []);

  const dismissSnackbar = useCallback(() => setVisible(false), []);

  const value = useMemo(
    () => ({ showQueueAddedSnackbar, visible, nonce, dismissSnackbar }),
    [showQueueAddedSnackbar, visible, nonce, dismissSnackbar],
  );

  return <QueueSnackbarContext.Provider value={value}>{children}</QueueSnackbarContext.Provider>;
}
