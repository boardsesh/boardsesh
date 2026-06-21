import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Toast, type ToastVariant, type ToastData } from '../components/Toast';
import { hapticSuccess, hapticError } from '../lib/haptics';

const MAX_VISIBLE_TOASTS = 2;
const DEFAULT_DURATION = 3000;

type ToastContextValue = {
  showToast: (message: string, variant?: ToastVariant, duration?: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

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

    if (variant === 'success') hapticSuccess();
    if (variant === 'error') hapticError();

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

  return (
    <ToastContext.Provider value={value}>
      {children}
      <View style={styles.overlay} pointerEvents="none">
        {toasts.map((toast) => (
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
