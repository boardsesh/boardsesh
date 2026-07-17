import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
// Migrated off @gorhom/bottom-sheet to Expo's native bottom sheet (#3167).
// The native sheet draws its own scrim, drag handle and (on iOS 26) glass
// background, so the old SheetBackdrop / GlassSheetBackground / FullWindowOverlay
// wiring is gone. Scroll coordination is native; keyboard avoidance for a pinned
// footer is JS-side (the KeyboardAvoidingView below) on BOTH platforms.
//
// Present/dismiss route through the SheetPresentationProvider coordinator so two
// native sheet transitions never overlap (the iOS UIKit deadlock / app freeze —
// see sheet-presentation-provider.tsx).
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hapticMedium } from '../lib/haptics';
import { spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { androidSafeSnapPoints } from './sheet-snap-points';
import { useSheetColumnStyle } from './use-sheet-column-style';
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
  // here (e.g. the comment composer) a KeyboardAvoidingView lifts it above the
  // keyboard on BOTH platforms — the Android Compose dialog window does not
  // resize itself when the keyboard opens (emulator-verified), so Android needs
  // the JS-side padding just like iOS.
  footer?: ReactNode;
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
  },
  ref,
) {
  const { systemColors, sheet: sheetChrome } = useTheme();
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => customSnapPoints ?? ['50%', '90%'], [customSnapPoints]);

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
  const columnStyle = useSheetColumnStyle(snapPoints, { enableDynamicSizing, activeIndex });

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

  // The sheet's single child must carry the iOS detent bound (see
  // useSheetColumnStyle): with a footer the KeyboardAvoidingView below is that
  // child and the body just fills it (flex:1); without one the body itself is
  // the child, so it carries the bound directly — otherwise an iOS scrollable
  // sheet sizes to its content and anything past the detent is clipped and
  // unreachable instead of scrolling.
  const bodyStyle = footer ? styles.content : columnStyle;
  const body = scrollable ? (
    <BottomSheetScrollView
      style={bodyStyle}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {children}
    </BottomSheetScrollView>
  ) : enableDynamicSizing && !footer && Platform.OS === 'web' ? (
    <BottomSheetView style={[bodyStyle, contentContainerStyle]}>{children}</BottomSheetView>
  ) : (
    <View style={[bodyStyle, contentContainerStyle]}>{children}</View>
  );

  const footerBar = footer ? (
    <View
      style={[
        styles.footer,
        {
          backgroundColor: systemColors.secondaryBackground,
          borderTopColor: systemColors.separator,
          paddingBottom: insets.bottom + spacing[3],
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
      snapPoints={enableDynamicSizing ? undefined : androidSafeSnapPoints(snapPoints)}
      enableDynamicSizing={enableDynamicSizing}
      enablePanDownToClose={enablePanDownToClose}
      onChange={handleChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={sheetChrome.handleStyle}
      style={styles.sheet}
    >
      {footer ? (
        // The single flex child of the native sheet: bound to the detent height on
        // iOS (see useSheetColumnStyle) so the pinned footer can't fall off-screen
        // (#3330); flex:1 on Android / fitToContents. `padding` on both platforms:
        // the Android Compose dialog window does not resize for the keyboard, so
        // without it the keyboard covers the footer's input (emulator-verified).
        <KeyboardAvoidingView style={columnStyle} behavior="padding">
          {body}
          {footerBar}
        </KeyboardAvoidingView>
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    // borderTopColor is applied inline from systemColors.separator (scheme-aware).
  },
});
