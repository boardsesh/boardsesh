import { createElement, useCallback, useLayoutEffect, useRef } from 'react';
import { useNavigation, type NativeStackNavigationOptions } from 'expo-router';
import type { ColorValue } from 'react-native';
import { HeaderLeadingButton, HeaderTrailingButton } from '../components/HeaderActionButtons';
import type { SheetTopBarLeading, SheetTopBarTrailing } from '../components/SheetTopBar';

export type HeaderLeadingAction = SheetTopBarLeading;
export type HeaderTrailingAction = SheetTopBarTrailing;

type HeaderActions = {
  /** Omit to leave the screen's own `headerLeft` (a layout's X, or the stack's back chevron) alone. */
  leading?: HeaderLeadingAction;
  /** Omit to leave `headerRight` alone. */
  trailing?: HeaderTrailingAction;
};

type HeaderSlotProps = { tintColor?: ColorValue };

/**
 * Put a pushed or modal screen's actions in its native stack header: leading
 * Cancel / close / back as `headerLeft`, the trailing confirm as `headerRight`.
 * The same shape SheetTopBar takes, so a sheet and a screen say the same thing
 * the same way. See docs/mobile-sheets-vs-routes.md, "Where actions go".
 *
 * - **Only what you pass.** A slot left out is never written, so a layout's
 *   `headerLeft` (the spray flow's leave-guarded X) survives a screen that only
 *   sets a trailing action.
 * - **No thrash.** `onPress` is read through a ref, so a new callback identity
 *   each render never re-runs `setOptions`. Only a change to what the bar shows
 *   (kind, label, disabled, loading, prominent) does.
 * - **Cleans up.** When a slot goes from passed to omitted, or the caller
 *   unmounts, the slot is cleared. `setOptions` has no "restore the layout's
 *   value", so a screen whose layout supplies `headerLeft` should either always
 *   pass `leading` or never pass it.
 * - **Layout effect**, so the header is right on the first frame the screen
 *   paints rather than one frame later.
 */
export function useHeaderActions({ leading, trailing }: HeaderActions): void {
  const navigation = useNavigation();

  const leadingPressRef = useRef(leading?.onPress);
  leadingPressRef.current = leading?.onPress;
  const trailingPressRef = useRef(trailing?.onPress);
  trailingPressRef.current = trailing?.onPress;
  const pressLeading = useCallback(() => leadingPressRef.current?.(), []);
  const pressTrailing = useCallback(() => trailingPressRef.current?.(), []);

  const leadingKind = leading?.kind;
  const leadingLabel = leading?.accessibilityLabel;
  useLayoutEffect(() => {
    if (!leadingKind) return undefined;
    const options: Pick<NativeStackNavigationOptions, 'headerLeft'> = {
      headerLeft: ({ tintColor }: HeaderSlotProps) =>
        createElement(HeaderLeadingButton, {
          kind: leadingKind,
          onPress: pressLeading,
          accessibilityLabel: leadingLabel,
          tintColor,
        }),
    };
    navigation.setOptions(options);
    return () => navigation.setOptions({ headerLeft: undefined });
  }, [navigation, leadingKind, leadingLabel, pressLeading]);

  const trailingLabel = trailing?.label;
  const trailingDisabled = trailing?.disabled ?? false;
  const trailingLoading = trailing?.loading ?? false;
  const trailingProminent = trailing?.prominent ?? false;
  const trailingA11yLabel = trailing?.accessibilityLabel;
  useLayoutEffect(() => {
    if (trailingLabel == null) return undefined;
    const options: Pick<NativeStackNavigationOptions, 'headerRight'> = {
      headerRight: ({ tintColor }: HeaderSlotProps) =>
        createElement(HeaderTrailingButton, {
          label: trailingLabel,
          onPress: pressTrailing,
          disabled: trailingDisabled,
          loading: trailingLoading,
          prominent: trailingProminent,
          accessibilityLabel: trailingA11yLabel,
          tintColor,
        }),
    };
    navigation.setOptions(options);
    return () => navigation.setOptions({ headerRight: undefined });
  }, [
    navigation,
    trailingLabel,
    trailingDisabled,
    trailingLoading,
    trailingProminent,
    trailingA11yLabel,
    pressTrailing,
  ]);
}
