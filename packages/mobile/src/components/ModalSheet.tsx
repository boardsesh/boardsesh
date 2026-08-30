// Modal bottom sheet, presented imperatively via ref (`present()` / `dismiss()`)
// OR declaratively via the `visible` prop.
//
// Migrated off @gorhom/bottom-sheet to Expo's native bottom sheet (#3167): the
// native modal already presents above root chrome (the queue bar), so the old
// FullWindowOverlay container is gone, and the native sheet supplies the scrim,
// handle and (iOS 26) glass background — retiring SheetBackdrop / GlassSheetBackground.
//
// All present/dismiss go through the SheetPresentationProvider coordinator, which
// serializes native sheet transitions so two never overlap on the same presenter
// (the iOS UIKit deadlock / app freeze — see sheet-presentation-provider.tsx).

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';
import { hapticMedium } from '../lib/haptics';
import { spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { androidSafeSnapPoints } from './sheet-snap-points';
import { useSheetBodyContentStyle } from './sheet-content-inset';
import { useSheetColumnStyle } from './use-sheet-column-style';
import { useSheetDetentProbe } from './sheet-detent-probe';
import {
  useManagedSheet,
  type ManagedSheetHandle,
  type PresenterGroup,
} from '../providers/sheet-presentation-provider';

type ModalSheetProps = {
  children: ReactNode;
  /** Controlled open state. Leave undefined for purely imperative consumers that
   * drive the sheet through the forwarded ref. */
  visible?: boolean;
  snapPoints?: (string | number)[];
  enableDynamicSizing?: boolean;
  onChange?: (index: number) => void;
  /** Fired when the user closes the sheet themselves (pan-down / backdrop), so a
   * controlled parent can clear the state driving `visible`. */
  onClose?: () => void;
  /** Fired AFTER the dismiss animation has really settled. On iOS this rides the
   * native post-animation `onDismiss` (accurate); on Android it settles off the
   * coordinator's ceiling timer (no native signal there). */
  onFullyDismissed?: () => void;
  /** Serialization domain. Sheets presented off the same view controller share a
   * group; defaults to the root window VC. */
  presenterGroup?: PresenterGroup;
  enablePanDownToClose?: boolean;
  scrollable?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  footer?: ReactNode;
  /** Sheet ground. `glass` (default) keeps the native material — right for chrome
   * and short pickers. `solid` paints an opaque `theme.sheetSurface` so a
   * data-entry form isn't read through the content behind it.
   *
   * The colour MUST stay a plain string: @expo/ui's `extractBackgroundColor`
   * checks `typeof color === 'string'` and silently falls back to glass for a
   * `PlatformColor`, with no error. */
  surface?: 'glass' | 'solid';
  /** Pinned-footer ground. `plate` (default) keeps the raised
   * `secondaryBackground` plate. `flush` makes it transparent so it reads as part
   * of a `surface="solid"` sheet; the hairline top border stays either way. */
  footerSurface?: 'plate' | 'flush';
  /** Optional fixed header, rendered above the body and outside its scroll — so a
   * title and close affordance stay put while the body scrolls. */
  header?: ReactNode;
  /** Size the sheet to its content on Android via `@expo/ui`'s content-fitting
   * path (`enableDynamicSizing` + no snap points) instead of the `%` detents.
   * For a multi-detent form whose pinned footer only fits at the last detent
   * (the tick sheets): a near-full single detent there strands the footer under
   * ~310 dp of empty sheet (#4720), and Android's ~50% partial state can't fit
   * the form under the footer at all (#4723). Content-fitting closes both. The
   * column takes a `maxHeight` ceiling (see `useSheetColumnStyle`) so a
   * keyboard-up long note still scrolls under the footer rather than clipping.
   * No effect on iOS / web — they keep the exact `%` detents.
   *
   * Designed for a sheet with a `header` / `footer` (the `maxHeight` lands on the
   * KeyboardAvoidingView). A chrome-less sheet has no reason to reach for it —
   * pass `enableDynamicSizing` instead. */
  androidContentSized?: boolean;
};

export const ModalSheet = forwardRef<ManagedSheetHandle, ModalSheetProps>(function ModalSheet(
  {
    children,
    visible,
    snapPoints: customSnapPoints,
    enableDynamicSizing = false,
    onChange,
    onClose,
    onFullyDismissed,
    presenterGroup,
    enablePanDownToClose = true,
    scrollable = false,
    contentContainerStyle,
    footer,
    surface = 'glass',
    footerSurface = 'plate',
    header,
    androidContentSized = false,
  },
  ref,
) {
  const { systemColors, sheet, sheetSurface } = useTheme();
  const windowInsetBottom = useWindowBottomInset();
  const snapPoints = useMemo(() => customSnapPoints ?? ['50%', '90%'], [customSnapPoints]);
  // Plain string, never a PlatformColor — see the `surface` prop doc.
  const solidBackground = useMemo(() => ({ backgroundColor: sheetSurface }), [sheetSurface]);

  // On Android, `androidContentSized` swaps the `%` detents for `@expo/ui`'s
  // content-fitting path (no snap points at all reach the native sheet).
  const contentSizedOnAndroid = androidContentSized && Platform.OS === 'android';
  const useContentFitting = enableDynamicSizing || contentSizedOnAndroid;
  // Consumed only on the detent path below (`useContentFitting` false): pads a
  // SMALL single detent to give Android a partial state, passes iOS / web
  // through untouched. See androidSafeSnapPoints.
  const effectiveSnapPoints = useMemo(() => androidSafeSnapPoints(snapPoints), [snapPoints]);

  const sheetRef = useRef<BottomSheetMethods>(null);
  const managed = useManagedSheet({
    open: visible,
    group: presenterGroup,
    sheetRef,
    onClose,
    onFullyDismissed,
  });
  useImperativeHandle(ref, () => managed.handle, [managed.handle]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track the resting detent so the iOS column bound follows drags between detents.
  const [activeIndex, setActiveIndex] = useState(0);
  const columnStyle = useSheetColumnStyle(snapPoints, { enableDynamicSizing, activeIndex, contentSizedOnAndroid });
  // Dev-only observers for #3922 — they feed a log line, never layout.
  const { probeProps, sentinelProps, onColumnLayout } = useSheetDetentProbe(columnStyle, 'ModalSheet');

  const handleChange = useCallback(
    (index: number) => {
      if (index >= 0) {
        hapticMedium();
        setActiveIndex(index);
      } else {
        // Reset on close so a re-open of an always-mounted sheet starts at the
        // first detent's (shortest) column height until the native onChange
        // confirms the detent — erring short beats a stale taller column pushing
        // the pinned footer off-screen for a frame.
        setActiveIndex(0);
      }
      managed.onChange(index);
      onChangeRef.current?.(index);
    },
    [managed],
  );

  // A fixed header or a pinned footer both need a wrapper around the body, and
  // the native sheet takes exactly one in-flow child — so either one puts us in
  // the KeyboardAvoidingView branch below.
  const hasChrome = Boolean(footer || header);
  // The sheet's single child must carry the iOS detent bound (see
  // useSheetColumnStyle): with a header or footer the KeyboardAvoidingView below
  // is that child and the body just fills it (flex:1); without either the body
  // itself is the child, so it carries the bound directly — otherwise an iOS
  // scrollable sheet sizes to its content and anything past the detent is
  // clipped and unreachable instead of scrolling.
  //
  // On Android's content-fitting path the KAV takes a `maxHeight`, not `flex: 1`,
  // so the body can't `flex: 1` into it — it takes its content height at rest
  // (this is what closes the void) and `flexShrink: 1` so it shrinks and scrolls
  // once a keyboard-up long note pushes the column into that ceiling.
  const bodyStyle = hasChrome ? (contentSizedOnAndroid ? styles.contentShrink : styles.content) : columnStyle;
  // Without a pinned footer the body sits against the bottom edge, so it has to
  // clear the Android edge-to-edge navigation bar itself — the native sheet does
  // not pad content for it. With a footer the body scrolls above the footer, which
  // already carries the window inset — the WINDOW inset, not the mount point's:
  // a sheet docks over the tab bar, and a tab-mounted sheet's local inset folds
  // in iOS 26 tab chrome the sheet covers (see use-window-bottom-inset).
  // Keyed on the FOOTER alone, not `hasChrome`: a header sits above the body and
  // leaves it against the bottom edge, so a header-only sheet still owes the
  // window inset.
  const bodyContentContainerStyle = useSheetBodyContentStyle(Boolean(footer), contentContainerStyle, windowInsetBottom);
  // #3922: measure whichever view actually carries columnStyle — the body when
  // there is no header or footer, the KeyboardAvoidingView below when there is.
  const bodyLayout = hasChrome ? undefined : onColumnLayout;
  const body = scrollable ? (
    <BottomSheetScrollView
      style={bodyStyle}
      onLayout={bodyLayout}
      contentContainerStyle={bodyContentContainerStyle}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {children}
    </BottomSheetScrollView>
  ) : useContentFitting && !hasChrome && Platform.OS === 'web' ? (
    // Web + dynamic sizing only, where the column is never bounded and the
    // #3922 probe stays idle — so there is nothing to measure here.
    <BottomSheetView style={[bodyStyle, bodyContentContainerStyle]}>{children}</BottomSheetView>
  ) : (
    <View style={[bodyStyle, bodyContentContainerStyle]} onLayout={bodyLayout}>
      {children}
    </View>
  );

  const footerBar = footer ? (
    <View
      style={[
        styles.footer,
        {
          backgroundColor: footerSurface === 'flush' ? 'transparent' : systemColors.secondaryBackground,
          borderTopColor: systemColors.separator,
          paddingBottom: windowInsetBottom + spacing[3],
        },
      ]}
    >
      {footer}
    </View>
  ) : null;

  return (
    <BottomSheetModal
      ref={sheetRef}
      // Native `@expo/ui` ignores this prop entirely (its `BottomSheetModal`
      // mounts closed regardless and is only ever opened via the imperative
      // `snapToIndex` `useManagedSheet` drives). The Expo-web shim is NOT so
      // forgiving: it reads `index` both to mount (`GorhomBottomSheetModal
      // index={...}`) and inside its own `.present()`/`requestOpen` fallback, so
      // `-1` here left the web sheet unable to ever open (#4684 review). Keep it
      // at the real first-detent index; an `androidContentSized` sheet has no
      // snap points on Android and only its one content-fitted state, so index 0
      // is that state.
      index={0}
      snapPoints={useContentFitting ? undefined : effectiveSnapPoints}
      enableDynamicSizing={useContentFitting}
      enablePanDownToClose={enablePanDownToClose}
      handleIndicatorStyle={sheet.handleStyle}
      backgroundStyle={surface === 'solid' ? solidBackground : undefined}
      onChange={handleChange}
      onFullyDismissed={managed.onFullyDismissed}
      style={styles.sheet}
    >
      {/* #3922 instrumentation, dev builds only. The sentinel is in-flow but
          zero-height and the probe is absolutely positioned, so neither adds
          anything to the wrapper's content size in either of @expo/ui's layout
          branches — the "single flex child" rule below still holds. */}
      {sentinelProps ? <View {...sentinelProps} /> : null}
      {probeProps ? <View {...probeProps} /> : null}
      {hasChrome ? (
        // The single flex child of the native sheet: bound to the detent height on
        // iOS (see useSheetColumnStyle) so the pinned footer can't fall off-screen
        // (#3330); flex:1 on Android's detent path; a `maxHeight` ceiling on its
        // content-fitting path (#4720). `padding` on both platforms: the Android
        // Compose dialog window does not resize for the keyboard, so without it
        // the keyboard covers the footer's input (emulator-verified).
        <KeyboardAvoidingView style={columnStyle} behavior="padding" onLayout={onColumnLayout}>
          {header}
          {body}
          {footerBar}
        </KeyboardAvoidingView>
      ) : (
        body
      )}
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  sheet: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  content: {
    flex: 1,
  },
  // Android content-fitting path: content height at rest (closes the void),
  // shrinks to scroll when a keyboard-up long note fills the column's ceiling.
  contentShrink: {
    flexShrink: 1,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
