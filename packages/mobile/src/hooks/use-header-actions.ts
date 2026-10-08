import { createElement, useCallback, useLayoutEffect, useRef, type ReactElement } from 'react';
import { useNavigation, type NativeStackNavigationOptions } from 'expo-router';
import { HeaderLeadingButton, HeaderTrailingButton, HeaderTrailingGroup } from '../components/HeaderActionButtons';
import type { SheetTopBarLeading, SheetTopBarTrailing } from '../components/SheetTopBar';
import { useTheme } from '../providers/theme-provider';
import { useGlassCapability } from './use-glass-capability';
import { iconMap } from '../components/icon-map';
import { resolveTrailingKind } from '../components/top-bar-action-look';

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
   * Drawn before the trailing action, e.g. a "?" help button. One element, not a
   * fragment or array: on iOS 26 it becomes a single custom bar item. Memoise it
   * (`useMemo`): a new element each render re-sets the header each render.
   */
  trailingAccessory?: ReactElement | null;
  /**
   * On unmount, reset the slots this call wrote (`headerRight`, and
   * `headerLeft` only if it wrote one). For a screen body that can be swapped
   * out while the route stays, like a form replaced by a not-found state, so a
   * stale Save is not left in the header. Off by default: the spray wizard and
   * layout-owned slots rely on nothing being cleared.
   */
  clearOnUnmount?: boolean;
};

type HeaderSlots = Pick<NativeStackNavigationOptions, 'headerLeft' | 'headerRight' | 'unstable_headerRightItems'>;
type NativeHeaderItems = NonNullable<NativeStackNavigationOptions['unstable_headerRightItems']>;

/**
 * The options for a screen that sets its own `headerRight` with `setOptions`
 * where `useHeaderActions` may have run before (the spray wizard's steps). On iOS
 * a native prominent confirm (`unstable_headerRightItems`) overrides
 * `headerRight`, so a step that takes over the right side, or clears it, clears
 * that too. Pass `undefined` to clear the right side.
 */
export function ownHeaderRight(
  headerRight: NativeStackNavigationOptions['headerRight'],
): Pick<NativeStackNavigationOptions, 'headerRight' | 'unstable_headerRightItems'> {
  return { headerRight, unstable_headerRightItems: undefined };
}

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
 * - **Native bar items on iOS 26 Liquid Glass** (`unstable_headerRightItems`,
 *   gated on `useGlassCapability()`). An idle `confirm` is a prominent
 *   (brand-tinted glass) `UIBarButtonItem` carrying the `checkmark` SF Symbol,
 *   its label the spoken name; a `send` or prominent action the prominent item
 *   with its label; a destructive one red semibold text, never a red ✓. It takes
 *   `disabled` natively. A native item has no loading state, and a custom view
 *   always lands outside native items, so while it saves, or beside an
 *   accessory, it is a `custom` item that hides UIKit's glass and draws the same
 *   ✓ circle or brand capsule (HeaderTrailingButton `standalone`). Before iOS 26,
 *   on Android and on Material, the JS `headerRight` draws text.
 */
