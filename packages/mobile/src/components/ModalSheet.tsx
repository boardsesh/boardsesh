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
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackgroundProps,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSheetBackground } from './GlassSheetBackground';
import { hapticMedium } from '../lib/haptics';
import { sheetStyles, spacing } from '../theme/tokens';
import { ThemeProviderBridge, useTheme } from '../providers/theme-provider';

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
  const theme = useTheme();
  const { systemColors, sheet } = theme;
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => customSnapPoints ?? ['50%', '90%'], [customSnapPoints]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={sheet.scrimOpacity}
        pressBehavior="close"
      />
    ),
    [sheet.scrimOpacity],
  );

  const renderBackground = useCallback(
    (props: BottomSheetBackgroundProps) => (
      <ThemeProviderBridge theme={theme}>
        <GlassSheetBackground {...props} />
      </ThemeProviderBridge>
    ),
    [theme],
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

  const themedChildren = <ThemeProviderBridge theme={theme}>{children}</ThemeProviderBridge>;
  const themedFooter = footerNode ? <ThemeProviderBridge theme={theme}>{footerNode}</ThemeProviderBridge> : null;

  return (
    <BottomSheetModal
      ref={ref}
      index={0}
      snapPoints={enableDynamicSizing ? undefined : snapPoints}
      enableDynamicSizing={enableDynamicSizing}
      enablePanDownToClose={enablePanDownToClose}
      stackBehavior={stackBehavior}
      backdropComponent={renderBackdrop}
      backgroundComponent={glass ? renderBackground : undefined}
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
              {themedChildren}
            </BottomSheetScrollView>
          ) : (
            themedChildren
          )}
          {themedFooter}
        </BottomSheetView>
      ) : scrollable ? (
        <BottomSheetScrollView
          style={styles.content}
          contentContainerStyle={contentContainerStyle}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {themedChildren}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={styles.content}>{themedChildren}</BottomSheetView>
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
