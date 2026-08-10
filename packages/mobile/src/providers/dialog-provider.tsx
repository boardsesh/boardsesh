import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform, StyleSheet } from 'react-native';
import { Button, Dialog, Portal, Text } from 'react-native-paper';
import { useTheme } from './theme-provider';

/** One action in a `choose()` prompt. Rendered in the order given. */
export type ChooseOption<TValue extends string> = {
  /** What `choose()` resolves to when this action is picked. */
  value: TValue;
  label: string;
  /** Style as destructive (M3 error tint / iOS destructive). */
  destructive?: boolean;
  /** The dismissive action (iOS `cancel` style). At most one. */
  cancel?: boolean;
};

export type ChooseOptions<TValue extends string> = {
  title: string;
  /** Optional supporting text under the title. */
  message?: string;
  /** Two or three actions, in display order. */
  options: ReadonlyArray<ChooseOption<TValue>>;
  /** Resolved on scrim / back / swipe dismiss — no action was picked. */
  cancelValue: TValue;
};

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
  /** Resolve the picked option's `value`, or `cancelValue` on scrim / back dismiss. */
  choose: <TValue extends string>(options: ChooseOptions<TValue>) => Promise<TValue>;
};

const DialogContext = createContext<DialogContextValue | null>(null);

// The queue is heterogeneous in its value type, so it carries the erased `string`
// form; `choose()`'s generic signature is what callers actually see.
type PendingChoice = ChooseOptions<string> & { id: number; resolve: (value: string) => void };

const CONFIRM_VALUE = 'confirm';
const CANCEL_VALUE = 'cancel';

/** Map an option to the native Alert button style (cancel wins over destructive). */
function alertButtonStyle(option: ChooseOption<string>): 'cancel' | 'destructive' | undefined {
  if (option.cancel) return 'cancel';
  if (option.destructive) return 'destructive';
  return undefined;
}

const styles = StyleSheet.create({
  // Three actions plus long localised labels overflow a single Material row on a
  // narrow phone; wrapping keeps every action reachable instead of clipping one.
  actions: { flexWrap: 'wrap' },
});

