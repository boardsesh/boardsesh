import { forwardRef, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { BottomSheetModal } from '../sheet-presentation';
import { useTheme } from '../../providers/theme-provider';
import { useEffectiveSurfaceMode } from '../../hooks/use-effective-surface-mode';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';
export const BoardSheetView = forwardRef<
  BottomSheetModal,
  { children: ReactNode; onChange: (index: number) => void; onFullyDismissed: () => void }
>(function BoardSheetView({ children, onChange, onFullyDismissed }, ref) {
  const { sheet, sheetSurface } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  const surfaceMode = useEffectiveSurfaceMode();
  const backgroundStyle = useMemo(
    () =>
      Platform.OS === 'ios'
        ? iosBackgroundStyle
        : surfaceMode === 'glass' || surfaceMode === 'blur'
          ? undefined
          : { backgroundColor: sheetSurface },
    [iosBackgroundStyle, surfaceMode, sheetSurface],
  );

  return (
    <BottomSheetModal
      surfaceSize="list"
      ref={ref}
      index={0}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      // Height is driven by explicit snapPoints, so disable dynamic content
      // sizing — it doesn't play well with a BottomSheetFlatList (no bounded
      // content height to measure).
      enableDynamicSizing={false}
      enablePanDownToClose
      onChange={onChange}
      onFullyDismissed={onFullyDismissed}
      handleIndicatorStyle={sheet.handleStyle}
      backgroundStyle={backgroundStyle}
      style={styles.sheet}
    >
      {children}
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
});
