import { forwardRef, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hapticMedium } from '../lib/haptics';
import { sheetStyles, spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { SheetHandle } from './SheetHandle';

// On iOS a plain BottomSheet renders inside the screen's view tree, so it sits
// behind root-level chrome (the floating tab bar + persistent queue bar).
// Wrapping it in a FullWindowOverlay lifts it into a native window above
// everything. iOS-only — Android stacks RN views fine without it (matches
// ClimbFilterSheet/LogAscentSheet). `containerComponent` only exists on
// BottomSheetModal, so for the plain BottomSheet we wrap the element directly.
const useOverlay = Platform.OS === 'ios';

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
  },
  ref,
) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => customSnapPoints ?? ['50%', '90%'], [customSnapPoints]);

  // Keep our own handle to the sheet instance so the chevron close button can
  // drive `close()`, while still forwarding the instance to the parent's ref.
  const innerRef = useRef<BottomSheet | null>(null);
  const setRefs = useCallback(
    (instance: BottomSheet | null) => {
      innerRef.current = instance;
      if (typeof ref === 'function') ref(instance);
      else if (ref) ref.current = instance;
    },
    [ref],
  );

  const handleClose = useCallback(() => innerRef.current?.close(), []);
  const renderHandle = useCallback(() => <SheetHandle onClose={handleClose} />, [handleClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const handleChange = useCallback(
    (index: number) => {
      if (index >= 0) hapticMedium();
      onChange?.(index);
    },
    [onChange],
  );

  const backgroundStyle = { ...sheetStyles.background, backgroundColor: systemColors.secondaryBackground };

  const footerNode = footer ? (
    <View
      style={[
        styles.footer,
        { backgroundColor: systemColors.secondaryBackground as string, paddingBottom: insets.bottom + spacing[3] },
      ]}
    >
      {footer}
    </View>
  ) : null;

  const sheet = (
    <BottomSheet
      ref={setRefs}
      index={-1}
      snapPoints={enableDynamicSizing ? undefined : snapPoints}
      enableDynamicSizing={enableDynamicSizing}
      enablePanDownToClose={enablePanDownToClose}
      keyboardBehavior={keyboardBehavior}
      keyboardBlurBehavior={keyboardBlurBehavior}
      android_keyboardInputMode={android_keyboardInputMode}
      backdropComponent={renderBackdrop}
      backgroundStyle={backgroundStyle}
      onChange={handleChange}
      onClose={onClose}
      handleComponent={renderHandle}
      style={styles.sheet}
    >
      {footer ? (
        // Footer path: wrap scroll/static body + footer in a BottomSheetView so
        // they share the sheet's flex column and the footer hugs the bottom.
        <BottomSheetView style={styles.content}>
          {scrollable ? (
            <BottomSheetScrollView
              style={styles.scrollView}
              contentContainerStyle={contentContainerStyle}
              showsVerticalScrollIndicator={false}
            >
              {children}
            </BottomSheetScrollView>
          ) : (
            children
          )}
          {footerNode}
        </BottomSheetView>
      ) : scrollable ? (
        // No-footer scrollable path stays unchanged for existing consumers:
        // BottomSheetScrollView as the direct child keeps gorhom's gesture
        // wiring intact (nesting it inside BottomSheetView is what the wrapper
        // historically warned against).
        <BottomSheetScrollView
          style={styles.content}
          contentContainerStyle={contentContainerStyle}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={styles.content}>{children}</BottomSheetView>
      )}
    </BottomSheet>
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
  scrollView: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
  },
});
