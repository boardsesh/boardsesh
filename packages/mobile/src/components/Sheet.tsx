import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
// Migrated off @gorhom/bottom-sheet to Expo's native bottom sheet (#3167).
// The native sheet draws its own scrim, drag handle and (on iOS 26) glass
// background, so the old SheetBackdrop / GlassSheetBackground / FullWindowOverlay
// wiring is gone. Scroll coordination is native; keyboard avoidance for a pinned
// footer is JS-side (the padded chrome column below) on BOTH platforms.
//
// Present/dismiss route through the SheetPresentationProvider coordinator so two
// native sheet transitions never overlap (the iOS UIKit deadlock / app freeze —
// see sheet-presentation-provider.tsx).
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { androidSafeSnapPoints } from './sheet-snap-points';
import { useSheetBodyContentStyle } from './sheet-content-inset';
import { useSheetKeyboardInset } from './sheet-keyboard-inset';
import { useSheetColumnStyle } from './use-sheet-column-style';
import { useSheetDetentProbe } from './sheet-detent-probe';
import {
  SheetScrollIntoViewProvider,
  keyboardDetentIndex,
  useProgrammaticSnap,
  useSheetScrollIntoViewHost,
} from './sheet-scroll-into-view';
import { useDetentDragHaptic } from './sheet-detent-haptic';
import { useManagedSheet, type PresenterGroup } from '../providers/sheet-presentation-provider';

type SheetProps = {
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
  // Render the content inside a scrollable container instead of a plain View.
  // Use this for content taller than the sheet.
  scrollable?: boolean;
  // Extra style for the content/scroll container.
  contentContainerStyle?: StyleProp<ViewStyle>;
  // Optional bottom action area, pinned below the content. When an input lives
  // here (e.g. the comment composer) the padded chrome column lifts it above the
  // keyboard on BOTH platforms — the Android Compose dialog window does not
  // resize itself when the keyboard opens (emulator-verified), so Android needs
  // the JS-side padding just like iOS.
  // Composers only: form actions go in a SheetTopBar through `header`
  // (no-bottom-footers.test.ts holds the list of files allowed a footer).
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
   * chrome column). A chrome-less sheet has no reason to reach for it —
   * pass `enableDynamicSizing` instead. */
  androidContentSized?: boolean;
};

