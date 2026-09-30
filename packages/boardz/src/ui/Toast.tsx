import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FONT } from './fonts';
import { Icon } from './Icon';
import { X } from './icons';
import { LedDot } from './LedDot';
import { Text } from './Text';
import { LED, useTheme } from './theme';
import { radius, spacing } from './tokens';

export type ToastTone = 'success' | 'danger' | 'info' | 'accent';

export type ToastMessage = {
  tone?: ToastTone;
  /** "Flashed!" — says what happened. */
  title: string;
  /** "First go. Filthy." — the wink. */
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
};

const TONE_LED: Record<ToastTone, string> = {
  success: LED.green,
  danger: LED.red,
  info: LED.blue,
  accent: LED.blue,
};

// Long enough to reach Undo; short enough not to linger over the list.
const DURATION_MS = 2600;
const DURATION_WITH_ACTION_MS = 6000;
// Clears the tab bar or a screen's action bar.
const BOTTOM_OFFSET = 88;

type ToastContextValue = { show: (toast: ToastMessage) => void; hide: () => void };

const ToastContext = createContext<ToastContextValue | null>(null);

/** Hosts one toast at a time, over every screen but native sheets. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastMessage & { id: number }) | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.actionLabel ? DURATION_WITH_ACTION_MS : DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const value: ToastContextValue = {
    show: (next) => setToast({ ...next, id: Date.now() }),
    hide: () => setToast(null),
  };

  return (
    <ToastContext.Provider value={value}>
      <View style={styles.host}>
        {children}
        {toast ? <ToastView key={toast.id} toast={toast} onClose={() => setToast(null)} /> : null}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

function ToastView({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, [enter]);

  return (
    <Animated.View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.wrapper,
        {
          bottom: insets.bottom + BOTTOM_OFFSET,
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        },
      ]}
    >
      <View style={[styles.toast, { backgroundColor: theme.bgInverse }]}>
        <LedDot color={TONE_LED[toast.tone ?? 'success']} size={8} />
        <View style={styles.copy}>
          <Text variant="bodyStrong" color={theme.fgInverse} style={styles.title}>
            {toast.title}
          </Text>
          {toast.message ? (
            <Text variant="small" color={theme.fgInverse} style={styles.message}>
              {toast.message}
            </Text>
          ) : null}
        </View>
        {toast.actionLabel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={toast.actionLabel}
            hitSlop={spacing.sm}
            onPress={() => {
              toast.onAction?.();
              onClose();
            }}
            style={styles.action}
          >
            <Text variant="label" color={theme.fgInverse} style={{ fontFamily: FONT.monoMedium, fontSize: 11 }}>
              {toast.actionLabel}
            </Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={spacing.sm} onPress={onClose}>
          <Icon icon={X} size={16} color={theme.fgInverse} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  wrapper: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  toast: {
    width: '100%',
    maxWidth: 420,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  copy: { flex: 1 },
  title: { fontFamily: FONT.sansSemiBold, fontSize: 14, lineHeight: 19 },
  message: { opacity: 0.68 },
  action: { paddingHorizontal: 6, paddingVertical: spacing.sm },
});
