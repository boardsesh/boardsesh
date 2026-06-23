import { memo, useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import { BottomSheetModal, BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { SheetBackdrop } from '../SheetBackdrop';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { ANGLES } from '@boardsesh/board-config';
import { Text } from '../Text';
import { GlassSheetBackground } from '../GlassSheetBackground';
import { useClimbStatsHistory } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { buildAngleStatsMap, type AngleStats } from './community-utils';
import { AngleBoardDiagram } from './AngleBoardDiagram';
import { AngleSlider } from './AngleSlider';
import { iosSystemColors } from '../../theme/ios-colors';
import { brandColors } from '../../theme/colors';
import { spacing, sheetStyles } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type AngleSelectorSheetProps = {
  visible: boolean;
  onClose: () => void;
  boardName: string;
  layoutId: number;
  /** Current climb, used to show the per-angle grade/quality/sends preview. */
  climbUuid?: string;
  currentAngle: number;
  onAngleChange: (angle: number) => void;
};

// Render the modal in a FullWindowOverlay on iOS so it portals above the play
// drawer + tab/queue bars — the proven recipe shared by ModalSheet and
// LogAscentSheet (BottomSheetModal + stackBehavior=push + static BottomSheetView).
function AngleSelectorModalContainer({ children }: PropsWithChildren) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}
const modalContainerComponent = Platform.OS === 'ios' ? AngleSelectorModalContainer : undefined;

export const AngleSelectorSheet = memo(function AngleSelectorSheet({
  visible,
  onClose,
  boardName,
  climbUuid,
  currentAngle,
  onAngleChange,
}: AngleSelectorSheetProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { gradeFormat } = useGradeFormat();
  const sheetRef = useRef<BottomSheetModal>(null);
  const isPresentedRef = useRef(false);

  // Single large snap point so the sheet always opens at full "big" size with
  // room for the diagram, stats, slider and Done button above the home indicator.
  const snapPoints = useMemo(() => ['90%'], []);

  // Valid angles come from the static per-board table (what web uses) — robust
  // and offline, unlike a per-board query.
  const angles = useMemo<number[]>(() => ANGLES[boardName as BoardName] ?? [], [boardName]);

  // Live preview angle. Applied to the board only when "Done" is pressed; the
  // diagram, grade, stars and sends all reflect this as the user slides.
  const [selectedAngle, setSelectedAngle] = useState(currentAngle);

  // The sheet stays mounted as a PlayDrawer sibling (stackBehavior=push needs an
  // always-mounted modal), so gate the stats-history fetch on the sheet actually
  // being presented — otherwise CLIMB_STATS_HISTORY would fire for every climb the
  // user swipes through in the drawer, even when they never open the angle selector
  // (mirrors the QueueList active-gate). React Query's 5-min staleTime keeps stats
  // warm across re-opens and still dedupes with CommunitySection's below-fold query.
  const { data: statsHistory } = useClimbStatsHistory(boardName, visible ? (climbUuid ?? null) : null);
  const statsByAngle = useMemo(() => buildAngleStatsMap(statsHistory, gradeFormat), [statsHistory, gradeFormat]);
  const stats: AngleStats | undefined = statsByAngle.get(selectedAngle);
  const quality = stats?.quality ?? 0;

  const currentAngleRef = useRef(currentAngle);
  currentAngleRef.current = currentAngle;

  useEffect(() => {
    if (visible && !isPresentedRef.current) {
      // Reset the preview to the board's actual angle each time the sheet opens.
      setSelectedAngle(currentAngleRef.current);
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!visible && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [visible]);

  // Dismissed by gesture / backdrop / programmatically — does NOT apply the
  // previewed angle (that only happens via "Done").
  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

  const handleDone = useCallback(() => {
    onAngleChange(selectedAngle);
    onClose();
  }, [onAngleChange, selectedAngle, onClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} pressBehavior="close" />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      name="angle-selector"
      index={0}
      stackBehavior="push"
      snapPoints={snapPoints}
      containerComponent={modalContainerComponent}
      enablePanDownToClose
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={sheetStyles.indicator}
      backgroundComponent={GlassSheetBackground}
    >
      <BottomSheetView style={[styles.container, { paddingBottom: insets.bottom + spacing[4] }]}>
        <Text variant="headline" style={styles.title}>
          {t('mobile.angleSelector.title')}
        </Text>

        <AngleBoardDiagram
          angle={selectedAngle}
          size={150}
          accessibilityLabel={t('mobile.angleSelector.diagramAria', { angle: selectedAngle })}
        />

        <Text variant="largeTitle" style={[styles.angleValue, { color: systemColors.label }]}>
          {selectedAngle}°
        </Text>

        {stats?.gradeName ? (
          <Text variant="headline" style={[styles.grade, { color: stats.color }]}>
            {stats.gradeName}
          </Text>
        ) : null}

        <View style={styles.stars} accessibilityLabel={`★ ${quality.toFixed(1)}`}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Text
              key={n}
              variant="body"
              style={[styles.star, { color: quality >= n ? iosSystemColors.starGold : systemColors.secondaryLabel }]}
            >
              {quality >= n ? '★' : '☆'}
            </Text>
          ))}
        </View>

        {stats && stats.sends > 0 ? (
          <Text variant="caption1" style={[styles.ascents, { color: systemColors.secondaryLabel }]}>
            {t('mobile.community.ascensionists', { count: stats.sends })}
          </Text>
        ) : null}

        <Text variant="caption2" style={[styles.hint, { color: systemColors.tertiaryLabel }]}>
          {t('mobile.angleSelector.fromVerticalHint')}
        </Text>

        <View style={styles.sliderWrap}>
          <AngleSlider angles={angles} value={selectedAngle} onChange={setSelectedAngle} />
        </View>

        <Pressable
          onPress={handleDone}
          accessibilityRole="button"
          accessibilityLabel={tCommon('actions.done')}
          style={({ pressed }) => [styles.doneButton, pressed && styles.doneButtonPressed]}
        >
          <Text variant="headline" style={styles.doneText}>
            {tCommon('actions.done')}
          </Text>
        </Pressable>
      </BottomSheetView>
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[2],
    alignItems: 'center',
  },
  title: {
    alignSelf: 'flex-start',
    marginBottom: spacing[2],
  },
  angleValue: {
    fontWeight: '700',
    marginTop: spacing[2],
  },
  grade: {
    marginTop: spacing[1],
  },
  stars: {
    flexDirection: 'row',
    gap: spacing[1],
    marginTop: spacing[1],
  },
  star: {
    fontSize: 18,
  },
  ascents: {
    marginTop: spacing[1],
  },
  hint: {
    marginTop: spacing[1],
  },
  sliderWrap: {
    width: '100%',
    marginTop: spacing[4],
    marginBottom: spacing[4],
  },
  doneButton: {
    width: '100%',
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: brandColors.primary,
  },
  doneButtonPressed: {
    opacity: 0.85,
  },
  doneText: {
    color: iosSystemColors.white,
    fontWeight: '600',
  },
});
