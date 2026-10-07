import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Toast, type ToastVariant, type ToastData } from '../components/Toast';
import { hapticSuccess, hapticError } from '../lib/haptics';
import { announceQueued } from '../lib/announce-queued';

const MAX_VISIBLE_TOASTS = 2;
const DEFAULT_DURATION = 3000;

type ToastContextValue = {
  showToast: (message: string, variant?: ToastVariant, duration?: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

type ToastQueueValue = {
  toasts: ToastData[];
  dismissToast: (id: string) => void;
};

// The visible toasts, read only by ToastHost. Split from ToastContext so a
// toast appearing or dismissing re-renders the host alone, never every
// useToast() caller.
const ToastQueueContext = createContext<ToastQueueValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const showToast = useCallback((message: string, variant: ToastVariant = 'info', duration = DEFAULT_DURATION) => {
    const id = String(++nextId);
    const toast: ToastData = { id, message, variant, duration };

    // The toast OWNS the outcome haptic (HIG "Playing haptics"): a caller that
    // shows a success or error toast must not play its own notification haptic
    // as well, or the climber feels it twice.
    if (variant === 'success') hapticSuccess();
    if (variant === 'error') hapticError();

    // VoiceOver ignores `accessibilityLiveRegion` (Android-only), so iOS is told
    // explicitly, once per toast. Android already reads the live region; an
    // announce there would read the message twice.
    if (Platform.OS === 'ios') announceQueued(message);

    setToasts((prev) => {
      const next = [...prev, toast];
      if (next.length > MAX_VISIBLE_TOASTS) return next.slice(-MAX_VISIBLE_TOASTS);
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toastItem) => toastItem.id !== id));
  }, []);

  // Stable context value: showToast is a stable useCallback, so memoising the
  // wrapper object keeps every useToast() consumer from re-rendering on each
  // ToastProvider render (toasts state churns as toasts appear/dismiss).
  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);
  const queue = useMemo<ToastQueueValue>(() => ({ toasts, dismissToast }), [toasts, dismissToast]);

  // The provider holds state only. The overlay renders from ToastHost, which
  // sits lower in the tree (inside BottomChromeMetricsProvider) so a toast can
  // position against the bottom chrome actually on screen. ToastProvider itself
  // stays above QueueProvider so the queue and BLE providers can call showToast.
  return (
    <ToastContext.Provider value={value}>
      <ToastQueueContext.Provider value={queue}>{children}</ToastQueueContext.Provider>
    </ToastContext.Provider>
  );
}

/**
 * Renders the visible toasts. Mount it once, inside both ToastProvider and
 * BottomChromeMetricsProvider, as the last child so it paints over the screens,
 * the queue bar and the snackbars (same pattern as the queue snackbars, whose
 * state lives above QueueProvider and whose overlays render below it).
 */
export function ToastHost() {
  const queue = useContext(ToastQueueContext);
  if (!queue) throw new Error('ToastHost must be used within ToastProvider');
  const { toasts, dismissToast } = queue;
  return (
    // This overlay is a root-level JS View, so it renders BEHIND any native
    // surface above it — an @expo/ui sheet (ModalSheet / BottomSheetModal) or a
    // `presentation: 'modal'` route. Pattern: feedback for an action taken
    // INSIDE such a sheet must stay inline (e.g. the sheet's own error slot);
    // only call showToast once the sheet is fully dismissed, or it'll be
    // invisible behind it.
    <View style={styles.overlay} pointerEvents="none">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
  },
});
