import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useReducer,
  useLayoutEffect,
  useInsertionEffect,
  type ReactNode,
} from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Toast, type ToastVariant, type ToastData, type ToastGuard, isToastGuardCurrent } from '../components/Toast';
import { hapticSuccess, hapticError } from '../lib/haptics';
import { announceQueued } from '../lib/announce-queued';

const MAX_VISIBLE_TOASTS = 2;
const DEFAULT_DURATION = 3000;

type ToastContextValue = {
  showToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  showGuardedToast: (message: string, variant: ToastVariant, guard: ToastGuard, duration?: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

let nextId = 0;

type GuardedState = Readonly<{ entries: readonly ToastData[]; processed: readonly string[] }>;
type GuardedAction =
  | Readonly<{ type: 'enqueue'; toast: ToastData }>
  | Readonly<{ type: 'drop'; id: string }>
  | Readonly<{ type: 'ack'; ids: readonly string[] }>;
function guardedToastReducer(state: GuardedState, action: GuardedAction): GuardedState {
  if (action.type === 'ack') return { ...state, processed: state.processed.filter((id) => !action.ids.includes(id)) };
  if (action.type === 'drop')
    return {
      entries: state.entries.filter((toast) => toast.id !== action.id),
      processed: [...state.processed, action.id],
    };
  const processed = [...state.processed, ...state.entries.map((entry) => entry.id), action.toast.id];
  if (!isToastGuardCurrent(action.toast.guard)) return { ...state, processed };
  const entries = [...state.entries, action.toast].slice(-MAX_VISIBLE_TOASTS);
  if (!isToastGuardCurrent(action.toast.guard)) return { ...state, processed };
  return { entries, processed };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [guarded, dispatchGuarded] = useReducer(guardedToastReducer, { entries: [], processed: [] });
  const registrations = useRef(new Map<string, { toast: ToastData; feedback: boolean }>());
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

  const showGuardedToast = useCallback(
    (message: string, variant: ToastVariant, guard: ToastGuard, duration = DEFAULT_DURATION) => {
      const id = String(++nextId);
      const toast = Object.freeze({ id, message, variant, duration, guard });
      registrations.current.set(id, { toast, feedback: false });
      dispatchGuarded({ type: 'enqueue', toast });
    },
    [],
  );

  const visible = [...toasts, ...guarded.entries]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(-MAX_VISIBLE_TOASTS);
  useLayoutEffect(() => {
    const evictedPlainIds = new Set(
      toasts.filter((toast) => !visible.some((entry) => entry.id === toast.id)).map((toast) => toast.id),
    );
    if (evictedPlainIds.size) {
      // Only IDs evicted by THIS committed render. Later queued IDs survive.
      setToasts((current) => current.filter((toast) => !evictedPlainIds.has(toast.id)));
    }
    for (const [id, registration] of registrations.current) {
      if (!guarded.processed.includes(id) && !guarded.entries.some((entry) => entry.id === id)) continue;
      const shown = visible.some((entry) => entry.id === id);
      if (!shown || !isToastGuardCurrent(registration.toast.guard)) {
        registration.toast.guard?.release();
        registrations.current.delete(id);
        if (guarded.entries.some((entry) => entry.id === id)) dispatchGuarded({ type: 'drop', id });
        continue;
      }
      if (!registration.feedback) {
        const { guard, variant, message } = registration.toast;
        try {
          guard?.assertCurrent();
          if (variant === 'success') hapticSuccess();
          guard?.assertCurrent();
          if (variant === 'error') hapticError();
          guard?.assertCurrent();
          if (Platform.OS === 'ios') announceQueued(message);
          guard?.assertCurrent();
          registration.feedback = true;
        } catch {
          guard?.release();
          registrations.current.delete(id);
          dispatchGuarded({ type: 'drop', id });
        }
      }
    }
    if (guarded.processed.length) dispatchGuarded({ type: 'ack', ids: guarded.processed });
  });
  // Actual deletion owns cleanup; Suspense layout disconnection retains it.
  useInsertionEffect(
    () => () => {
      for (const registration of registrations.current.values()) registration.toast.guard?.release();
      registrations.current.clear();
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    const registration = registrations.current.get(id);
    registration?.toast.guard?.release();
    registrations.current.delete(id);
    dispatchGuarded({ type: 'drop', id });
    setToasts((prev) => prev.filter((toastItem) => toastItem.id !== id));
  }, []);

  // Stable context value: showToast is a stable useCallback, so memoising the
  // wrapper object keeps every useToast() consumer from re-rendering on each
  // ToastProvider render (toasts state churns as toasts appear/dismiss).
  const value = useMemo<ToastContextValue>(() => ({ showToast, showGuardedToast }), [showToast, showGuardedToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* This overlay is a root-level JS View, so it renders BEHIND any native
          surface above it — an @expo/ui sheet (ModalSheet / BottomSheetModal) or
          a `presentation: 'modal'` route. Pattern: feedback for an action taken
          INSIDE such a sheet must stay inline (e.g. the sheet's own error slot);
          only call showToast once the sheet is fully dismissed, or it'll be
          invisible behind it. */}
      <View style={styles.overlay} pointerEvents="none">
        {visible.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </View>
    </ToastContext.Provider>
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
