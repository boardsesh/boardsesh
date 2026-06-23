// A bottom sheet that renders ABOVE the persistent queue bar. The bar is
// rendered after the screen Stack in app/_layout (so it floats over screens),
// which means an in-tree `Sheet` (gorhom `BottomSheet`) draws *under* it. This
// uses `BottomSheetModal` + a `FullWindowOverlay` container on iOS (mirroring
// `LogAscentSheet`) so the sheet portals over the bar. Same prop surface as
// `Sheet`, driven imperatively via ref (`present()` / `dismiss()`).

import { forwardRef, useCallback, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { SheetBackdrop } from './SheetBackdrop';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSheetBackground } from './GlassSheetBackground';
import { hapticMedium } from '../lib/haptics';
import { sheetStyles, spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';

// iOS renders the modal in a native window overlay so it sits above the queue
// bar; Android's modal portal already covers it.
function ModalSheetContainer({ children }: { children?: ReactNode }) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}
const modalContainerComponent = Platform.OS === 'ios' ? ModalSheetContainer : undefined;

type ModalSheetProps = {
  children: ReactNode;
  snapPoints?: (string | number)[];
  enableDynamicSizing?: boolean;
  onChange?: (index: number) => void;
  /** Fired when the sheet is dismissed (gesture or programmatic). */
  onDismiss?: () => void;
  enablePanDownToClose?: boolean;
  scrollable?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  footer?: ReactNode;
  // How this modal behaves when presented over another open modal. `push`
  // (default) stacks above it (so the Play Drawer stays beneath); `replace`
  // dismisses the one below.
  stackBehavior?: 'push' | 'replace' | 'switch';
  // Frosted Liquid-Glass background (the same material the Play Drawer uses).
  // Default. Opt out (`glass={false}`) for the flat opaque secondary-background
  // surface.
  glass?: boolean;
};

export const ModalSheet = forwardRef<BottomSheetModal, ModalSheetProps>(function ModalSheet(
  {
    children,
    snapPoints: customSnapPoints,
    enableDynamicSizing = false,
    onChange,
    onDismiss,
    enablePanDownToClose = true,
    scrollable = false,
    contentContainerStyle,
    footer,
    stackBehavior = 'push',
    glass = true,
  },
  ref,
) {
  const { systemColors, sheet } = useTheme();
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => customSnapPoints ?? ['50%', '90%'], [customSnapPoints]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <SheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={sheet.scrimOpacity}
        pressBehavior="close"
      />
    ),
    [sheet.scrimOpacity],
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
    ...sheet.corners,
    backgroundColor: systemColors.secondaryBackground,
  };

  // FOLLOW-UP: this still renders the scrollable body and footer as flex siblings
  // inside a single BottomSheetView — the anti-pattern Sheet.tsx moved away from
  // (it now uses gorhom's native sticky footer via `footerComponent`). Nesting the
  // scrollview inside a BottomSheetView breaks single-finger scrolling on Android
  // and lets the body overflow the footer. PlaylistFormSheet hits this path with
  // footer + scrollable. Port ModalSheet to the same `footerComponent` pattern.
  const footerNode = footer ? (
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
    <BottomSheetModal
      ref={ref}
      index={0}
      snapPoints={enableDynamicSizing ? undefined : snapPoints}
      enableDynamicSizing={enableDynamicSizing}
      enablePanDownToClose={enablePanDownToClose}
      stackBehavior={stackBehavior}
      backdropComponent={renderBackdrop}
      backgroundComponent={glass ? GlassSheetBackground : undefined}
      backgroundStyle={glass ? undefined : backgroundStyle}
      handleIndicatorStyle={sheet.handleStyle}
      containerComponent={modalContainerComponent}
      onChange={handleChange}
      onDismiss={onDismiss}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      style={styles.sheet}
    >
      {footer ? (
        <BottomSheetView style={styles.content}>
          {scrollable ? (
            <BottomSheetScrollView
              style={styles.scrollView}
              contentContainerStyle={contentContainerStyle}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              {children}
            </BottomSheetScrollView>
          ) : (
            children
          )}
          {footerNode}
        </BottomSheetView>
      ) : scrollable ? (
        <BottomSheetScrollView
          style={styles.content}
          contentContainerStyle={contentContainerStyle}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={styles.content}>{children}</BottomSheetView>
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
  scrollView: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    // borderTopColor is applied inline from systemColors.separator (scheme-aware).
  },
});
