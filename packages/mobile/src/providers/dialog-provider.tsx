import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform } from 'react-native';
import { Button, Dialog, Portal, Text } from 'react-native-paper';
import { useTheme } from './theme-provider';

export type ConfirmOptions = {
  title: string;
  /** Optional supporting text under the title. */
  message?: string;
  /** Label for the affirmative action (e.g. "Delete", "Switch"). */
  confirmLabel: string;
  /** Label for the dismissive action (e.g. "Cancel"). */
  cancelLabel: string;
  /** Style the confirm action as destructive (M3 error tint / iOS destructive). */
  destructive?: boolean;
};

type DialogContextValue = {
  /** Resolve `true` if the user confirms, `false` on cancel / scrim / back dismiss. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const DialogContext = createContext<DialogContextValue | null>(null);

type PendingConfirm = ConfirmOptions & { id: number; resolve: (value: boolean) => void };

/**
 * One imperative confirm dialog for the whole app, rendered the right way per UI
 * variant: a Material 3 Paper `Dialog` (in a `Portal`) on Material, and the native
 * iOS `Alert` on Liquid Glass — both behind `useConfirm()`, which returns a promise
 * so callers can `if (await confirm(...))`.
 *
 * It's a provider (not a `createVariantComponent`) because the API is imperative
 * context, not a rendered element — and it must be reachable from other providers
 * (e.g. the Bluetooth board-config flow), not just screens. Mount it inside
 * `MaterialThemeProvider` (so the Paper `Dialog`/`Portal` has a host) and above any
 * provider that calls `confirm`. Providers are exempt from the variant guard, so the
 * `variant ===` branch here is the sanctioned place to resolve it.
 *
 * The Paper `Dialog` is used on **Android Material only**. On iOS we always fall back
 * to the native `Alert` — even on the Material variant — because confirms are often
 * launched from a sheet rendered in a `FullWindowOverlay` (iOS-only), and the Paper
 * `Portal` lives in the normal React tree *underneath* that overlay: the dialog would
 * be invisible and its promise would never resolve. The native `Alert` always sits on
 * top. iOS Material is a forced-variant edge case, so the lost M3 chrome there is an
 * acceptable trade for a confirm that actually works.
 *
 * Concurrent confirms queue (one Android dialog shows at a time; the native Alert
 * queues itself). Each confirm settles exactly once, by id — a double-tap, or an
 * action racing `onDismiss`, can't drop a different queued confirm or leave a caller
 * awaiting forever. Scrim / back dismiss resolves `false`.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const { variant, m3 } = useTheme();
  const [queue, setQueue] = useState<PendingConfirm[]>([]);
  const idRef = useRef(0);
  // One-shot guard: a confirm settles at most once even if its dialog fires
  // onPress and onDismiss in the same tick, or is double-tapped before re-render.
  const settledIdsRef = useRef<Set<number>>(new Set());

  // Native Alert on Liquid Glass everywhere, and on iOS regardless of variant (see
  // the FullWindowOverlay note above). The Paper dialog queue is Android-Material only.
  const useNativeAlert = variant === 'liquidGlass' || Platform.OS === 'ios';

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        if (useNativeAlert) {
          Alert.alert(
            options.title,
            options.message,
            [
              { text: options.cancelLabel, style: 'cancel', onPress: () => resolve(false) },
              {
                text: options.confirmLabel,
                style: options.destructive ? 'destructive' : 'default',
                onPress: () => resolve(true),
              },
            ],
            { onDismiss: () => resolve(false) },
          );
          return;
        }
        idRef.current += 1;
        setQueue((q) => [...q, { ...options, id: idRef.current, resolve }]);
      }),
    [useNativeAlert],
  );

  const value = useMemo<DialogContextValue>(() => ({ confirm }), [confirm]);

  // Resolve a SPECIFIC pending confirm by id and drop just that one from the queue.
  // Stable (no `current` dep) and one-shot, so racing handlers can't slice the wrong
  // entry or resolve twice.
  const settle = useCallback((target: PendingConfirm, result: boolean) => {
    if (settledIdsRef.current.has(target.id)) return;
    settledIdsRef.current.add(target.id);
    target.resolve(result);
    setQueue((q) => q.filter((item) => item.id !== target.id));
  }, []);

  const current = queue[0];

  return (
    <DialogContext value={value}>
      {children}
      {current ? (
        <Portal>
          <Dialog visible onDismiss={() => settle(current, false)}>
            <Dialog.Title>{current.title}</Dialog.Title>
            {current.message ? (
              <Dialog.Content>
                <Text variant="bodyMedium">{current.message}</Text>
              </Dialog.Content>
            ) : null}
            <Dialog.Actions>
              <Button onPress={() => settle(current, false)}>{current.cancelLabel}</Button>
              <Button textColor={current.destructive ? m3.error : undefined} onPress={() => settle(current, true)}>
                {current.confirmLabel}
              </Button>
            </Dialog.Actions>
          </Dialog>
        </Portal>
      ) : null}
    </DialogContext>
  );
}

/**
 * Imperative confirm dialog. Returns a promise that resolves `true` on confirm,
 * `false` on cancel / dismiss — so `if (await confirm({ … })) { …action… }`.
 */
export function useConfirm(): DialogContextValue['confirm'] {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within a DialogProvider');
  }
  return ctx.confirm;
}
