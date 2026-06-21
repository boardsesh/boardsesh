import { memo, useCallback, useMemo } from 'react';
import { ScrollView, View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName, SimilarClimb } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import * as Haptics from 'expo-haptics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { buildClimbStub, formatByline, rankBySizeCompatibility } from './similar-climbs-utils';
import { useSimilarClimbs } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type SimilarClimbsSectionProps = {
  climbUuid: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  onClimbPress: (climb: Climb) => void;
};

const SKELETON_COUNT = 3;
const CARD_WIDTH = 96;

export const SimilarClimbsSection = memo(function SimilarClimbsSection({
  climbUuid,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  onClimbPress,
}: SimilarClimbsSectionProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { data: climbs, isLoading, isError, refetch } = useSimilarClimbs(boardName, climbUuid, layoutId, angle);

  // Wall-compatible climbs rank first; incompatible ones are dimmed and last.
  const ranked = useMemo(() => rankBySizeCompatibility(climbs ?? [], sizeId), [climbs, sizeId]);

  const handlePress = useCallback(
    (similar: SimilarClimb) => {
      void Haptics.selectionAsync();
      onClimbPress(buildClimbStub(similar, boardName));
    },
    [onClimbPress, boardName],
  );

  const handleRetry = useCallback(() => {
    void Haptics.selectionAsync();
    void refetch();
  }, [refetch]);

  if (isLoading) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroller}>
        {Array.from({ length: SKELETON_COUNT }, (_, index) => (
          <View key={index} style={[styles.card, styles.skeletonCard]} />
        ))}
      </ScrollView>
    );
  }

  if (isError) {
    return (
      <Pressable
        onPress={handleRetry}
        style={styles.emptyContainer}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.similarClimbs.retry')}
      >
        <Icon name="refresh" size={20} color={brandColors.primary} />
        <Text variant="subheadline" color={brandColors.primary}>
          {t('mobile.similarClimbs.retry')}
        </Text>
      </Pressable>
    );
  }

  if (ranked.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Icon name="search" size={20} color={iosSystemColors.systemGray} />
        <Text variant="subheadline" color={iosSystemColors.systemGray}>
          {t('mobile.similarClimbs.empty')}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroller}>
      {ranked.map(({ climb: similar, compatible }) => {
        const gradeColor = getGradeColor(similar.difficultyName) ?? DEFAULT_GRADE_COLOR;
        const formattedGrade = formatGrade(similar.difficultyName) ?? similar.difficultyName ?? '';
        const byline = formatByline(similar, tClimbs);
        return (
          <Pressable
            key={similar.uuid}
            onPress={() => handlePress(similar)}
            style={({ pressed }) => [styles.card, !compatible && styles.cardDimmed, pressed && styles.cardPressed]}
            accessibilityRole="button"
            accessibilityLabel={similar.name || t('mobile.queue.unknownClimb')}
          >
            <ClimbListThumbnail
              frames={similar.frames ?? ''}
              boardName={boardName as BoardName}
              layoutId={similar.layoutId}
              sizeId={sizeId}
              setIds={setIds}
            />
            <Text variant="subheadline" numberOfLines={2} style={styles.name}>
              {similar.name}
            </Text>
            {formattedGrade ? (
              <View style={[styles.gradeChip, { backgroundColor: gradeColor }]}>
                <Text variant="caption2" color={iosSystemColors.white}>
                  {formattedGrade}
                </Text>
              </View>
            ) : null}
            {byline ? (
              <Text variant="caption2" color={iosSystemColors.systemGray} numberOfLines={1} style={styles.byline}>
                {byline}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  scroller: {
    gap: spacing[3],
    paddingVertical: spacing[1],
  },
  card: {
    width: CARD_WIDTH,
    gap: spacing[1],
  },
  cardPressed: {
    opacity: 0.6,
  },
  cardDimmed: {
    opacity: 0.45,
  },
  skeletonCard: {
    height: spacing[16],
    borderRadius: borderRadius.md,
    backgroundColor: `${iosSystemColors.systemGray}14`,
  },
  name: {
    marginTop: spacing[1],
  },
  gradeChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
  },
  byline: {
    width: '100%',
  },
  emptyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
});
