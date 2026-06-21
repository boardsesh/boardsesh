import { createContext, forwardRef, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFooter,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSheetBackground } from './GlassSheetBackground';
import { hapticMedium } from '../lib/haptics';
import { sheetStyles, spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';

// On iOS a plain BottomSheet renders inside the screen's view tree, so it sits
// behind root-level chrome (the floating tab bar + persistent queue bar).
// Wrapping it in a FullWindowOverlay lifts it into a native window above
// everything. iOS-only — Android stacks RN views fine without it (matches
// ClimbFilterSheet/LogAscentSheet). `containerComponent` only exists on
// BottomSheetModal, so for the plain BottomSheet we wrap the element directly.
const useOverlay = Platform.OS === 'ios';

// Pre-seed the footer height so the scroll body reserves room on the very first
// frame, before the footer's onLayout has measured it. Starting from 0 leaves
// paddingBottom at just spacing[4], so the last content row briefly sits under
// the sticky footer until layout settles. Roughly one button row plus padding;
// handleFooterLayout corrects it to the real height on first layout.
export const ESTIMATED_FOOTER_HEIGHT = 80;

// gorhom's BottomSheetFooterContainer is memoised on the *identity* of the
// `footerComponent` we hand it. If that component is a fresh closure every parent
// render (the inevitable result of capturing inline-JSX `footer` in a useCallback
// dep list), gorhom remounts the whole footer subtree on each render — which
// drops keyboard focus for an input that lives in the footer (CommentSheet's
// composer) and refires onLayout. So `footerComponent` is a single stable
// module-level component; the live footer content and chrome flow in through
// context, letting dynamic content (a loading spinner, an enabled/disabled send
// button) re-render without changing the component identity.
type SheetFooterContextValue = {
  footer: ReactNode;
  onLayout: (event: LayoutChangeEvent) => void;
  backgroundColor: ColorValue;
  borderTopColor: ColorValue;
  paddingBottom: number;
};

const SheetFooterContext = createContext<SheetFooterContextValue | null>(null);

function SheetFooter(props: BottomSheetFooterProps) {
  const footerContext = useContext(SheetFooterContext);
  if (!footerContext) return null;
  const { footer, onLayout, backgroundColor, borderTopColor, paddingBottom } = footerContext;
  return (
    <BottomSheetFooter {...props} bottomInset={0}>
      <View onLayout={onLayout} style={[styles.footer, { backgroundColor, borderTopColor, paddingBottom }]}>
        {footer}
      </View>
    </BottomSheetFooter>
  );
}

type SheetProps = {
  children: ReactNode;
  snapPoints?: (string | number)[];
  enableDynamicSizing?: boolean;
  onChange?: (index: number) => void;
  onClose?: () => void;
  enablePanDownToClose?: boolean;
  // Render the content inside a BottomSheetScrollView instead of a plain
  // BottomSheetView. Use this for content taller than the sheet — never wrap
  // your own BottomSheetScrollView in the children, as nesting it inside the
  // default BottomSheetView breaks gorhom's scroll gesture wiring.
  scrollable?: boolean;
  // Extra style for the content/scroll container. NOTE: when a `footer` is set,
  // the sheet computes its own `paddingBottom` (footer height + a gap) so the
  // last row clears the sticky-footer overlay, and that value OVERRIDES any
  // `paddingBottom` you pass here. Set other padding/margins freely — just don't
  // rely on a custom `paddingBottom` alongside a footer.
  contentContainerStyle?: StyleProp<ViewStyle>;
  // Optional bottom action area. Rendered as a sibling below the content with
  // safe-area-aware bottom padding so the CTA sits comfortably above the home
  // indicator (instead of flush against the screen edge).
  footer?: ReactNode;
  // Keyboard handling for sheets with text inputs (e.g. a comment composer in
  // the footer). Defaults to gorhom's behaviour; pass 'interactive'/'restore'
  // so the input rises above the keyboard instead of being covered.
  keyboardBehavior?: 'extend' | 'fillParent' | 'interactive';
  keyboardBlurBehavior?: 'none' | 'restore';
  android_keyboardInputMode?: 'adjustPan' | 'adjustResize';
  // Render above root-level chrome (tab bar + queue bar) via a FullWindowOverlay
  // on iOS. Needed for sheets opened from a tab screen whose footer/buttons
  // would otherwise sit behind those bars.
  fullWindowOverlay?: boolean;
  // Frosted Liquid-Glass background (the same material the Play Drawer uses).
  // Default. Opt out (`glass={false}`) for the flat opaque secondary-background
  // surface — an escape hatch, not normally needed.
  glass?: boolean;
};

export const Sheet = forwardRef<BottomSheet, SheetProps>(function Sheet(
  {
    children,
    snapPoints: customSnapPoints,
    enableDynamicSizing = false,
    onChange,
    onClose,
    enablePanDownToClose = true,
    scrollable = false,
    contentContainerStyle,
    footer,
    keyboardBehavior,
    keyboardBlurBehavior,
    android_keyboardInputMode,
    fullWindowOverlay = false,
    glass = true,
  },
  ref,
) {
  const { systemColors, sheet: sheetChrome } = useTheme();
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => customSnapPoints ?? ['50%', '90%'], [customSnapPoints]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={sheetChrome.scrimOpacity} />
    ),
    [sheetChrome.scrimOpacity],
  );

  const handleChange = useCallback(
    (index: number) => {
      if (index >= 0) hapticMedium();
      onChange?.(index);
    },
    [onChange],
  );

  const backgroundStyle = {
    ...sheetStyles.background,
    ...sheetChrome.corners,
    backgroundColor: systemColors.secondaryBackground,
  };

  // Footer height feeds the scroll content's bottom padding. gorhom's
  // BottomSheetFooter is an absolutely-positioned overlay pinned to the sheet's
  // bottom (and it rises with the keyboard), so the scrollable body sits *behind*
  // it — without this padding the last rows would hide under the footer. Seed
  // with an estimate so the body reserves room on the first frame; the real
  // height replaces it once the footer lays out.
  const [footerHeight, setFooterHeight] = useState(ESTIMATED_FOOTER_HEIGHT);
  const handleFooterLayout = useCallback((event: LayoutChangeEvent) => {
    setFooterHeight(event.nativeEvent.layout.height);
  }, []);

  // Use gorhom's native sticky footer (the stable module-level SheetFooter)
  // instead of a flex sibling. This keeps the BottomSheetScrollView as the
  // sheet's direct child, which is what preserves gorhom's scroll-gesture wiring
  // — nesting the scrollview inside a BottomSheetView (the old footer path) broke
  // single-finger scrolling on Android and let the body overflow, pushing the
  // footer off-screen. The live footer content + chrome reach SheetFooter through
  // this context value (see the SheetFooterContext comment for why).
  const footerContextValue = useMemo<SheetFooterContextValue | null>(
    () =>
      footer
        ? {
            footer,
            onLayout: handleFooterLayout,
            backgroundColor: systemColors.secondaryBackground,
            borderTopColor: systemColors.separator,
            paddingBottom: insets.bottom + spacing[3],
          }
        : null,
    [footer, handleFooterLayout, systemColors.secondaryBackground, systemColors.separator, insets.bottom],
  );

  // When a sticky footer is present, reserve room below the content so it clears
  // the overlay (footer height + a small gap). This is appended last to
  // contentContainerStyle, so it overrides any paddingBottom the consumer set
  // there (documented on the contentContainerStyle prop).
  const footerSpacing = footer ? { paddingBottom: footerHeight + spacing[4] } : null;

  // The provider wraps the sheet unconditionally (its value is null when there is
  // no footer) so that toggling a footer on/off never changes the tree depth above
  // BottomSheet — a conditional wrapper would remount the sheet and close it.
  const sheet = (
    <SheetFooterContext.Provider value={footerContextValue}>
      <BottomSheet
        ref={ref}
        index={-1}
        snapPoints={enableDynamicSizing ? undefined : snapPoints}
        enableDynamicSizing={enableDynamicSizing}
        enablePanDownToClose={enablePanDownToClose}
        keyboardBehavior={keyboardBehavior}
        keyboardBlurBehavior={keyboardBlurBehavior}
        android_keyboardInputMode={android_keyboardInputMode}
        backdropComponent={renderBackdrop}
        backgroundComponent={glass ? GlassSheetBackground : undefined}
        backgroundStyle={glass ? undefined : backgroundStyle}
        onChange={handleChange}
        onClose={onClose}
        handleIndicatorStyle={sheetChrome.handleStyle}
        footerComponent={footer ? SheetFooter : undefined}
        style={styles.sheet}
      >
        {scrollable ? (
          <BottomSheetScrollView
            style={styles.content}
            contentContainerStyle={[contentContainerStyle, footerSpacing]}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </BottomSheetScrollView>
        ) : (
          <BottomSheetView style={[styles.content, footerSpacing]}>{children}</BottomSheetView>
        )}
      </BottomSheet>
    </SheetFooterContext.Provider>
  );

  return fullWindowOverlay && useOverlay ? <FullWindowOverlay>{sheet}</FullWindowOverlay> : sheet;
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    // borderTopColor is applied inline from systemColors.separator (scheme-aware).
  },
});