/**
 * One imperative dialog for the whole app, rendered the right way per UI
 * variant: a Material 3 Paper `Dialog` (in a `Portal`) on Material, and the native
 * iOS `Alert` on Liquid Glass — behind `useConfirm()` (yes/no) and `useChoose()`
 * (two or three named actions), which return promises so callers can
 * `if (await confirm(...))` / `switch (await choose(...))`.
 *
 * `confirm` is a thin wrapper over `choose`, so the queueing, one-shot settling
 * and per-variant rendering below have exactly one implementation.
 *
 * It's a provider (not a `createVariantComponent`) because the API is imperative
 * context, not a rendered element — and it must be reachable from other providers
 * (e.g. the Bluetooth board-config flow, the cross-board queue gate), not just
 * screens. Mount it inside `MaterialThemeProvider` (so the Paper `Dialog`/`Portal`
 * has a host) and above any provider that prompts. Providers are exempt from the
 * variant guard, so the `variant ===` branch here is the sanctioned place to
 * resolve it.
 *
 * The Paper `Dialog` is used on **Android Material only**. On iOS we always fall back
 * to the native `Alert` — even on the Material variant — because prompts are often
 * launched from a sheet rendered in a `FullWindowOverlay` (iOS-only), and the Paper
 * `Portal` lives in the normal React tree *underneath* that overlay: the dialog would
 * be invisible and its promise would never resolve. The native `Alert` always sits on
 * top. iOS Material is a forced-variant edge case, so the lost M3 chrome there is an
 * acceptable trade for a prompt that actually works.
 *
 * Concurrent prompts queue (one Android dialog shows at a time; the native Alert
 * queues itself). Each prompt settles exactly once, by id — a double-tap, or an
 * action racing `onDismiss`, can't drop a different queued prompt or leave a caller
 * awaiting forever. Scrim / back dismiss resolves `cancelValue`.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const { variant, m3 } = useTheme();
  const [queue, setQueue] = useState<PendingChoice[]>([]);
  const idRef = useRef(0);
  // One-shot guard: a prompt settles at most once even if its dialog fires
  // onPress and onDismiss in the same tick, or is double-tapped before re-render.
  const settledIdsRef = useRef<Set<number>>(new Set());

  // Native Alert on Liquid Glass everywhere, and on iOS regardless of variant (see
  // the FullWindowOverlay note above). The Paper dialog queue is Android-Material only.
  const useNativeAlert = variant === 'liquidGlass' || Platform.OS === 'ios';

  const choose = useCallback(
    <TValue extends string>(options: ChooseOptions<TValue>) =>
      new Promise<TValue>((resolve) => {
        if (useNativeAlert) {
          Alert.alert(
            options.title,
            options.message,
            options.options.map((option) => ({
              text: option.label,
              style: alertButtonStyle(option),
              onPress: () => resolve(option.value),
            })),
            { onDismiss: () => resolve(options.cancelValue) },
          );
          return;
        }
        // Snapshot the id HERE, not inside the updater: React defers a queued
        // updater to render time, so `idRef.current` read in there would be
        // whatever the last concurrent caller left behind — three prompts raised
        // in one tick would share an id, and settling one would drop the others
        // with their promises left hanging forever.
        idRef.current += 1;
        const id = idRef.current;
        setQueue((pending) => [...pending, { ...options, id, resolve: resolve as (value: string) => void }]);
      }),
    [useNativeAlert],
  );

  const confirm = useCallback(
    async (options: ConfirmOptions) => {
      const picked = await choose({
        title: options.title,
        message: options.message,
        // Cancel first: for a two-button prompt that's the established layout on
        // both the native Alert and the Paper actions row.
        options: [
          { value: CANCEL_VALUE, label: options.cancelLabel, cancel: true },
          { value: CONFIRM_VALUE, label: options.confirmLabel, destructive: options.destructive },
        ],
        cancelValue: CANCEL_VALUE,
      });
      return picked === CONFIRM_VALUE;
    },
    [choose],
  );

  const value = useMemo<DialogContextValue>(() => ({ confirm, choose }), [confirm, choose]);

  // Resolve a SPECIFIC pending prompt by id and drop just that one from the queue.
  // Stable (no `current` dep) and one-shot, so racing handlers can't slice the wrong
  // entry or resolve twice.
  const settle = useCallback((target: PendingChoice, result: string) => {
    if (settledIdsRef.current.has(target.id)) return;
    settledIdsRef.current.add(target.id);
    target.resolve(result);
    setQueue((pending) => pending.filter((item) => item.id !== target.id));
  }, []);

  // Keep the one-shot guard bounded without a side effect in the updater above.
  // Once the queue commits, the dialog for any settled id has unmounted and can
  // no longer fire a racing handler, so the guard only needs the ids still pending.
  useEffect(() => {
    const pendingIds = new Set(queue.map((item) => item.id));
    for (const settledId of settledIdsRef.current) {
      if (!pendingIds.has(settledId)) settledIdsRef.current.delete(settledId);
    }
  }, [queue]);

  const current = queue[0];

  return (
    <DialogContext value={value}>
      {children}
      {/* Only the Android-Material path ever queues a prompt; guarding on the same
          `!useNativeAlert` condition keeps the Paper dialog off Liquid Glass / iOS
          even if the variant flips while a prompt is mid-flight. */}
      {!useNativeAlert && current ? (
        <Portal>
          <Dialog visible onDismiss={() => settle(current, current.cancelValue)}>
            <Dialog.Title>{current.title}</Dialog.Title>
            {current.message ? (
              <Dialog.Content>
                <Text variant="bodyMedium">{current.message}</Text>
              </Dialog.Content>
            ) : null}
            <Dialog.Actions style={styles.actions}>
              {current.options.map((option) => (
                <Button
                  key={option.value}
                  textColor={option.destructive ? m3.error : undefined}
                  onPress={() => settle(current, option.value)}
                >
                  {option.label}
                </Button>
              ))}
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

/**
 * Imperative multi-choice dialog (two or three named actions). Returns a promise
 * that resolves the picked option's `value`, or `cancelValue` when the prompt is
 * dismissed without a pick.
 *
 * Throws without a provider on purpose: a nullable context that silently resolves
 * to `null` is how PR #1633's confirm never fired on the local-session path.
 */
export function useChoose(): DialogContextValue['choose'] {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useChoose must be used within a DialogProvider');
  }
  return ctx.choose;
}
