import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { ClimbListThumbnail, THUMBNAIL_WIDTH } from '../ClimbListThumbnail';
import { Text } from '../Text';
import { useGradeFormat } from '../../hooks/use-grade-format';
import type { ClimbListItemClimb } from '../ClimbListItemContent';
import { spacing } from '../../theme/tokens';

export type ClimbCoverCardProps = {
  climb: ClimbListItemClimb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  onPress: () => void;
};

/**
 * Compact climb card for Home's horizontal rows: the portrait board thumbnail
 * (the cached native render — `ClimbListThumbnail`) over the climb name and a
 * colorized grade. The vertical sibling of `ClimbListItemContent`'s row layout,
 * sized to the thumbnail width so a row of these reads as an even strip.
 */
export const ClimbCoverCard = memo(function ClimbCoverCard({
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  onPress,
}: ClimbCoverCardProps) {
  const { formatGrade } = useGradeFormat();
  const gradeColor = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;
  const formattedGrade = formatGrade(climb.difficulty) ?? climb.difficulty;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={climb.name}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <ClimbListThumbnail
        frames={climb.frames}
        boardName={boardName}
        layoutId={layoutId}
        sizeId={sizeId}
        setIds={setIds}
        mirrored={climb.mirrored ?? false}
      />
      <Text variant="footnote" numberOfLines={1} style={styles.name}>
        {climb.name}
      </Text>
      <Text variant="caption1" numberOfLines={1} style={[styles.grade, { color: gradeColor }]}>
        {formattedGrade}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    width: THUMBNAIL_WIDTH,
    gap: spacing[1],
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  name: {
    fontWeight: '600',
  },
  grade: {
    fontWeight: '700',
  },
});
