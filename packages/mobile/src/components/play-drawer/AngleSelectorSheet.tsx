import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { ANGLES } from '@boardsesh/board-config';
import { Text } from '../Text';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { useClimbStatsHistory } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { buildAngleStatsMap, type AngleStats } from './community-utils';
import { AngleBoardDiagram } from './AngleBoardDiagram';
import { AngleSlider } from './AngleSlider';
import { iosSystemColors } from '../../theme/ios-colors';
import { brandColors } from '../../theme/colors';
import { spacing, sheetStyles } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';

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

  // Single large snap point so the sheet always opens at full "big" size with
  // room for the diagram, stats, slider and Done button above the home indicator.
  // (androidSafeSnapPoints leaves a >= 75% detent as-is, so Android keeps this big.)
  const snapPoints = useMemo(() => androidSafeSnapPoints(['90%']), []);

  // Valid angles come from the static per-board table (what web uses) — robust
  // and offline, unlike a per-board query.
  const angles = useMemo<number[]>(() => ANGLES[boardName as BoardName] ?? [], [boardName]);

  // Live preview angle. Applied to the board only when "Done" is pressed; the
  // diagram, grade, stars and sends all reflect this as the user slides.
  const [selectedAngle, setSelectedAngle] = useState(currentAngle);

  // The sheet stays mounted as a PlayDrawer sibling (imperative present()/dismiss()
  // model), so gate the stats-history fetch on the sheet actually
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

  // Reset the preview to the board's actual angle each time the sheet opens.
  useEffect(() => {
    if (visible) setSelectedAngle(currentAngleRef.current);
  }, [visible]);

  // Present/dismiss route through the coordinator (serialized, no overlapping
  // native transitions). The sheet stays mounted as a PlayDrawer sibling, so no
  // onFullyDismissed is needed; `onClose` fires on a user pan-down / backdrop —
  // which does NOT apply the previewed angle (that only happens via "Done").
  const managed = useManagedSheet({ open: visible, sheetRef, onClose });

  const handleDone = useCallback(() => {
    onAngleChange(selectedAngle);
    onClose();
  }, [onAngleChange, selectedAngle, onClose]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={managed.onChange}
      handleIndicatorStyle={sheetStyles.indicator}
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
