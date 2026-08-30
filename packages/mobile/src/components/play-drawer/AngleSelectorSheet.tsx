import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { useBoardAngleOptions } from '../../hooks/use-board-angle-options';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { useAngles, useClimbStatsHistory } from '../../lib/graphql/hooks';
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
  layoutId,
  climbUuid,
  currentAngle,
  onAngleChange,
}: AngleSelectorSheetProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { t: tBoards } = useTranslation('boards');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { gradeFormat } = useGradeFormat();
  const sheetRef = useRef<BottomSheetModal>(null);

  // Single large snap point so the sheet always opens at full "big" size with
  // room for the diagram, stats, slider and Done button above the home indicator.
  // (androidSafeSnapPoints leaves a >= 75% detent as-is, so Android keeps this big.)
  const snapPoints = useMemo(() => androidSafeSnapPoints(['90%']), []);

  // Aurora/MoonBoard/Woods retain their bundled tables. Quantum's values belong
  // to the signed catalogue and are layout-specific, so they are queried only
  // while this sheet is open. No static fallback means a missing catalogue can
  // never make an unsupported wall angle look selectable.
  const staticAngles = useBoardAngleOptions(boardName as BoardName);
  const quantumAnglesQuery = useAngles('quantum', layoutId, boardName === 'quantum' && visible);
  const angles = useMemo(() => {
    if (boardName !== 'quantum') return staticAngles;
    return [...new Set((quantumAnglesQuery.data ?? []).map(({ angle }) => angle))]
      .filter((angle) => Number.isSafeInteger(angle) && angle >= 0 && angle <= 90)
      .sort((first, second) => first - second);
  }, [boardName, staticAngles, quantumAnglesQuery.data]);
  const angleOptionsAvailable = angles.length > 0;

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

  useEffect(() => {
    if (
      visible &&
      boardName === 'quantum' &&
      quantumAnglesQuery.isSuccess &&
      angles.length > 0 &&
      !angles.includes(currentAngleRef.current)
    ) {
      setSelectedAngle(angles[0]);
    }
  }, [angles, boardName, quantumAnglesQuery.isSuccess, visible]);

  // Present/dismiss route through the coordinator (serialized, no overlapping
  // native transitions). The sheet stays mounted as a PlayDrawer sibling, so no
  // onFullyDismissed is needed; `onClose` fires on a user pan-down / backdrop —
  // which does NOT apply the previewed angle (that only happens via "Done").
  const managed = useManagedSheet({ open: visible, sheetRef, onClose });

  const handleDone = useCallback(() => {
    if (!angleOptionsAvailable || !angles.includes(selectedAngle)) return;
    onAngleChange(selectedAngle);
    onClose();
  }, [angleOptionsAvailable, angles, onAngleChange, selectedAngle, onClose]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={sheetStyles.indicator}
    >
      <BottomSheetView style={[styles.container, { paddingBottom: insets.bottom + spacing[4] }]}>
        <Text variant="headline" style={styles.title}>
          {t('mobile.angleSelector.title')}
        </Text>

        {angleOptionsAvailable ? (
          <>
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

            {quality > 0 ? (
              <View style={styles.stars} accessibilityLabel={`★ ${quality.toFixed(1)}`}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <Text
                    key={star}
                    variant="body"
                    style={[
                      styles.star,
                      { color: quality >= star ? iosSystemColors.starGold : systemColors.secondaryLabel },
                    ]}
                  >
                    {quality >= star ? '★' : '☆'}
                  </Text>
                ))}
              </View>
            ) : null}

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
          </>
        ) : boardName === 'quantum' ? (
          <Text variant="body" color={systemColors.secondaryLabel} style={styles.catalogStatus}>
            {quantumAnglesQuery.isPending || quantumAnglesQuery.isFetching
              ? tBoards('mobile.create.catalogAnglesLoading')
              : tBoards('mobile.create.catalogAnglesUnavailable')}
          </Text>
        ) : null}

        <Pressable
          onPress={handleDone}
          disabled={!angleOptionsAvailable}
          accessibilityRole="button"
          accessibilityLabel={tCommon('actions.done')}
          accessibilityState={{ disabled: !angleOptionsAvailable }}
          style={({ pressed }) => [
            styles.doneButton,
            !angleOptionsAvailable && styles.doneButtonDisabled,
            pressed && angleOptionsAvailable && styles.doneButtonPressed,
          ]}
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
  catalogStatus: {
    flex: 1,
    paddingVertical: spacing[5],
    textAlign: 'center',
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
  doneButtonDisabled: {
    opacity: 0.45,
  },
  doneText: {
    color: iosSystemColors.white,
    fontWeight: '600',
  },
});
