import { forwardRef, type ReactNode } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModal } from '../sheet-presentation';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useSheetBackgroundStyle } from '../use-sheet-background-style';

export const QueueSheetView = forwardRef<
  BottomSheetModal,
  {
    children: ReactNode;
    isDragging: boolean;
    onChange: (index: number) => void;
    onFullyDismissed: () => void;
  }
>(function QueueSheetView({ children, isDragging, onChange, onFullyDismissed }, ref) {
  const { sheet } = useTheme();
  const { t } = useTranslation('session');
  const sheetBackgroundStyle = useSheetBackgroundStyle();
  return (
    <BottomSheetModal
      surfaceSize="list"
      accessibilityLabel={t('queueDrawer.title')}
      ref={ref}
      index={0}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      enablePanDownToClose
      // Freeze the sheet pan while a row is being dragged so scroll-to-expand
      // never fights the reorder gesture.
      enableContentPanningGesture={!isDragging}
      enableHandlePanningGesture={!isDragging}
      onChange={onChange}
      onFullyDismissed={onFullyDismissed}
      handleIndicatorStyle={sheet.handleStyle}
      backgroundStyle={sheetBackgroundStyle}
      style={styles.sheet}
    >
      {Platform.OS === 'android' ? (
        // Expo's Android sheet uses a separate dialog window. Its RN content
        // needs its own gesture root so row recognizers receive
        // the native pointer stream (#5923).
        <GestureHandlerRootView style={styles.gestureRoot}>{children}</GestureHandlerRootView>
      ) : (
        children
      )}
    </BottomSheetModal>
  );
});
const styles = StyleSheet.create({
  content: { flex: 1 },
  gestureRoot: { flex: 1 },
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
});
