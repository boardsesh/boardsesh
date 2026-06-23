// Bottom-sheet wrapper around QuickTickBar. Used by every ticking entry
// point — the play drawer's tick button, the persistent queue bar, the
// climb detail screen — so the form, dismissal model (handle + pan-down +
// backdrop tap), and keyboard handling stay identical across surfaces.
//
// Uses `BottomSheetModal` (not the regular `BottomSheet`) so it renders in
// a portal above the play drawer's own modal. `FullWindowOverlay` on iOS
// lifts the sheet above the tab bar — same pattern as DevicePickerSheet.
import { useCallback, useEffect, useMemo, useRef, type PropsWithChildren } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { BottomSheetModal, BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { SheetBackdrop } from './SheetBackdrop';
import { FullWindowOverlay } from 'react-native-screens';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { Icon } from './Icon';
import { GlassSheetBackground } from './GlassSheetBackground';
import { QuickTickBar } from './play-drawer/QuickTickBar';

type LogAscentSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  climbUuid: string;
  boardName: string;
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
  consensusGradeName?: string;
};

function LogAscentModalContainer({ children }: PropsWithChildren) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}

const modalContainerComponent = Platform.OS === 'ios' ? LogAscentModalContainer : undefined;

export function LogAscentSheet({
  visible,
  onDismiss,
  climbUuid,
  boardName,
  angle,
  isMirror,
  isBenchmark,
  layoutId,
  sizeId,
  setIds,
  sessionId,
  consensusGradeName,
}: LogAscentSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  // Tracks whether the modal is currently *presented* (mounted into the
  // gorhom modal stack), independent of the external `visible` prop. After
  // a pan-down dismiss, gorhom unregisters the modal internally before
  // `onDismiss` fires — calling `dismiss()` from our `visible` effect at
  // that moment leaves the modal in an inconsistent state where a later
  // `present()` is a no-op (the bug: tap tick → swipe down → tap tick →
  // nothing happens).
  const isPresentedRef = useRef(false);
  const { systemColors } = useTheme();
  const { t } = useTranslation('session');

  useEffect(() => {
    if (visible && !isPresentedRef.current) {
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!visible && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [visible]);

  const handleSheetDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onDismiss();
  }, [onDismiss]);

  // Default to 60% so the climb image stays visible above the sheet (the
  // UX review flagged full-cover + carousel-disabled as the wrong
  // tradeoff). The 92% snap is the keyboard-extended state: when the
  // comment `BottomSheetTextInput` gains focus, gorhom auto-snaps to the
  // last point so the input and save buttons stay above the keyboard.
  const snapPoints = useMemo(() => ['60%', '92%'], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} pressBehavior="close" />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      name="log-ascent"
      index={0}
      stackBehavior="push"
      snapPoints={snapPoints}
      containerComponent={modalContainerComponent}
      enablePanDownToClose
      onDismiss={handleSheetDismiss}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={styles.indicator}
      backgroundComponent={GlassSheetBackground}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetView style={styles.content}>
        <View style={styles.closeButtonRow}>
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel={t('playView.tickBar.closeAria')}
            hitSlop={8}
            style={({ pressed }) => [
              styles.closeButton,
              { backgroundColor: systemColors.fill },
              pressed && styles.closeButtonPressed,
            ]}
          >
            <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel} />
          </Pressable>
        </View>
        <QuickTickBar
          climbUuid={climbUuid}
          boardName={boardName}
          angle={angle}
          isMirror={isMirror}
          isBenchmark={isBenchmark}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          sessionId={sessionId}
          consensusGradeName={consensusGradeName}
          onDismiss={onDismiss}
        />
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  indicator: {
    backgroundColor: iosSystemColors.separator,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  content: {
    flex: 1,
  },
  closeButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonPressed: {
    opacity: 0.7,
  },
});
