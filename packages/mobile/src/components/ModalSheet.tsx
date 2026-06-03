// A bottom sheet that renders ABOVE the persistent queue bar. The bar is
// rendered after the screen Stack in app/_layout (so it floats over screens),
// which means an in-tree `Sheet` (gorhom `BottomSheet`) draws *under* it. This
// uses `BottomSheetModal` + a `FullWindowOverlay` container on iOS (mirroring
// `LogAscentSheet`) so the sheet portals over the bar. Same prop surface as
// `Sheet`, driven imperatively via ref (`present()` / `dismiss()`).

import { forwardRef, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  BottomSheetModal,
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
  },
  ref,
) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => customSnapPoints ?? ['50%', '90%'], [customSnapPoints]);

  // Keep our own handle to the modal instance so the chevron close button can
  // drive `dismiss()`, while still forwarding the instance to the parent's ref.
  const innerRef = useRef<BottomSheetModal | null>(null);
  const setRefs = useCallback(
    (instance: BottomSheetModal | null) => {
      innerRef.current = instance;
      if (typeof ref === 'function') ref(instance);
      else if (ref) ref.current = instance;
    },
    [ref],
  );

  const handleClose = useCallback(() => innerRef.current?.dismiss(), []);
  const renderHandle = useCallback(() => <SheetHandle onClose={handleClose} />, [handleClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} pressBehavior="close" />
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

  return (
    <BottomSheetModal
      ref={setRefs}
      index={0}
      snapPoints={enableDynamicSizing ? undefined : snapPoints}
      enableDynamicSizing={enableDynamicSizing}
      enablePanDownToClose={enablePanDownToClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={backgroundStyle}
      handleComponent={renderHandle}
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
    borderTopColor: iosSystemColors.separator,
  },
});
