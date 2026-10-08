import { createElement, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useNavigation, type NativeStackNavigationOptions } from 'expo-router';
import type { ColorValue } from 'react-native';
import { HeaderLeadingButton, HeaderTrailingGroup } from '../components/HeaderActionButtons';
import type { SheetTopBarLeading, SheetTopBarTrailing } from '../components/SheetTopBar';

export type HeaderLeadingAction = SheetTopBarLeading;
export type HeaderTrailingAction = SheetTopBarTrailing;

type HeaderActions = {
  /**
   * Sets `headerLeft`. `null` or omitted leaves the slot as it is: the layout's
   * value (the spray flow's leave-guarded X, the stack's back chevron) or
   * whatever this hook last set.
   */
  leading?: HeaderLeadingAction | null;
  /** Sets `headerRight`. `null` or omitted leaves the slot as it is. */
  trailing?: HeaderTrailingAction | null;
  /**
   * Drawn before the trailing action, e.g. a "?" help button. Memoise it
   * (`useMemo`): a new element each render re-sets the header each render.
   */
  trailingAccessory?: ReactNode;
  /**
   * On unmount, reset the slots this call wrote (`headerRight`, and
   * `headerLeft` only if it wrote one). For a screen body that can be swapped
   * out while the route stays, like a form replaced by a not-found state, so a
   * stale Save is not left in the header. Off by default: the spray wizard and
   * layout-owned slots rely on nothing being cleared.
   */
  clearOnUnmount?: boolean;
};

type HeaderSlotProps = { tintColor?: ColorValue };

/**
 * Put a pushed or modal screen's actions in its native stack header: leading
 * Cancel / close / back as `headerLeft`, the trailing confirm as `headerRight`.
 * The same shape SheetTopBar takes, so a sheet and a screen say the same thing
 * the same way. See docs/mobile-sheets-vs-routes.md, "Where actions go".
 *
 * - **Only writes what you pass, never clears** (unless `clearOnUnmount`). A
 *   slot left out (or `null`) is not touched, and nothing is reset on unmount: `setOptions` cannot give
 *   back the layout's own value, so clearing would wipe a layout's X. A flow
 *   that changes its leading action passes one on every step instead (the
 *   spray wizard: `close` on step 1, `back` after).
 * - **Don't pass `leading: back` on a pushed stack screen.** The native back
 *   chevron already there keeps its long-press history menu; ours would not.
 * - **No thrash.** `onPress` is read through a ref, so a new callback identity
 *   each render never re-runs `setOptions`. Only a change to what the bar shows
 *   (kind, label, disabled, loading, prominent, accessory) does.
 * - **Layout effect**, so the header is right on the first frame the screen
 *   paints rather than one frame later.
 */
export function useHeaderActions({
  leading,
  trailing,
  trailingAccessory,
  clearOnUnmount = false,
}: HeaderActions): void {
  const navigation = useNavigation();

  // Which slots this call has written, and whether to give them back on
  // unmount. Refs, so the unmount cleanup below runs once, on unmount only.
  const wroteLeadingRef = useRef(false);
  const wroteTrailingRef = useRef(false);
  const clearOnUnmountRef = useRef(clearOnUnmount);
  clearOnUnmountRef.current = clearOnUnmount;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  useLayoutEffect(
    () => () => {
      if (!clearOnUnmountRef.current) return;
      const cleared: Pick<NativeStackNavigationOptions, 'headerLeft' | 'headerRight'> = {};
      if (wroteLeadingRef.current) cleared.headerLeft = undefined;
      if (wroteTrailingRef.current) cleared.headerRight = undefined;
      if (Object.keys(cleared).length > 0) navigationRef.current.setOptions(cleared);
    },
    [],
  );

  const leadingPressRef = useRef(leading?.onPress);
  leadingPressRef.current = leading?.onPress;
  const trailingPressRef = useRef(trailing?.onPress);
  trailingPressRef.current = trailing?.onPress;
  const pressLeading = useCallback(() => leadingPressRef.current?.(), []);
  const pressTrailing = useCallback(() => trailingPressRef.current?.(), []);

  const leadingKind = leading?.kind;
  const leadingText = leading?.label;
  const leadingLabel = leading?.accessibilityLabel;
  const leadingDisabled = leading?.disabled ?? false;
  useLayoutEffect(() => {
    if (!leadingKind) return;
    const options: Pick<NativeStackNavigationOptions, 'headerLeft'> = {
      headerLeft: ({ tintColor }: HeaderSlotProps) =>
        createElement(HeaderLeadingButton, {
          kind: leadingKind,
          onPress: pressLeading,
          label: leadingText,
          accessibilityLabel: leadingLabel,
          disabled: leadingDisabled,
          tintColor,
        }),
    };
    navigation.setOptions(options);
    wroteLeadingRef.current = true;
  }, [navigation, leadingKind, leadingText, leadingLabel, leadingDisabled, pressLeading]);

  const trailingLabel = trailing?.label;
  const trailingDisabled = trailing?.disabled ?? false;
  const trailingLoading = trailing?.loading ?? false;
  const trailingProminent = trailing?.prominent ?? false;
  const trailingA11yLabel = trailing?.accessibilityLabel;
  const hasAccessory = trailingAccessory != null;
  useLayoutEffect(() => {
    if (trailingLabel == null && !hasAccessory) return;
    const action: HeaderTrailingAction | undefined =
      trailingLabel == null
        ? undefined
        : {
            label: trailingLabel,
            onPress: pressTrailing,
            disabled: trailingDisabled,
            loading: trailingLoading,
            prominent: trailingProminent,
            accessibilityLabel: trailingA11yLabel,
          };
    const options: Pick<NativeStackNavigationOptions, 'headerRight'> = {
      headerRight: ({ tintColor }: HeaderSlotProps) =>
        createElement(HeaderTrailingGroup, { accessory: trailingAccessory, trailing: action, tintColor }),
    };
    navigation.setOptions(options);
    wroteTrailingRef.current = true;
  }, [
    navigation,
    trailingLabel,
    trailingDisabled,
    trailingLoading,
    trailingProminent,
    trailingA11yLabel,
    hasAccessory,
    trailingAccessory,
    pressTrailing,
  ]);
}