export const Sheet = forwardRef<BottomSheetMethods, SheetProps>(function Sheet(
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
  const { systemColors, sheet: sheetChrome, sheetSurface } = useTheme();
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
  useImperativeHandle(ref, () => managed.handle as BottomSheetMethods, [managed.handle]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track the resting detent so the iOS column bound follows drags between detents.
  const [activeIndex, setActiveIndex] = useState(0);
  // Whether the native sheet is open, so a closed sheet never listens for the
  // keyboard (see the keyboard block below).
  const [isOpen, setIsOpen] = useState(false);
  const columnStyle = useSheetColumnStyle(snapPoints, { enableDynamicSizing, activeIndex, contentSizedOnAndroid });
  // Dev-only observers for #3922 — they feed a log line, never layout.
  const { probeProps, sentinelProps, onColumnLayout } = useSheetDetentProbe(columnStyle, 'Sheet');

  // The keyboard-detent snap on field focus is not a drag: no haptic for it.
  const { programmaticSnapRef, snapWithoutHaptic } = useProgrammaticSnap(managed.handle.snapToIndex);
  // Silent on present; a selection tick only on the climber's own detent drags.
  const playDetentHaptic = useDetentDragHaptic(programmaticSnapRef);

  const handleChange = useCallback(
    (index: number) => {
      playDetentHaptic(index);
      if (index >= 0) {
        setActiveIndex(index);
        setIsOpen(true);
      } else {
        // Reset on close so a re-open of an always-mounted sheet starts at the
        // first detent's (shortest) column height until the native onChange
        // confirms the detent — erring short beats a stale taller column pushing
        // the pinned footer off-screen for a frame.
        setActiveIndex(0);
        setIsOpen(false);
      }
      managed.onChange(index);
      onChangeRef.current?.(index);
    },
    [managed, playDetentHaptic],
  );

  // A fixed header or a pinned footer both need a wrapper around the body, and
  // the native sheet takes exactly one in-flow child — so either one puts us in
  // the chrome column branch below.
  const hasChrome = Boolean(footer || header);
  const lastDetentIndex = useContentFitting ? 0 : effectiveSnapPoints.length - 1;
  // Keyboard clearance for the chrome column below, and the bottom inset the
  // footer / footerless body still owes (the window inset, or 0 while the
  // keyboard covers it). See sheet-keyboard-inset.ts. Listens only while there
  // is a column to pad and the sheet is open. When the keyboard comes up the
  // sheet rises to its keyboard detent (no haptic): at a short detent the
  // keyboard can leave the body no room at all.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const raiseToKeyboardDetent = useCallback(() => {
    const next = keyboardDetentIndex(activeIndexRef.current, lastDetentIndex);
    if (next != null) snapWithoutHaptic(next);
  }, [lastDetentIndex, snapWithoutHaptic]);
  const {
    keyboardOverlap,
    bottomInset,
    columnRef,
    onColumnLayout: measureColumnForKeyboard,
    measureAfterDetentChange,
  } = useSheetKeyboardInset({
    enabled: hasChrome && (isOpen || visible === true),
    onKeyboardShow: raiseToKeyboardDetent,
  });
  // A detent change while the keyboard is up (the raise above included) moves
  // the column without a layout event once the native animation ends.
  useEffect(() => {
    if (isOpen) measureAfterDetentChange();
  }, [activeIndex, isOpen, measureAfterDetentChange]);
  const handleColumnLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onColumnLayout?.(event);
      measureColumnForKeyboard();
    },
    [onColumnLayout, measureColumnForKeyboard],
  );
  // The sheet's single child must carry the iOS detent bound (see
  // useSheetColumnStyle): with a header or footer the chrome column below
  // is that child and the body just fills it (flex:1); without either the body
  // itself is the child, so it carries the bound directly — otherwise an iOS
  // scrollable sheet sizes to its content and anything past the detent is
  // clipped and unreachable instead of scrolling.
  //
  // On Android's content-fitting path the column takes a `maxHeight`, not `flex: 1`,
  // so the body can't `flex: 1` into it — it takes its content height at rest
  // (this is what closes the void) and `flexShrink: 1` so it shrinks and scrolls
  // once a keyboard-up long note pushes the column into that ceiling.
  const bodyStyle = hasChrome ? (contentSizedOnAndroid ? styles.contentShrink : styles.content) : columnStyle;
  // Without a pinned footer the body sits against the bottom edge, so it has to
  // clear the Android edge-to-edge navigation bar itself — the native sheet does
  // not pad content for it. With a footer the body scrolls above the footer, which
  // already carries the window inset. The WINDOW inset, not the mount point's:
  // a sheet docks over the tab bar, and a tab-mounted sheet's local inset folds
  // in iOS 26 tab chrome the sheet covers (see use-window-bottom-inset).
  // Keyed on the FOOTER alone, not `hasChrome`: a header sits above the body and
  // leaves it against the bottom edge, so a header-only sheet still owes the
  // window inset.
  const bodyContentContainerStyle = useSheetBodyContentStyle(Boolean(footer), contentContainerStyle, bottomInset);
  // #3922: measure whichever view actually carries columnStyle — the body when
  // there is no header or footer, the chrome column below when there is.
  const bodyLayout = hasChrome ? undefined : onColumnLayout;
  // A focused field that opts in (the tick note) is scrolled clear of the pinned
  // footer once the keyboard shrinks the body (#5665). See sheet-scroll-into-view.
  const { scrollIntoView, scrollProps } = useSheetScrollIntoViewHost({
    onBodyLayout: bodyLayout,
    lastDetentIndex,
    activeIndex,
    snapToIndex: snapWithoutHaptic,
  });
  const body = scrollable ? (
    <BottomSheetScrollView
      {...scrollProps}
      style={bodyStyle}
      contentContainerStyle={bodyContentContainerStyle}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <SheetScrollIntoViewProvider value={scrollIntoView}>{children}</SheetScrollIntoViewProvider>
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
          // Window inset + gap at rest; just the gap while the keyboard is up,
          // so the bar rests spacing[3] above the keyboard (the column below is
          // padded by the overlap).
          paddingBottom: bottomInset + spacing[3],
        },
      ]}
    >
      {footer}
    </View>
  ) : null;

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={useContentFitting ? undefined : effectiveSnapPoints}
      enableDynamicSizing={useContentFitting}
      enablePanDownToClose={enablePanDownToClose}
      onChange={handleChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={sheetChrome.handleStyle}
      backgroundStyle={surface === 'solid' ? solidBackground : undefined}
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
        // content-fitting path (#4720). Padded by the keyboard overlap on both
        // platforms: neither native sheet window resizes for the keyboard. Not a
        // KeyboardAvoidingView: RN 0.86 measures its overlap from a
        // parent-relative frame, which inside the sheet under-pads by the sheet's
        // distance from the top of the screen (see sheet-keyboard-inset.ts).
        <View
          testID="sheet-chrome-column"
          style={keyboardOverlap > 0 ? [columnStyle, { paddingBottom: keyboardOverlap }] : columnStyle}
          ref={columnRef}
          onLayout={handleColumnLayout}
        >
          {header}
          {body}
          {footerBar}
        </View>
      ) : (
        body
      )}
    </BottomSheet>
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
    // borderTopColor is applied inline from systemColors.separator (scheme-aware).
  },
});