export function useHeaderActions({
  leading,
  trailing,
  trailingAccessory,
  clearOnUnmount = false,
}: HeaderActions): void {
  const navigation = useNavigation();
  const { variant, brandColors } = useTheme();
  const glassCapable = useGlassCapability();

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
      const cleared: HeaderSlots = {};
      if (wroteLeadingRef.current) cleared.headerLeft = undefined;
      if (wroteTrailingRef.current) {
        cleared.headerRight = undefined;
        cleared.unstable_headerRightItems = undefined;
      }
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
      headerLeft: () =>
        createElement(HeaderLeadingButton, {
          kind: leadingKind,
          onPress: pressLeading,
          label: leadingText,
          accessibilityLabel: leadingLabel,
          disabled: leadingDisabled,
        }),
    };
    navigation.setOptions(options);
    wroteLeadingRef.current = true;
  }, [navigation, leadingKind, leadingText, leadingLabel, leadingDisabled, pressLeading]);

  const trailingLabel = trailing?.label;
  const trailingKind = trailing ? resolveTrailingKind(trailing) : undefined;
  const trailingIcon = trailing?.icon;
  const trailingHint = trailing?.accessibilityHint;
  const trailingDisabled = trailing?.disabled ?? false;
  const trailingLoading = trailing?.loading ?? false;
  const trailingProminent = trailing?.prominent ?? false;
  const trailingDestructive = trailing?.destructive ?? false;
  const trailingA11yLabel = trailing?.accessibilityLabel;
  const hasAccessory = trailingAccessory != null;
  // iOS 26 Liquid Glass puts the whole right side in native bar items. Gated on
  // the glass capability, not the variant alone: before iOS 26 a prominent item
  // is plain text, so there the JS `headerRight` (text) is the honest look.
  const usesBarItems = glassCapable && variant === 'liquidGlass';
  const accent = trailingDestructive ? brandColors.error : brandColors.primary;
  useLayoutEffect(() => {
    if (trailingLabel == null && !hasAccessory) return;
    const action: HeaderTrailingAction | undefined =
      trailingLabel == null
        ? undefined
        : {
            label: trailingLabel,
            kind: trailingKind,
            onPress: pressTrailing,
            disabled: trailingDisabled,
            loading: trailingLoading,
            prominent: trailingProminent,
            destructive: trailingDestructive,
            icon: trailingIcon,
            accessibilityLabel: trailingA11yLabel,
            accessibilityHint: trailingHint,
          };
    const nativeItems: NativeHeaderItems | undefined = usesBarItems
      ? () => {
          const items: ReturnType<NativeHeaderItems> = [];
          if (trailingAccessory != null) {
            items.push({ type: 'custom', element: trailingAccessory });
          }
          if (action) {
            items.push(
              trailingLoading || hasAccessory
                ? standaloneItem(action)
                : nativeButtonItem(action, pressTrailing, accent, trailingIcon),
            );
          }
          return items;
        }
      : undefined;
    const options: HeaderSlots = {
      headerRight: () => createElement(HeaderTrailingGroup, { accessory: trailingAccessory, trailing: action }),
      // Set every time, `undefined` included: it overrides `headerRight` on iOS.
      unstable_headerRightItems: nativeItems,
    };
    navigation.setOptions(options);
    wroteTrailingRef.current = true;
  }, [
    navigation,
    trailingLabel,
    trailingKind,
    trailingIcon,
    trailingHint,
    trailingDisabled,
    trailingLoading,
    trailingProminent,
    trailingDestructive,
    trailingA11yLabel,
    hasAccessory,
    trailingAccessory,
    pressTrailing,
    usesBarItems,
    accent,
  ]);
}

type NativeHeaderItem = ReturnType<NativeHeaderItems>[number];

/** Whether an action draws a filled shape (✓ circle, brand capsule) on iOS 26. */
function drawsOwnShape(action: HeaderTrailingAction): boolean {
  const kind = resolveTrailingKind(action);
  return !action.destructive && (kind === 'confirm' || kind === 'send' || action.prominent === true);
}

/**
 * The idle trailing action as a native `UIBarButtonItem`. A confirm is the
 * prominent (brand-tinted glass) item carrying the ✓ SF Symbol, its label the
 * spoken name; a send or prominent action the prominent item with its label; a
 * destructive one red semibold text, never a red fill; a plain one plain text
 * in the header tint.
 */
function nativeButtonItem(
  action: HeaderTrailingAction,
  onPress: () => void,
  accent: string,
  icon: HeaderTrailingAction['icon'],
): NativeHeaderItem {
  const kind = resolveTrailingKind(action);
  const shaped = drawsOwnShape(action);
  const emphasised = kind !== 'forward' || action.prominent === true;
  return {
    type: 'button',
    label: action.label,
    onPress,
    variant: shaped ? 'prominent' : 'plain',
    ...(shaped || action.destructive ? { tintColor: accent } : {}),
    disabled: action.disabled ?? false,
    ...(emphasised ? { labelStyle: { fontWeight: '600' } } : {}),
    ...(kind === 'confirm' && shaped ? { icon: { type: 'sfSymbol', name: iconMap[icon ?? 'confirm'].ios } } : {}),
    accessibilityLabel: action.accessibilityLabel ?? action.label,
    accessibilityHint: action.accessibilityHint,
  };
}

/**
 * The trailing action as a custom bar item, while it saves (a native item has
 * no loading state) or beside an accessory (a custom view always lands outside
 * native items, so both go custom to keep their order). A shaped action hides
 * UIKit's shared glass and draws the same ✓ circle or brand capsule the native
 * prominent item does, so idle and loading look alike.
 */
function standaloneItem(action: HeaderTrailingAction): NativeHeaderItem {
  const shaped = drawsOwnShape(action);
  return {
    type: 'custom',
    element: createElement(HeaderTrailingButton, { ...action, standalone: shaped }),
    hidesSharedBackground: shaped,
  };
}
