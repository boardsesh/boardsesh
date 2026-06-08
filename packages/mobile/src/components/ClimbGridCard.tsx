import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Card as PaperCard } from 'react-native-paper';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from './Text';
import { PressableSurface } from './PressableSurface';
import { ClimbListThumbnail } from './ClimbListThumbnail';
import { AscentStatusGlyph } from './ClimbListItemContent';
import { selectedRowColors } from './climb-list-row-colors';
import { useGradeFormat } from '../hooks/use-grade-format';
import { useTheme } from '../providers/theme-provider';
import { hapticSelection, hapticMedium } from '../lib/haptics';
import { spacing, borderRadius } from '../theme/tokens';

// Portrait board art reads best a touch taller than wide, matching the list
// thumbnail's 76×96 (≈3:4). The card sizes the art by aspect ratio so it scales
// to whatever column width FlashList hands the row.
const THUMBNAIL_ASPECT_RATIO = 3 / 4;

type ClimbGridCardProps = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  onPress: (climb: Climb) => void;
  onOpenActions?: (climb: Climb) => void;
  selected?: boolean;
};

/**
 * Two-up grid card for the climbs list — the alternate to {@link ClimbListRow}.
 * Reuses ClimbListThumbnail (sized to the column via an aspect-ratio wrapper) and
 * the same AscentStatusGlyph badge as the list row, so a tick write re-renders
 * only the 16px glyph, not the card. Tapping activates the climb (same path as
 * the list row's onPress); long-press opens the climb-actions sheet. Swipe
 * actions are intentionally list-only — a 2-up grid has no room for them.
 *
 * Variant-aware: a Paper `Card` (mode="elevated") on the Material variant, a
 * plain pressable surface on systemColors.background for Liquid Glass (cards stay
 * flat; glass is reserved for the floating chrome).
 */
const ClimbGridCard = React.memo(function ClimbGridCard({
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  onPress,
  onOpenActions,
  selected,
}: ClimbGridCardProps) {
  const { systemColors, brandColors, variant } = useTheme();
  const { formatGrade } = useGradeFormat();

  const gradeColor = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;
  const formattedGrade = formatGrade(climb.difficulty) ?? climb.difficulty;

  const highlight = useMemo(() => selectedRowColors(brandColors.primary), [brandColors.primary]);

  const handlePress = useCallback(() => {
    hapticSelection();
    onPress(climb);
  }, [onPress, climb]);

  const handleLongPress = useCallback(() => {
    if (!onOpenActions) return;
    hapticMedium();
    onOpenActions(climb);
  }, [onOpenActions, climb]);

  // Inner: thumbnail with the ascent badge overlaid top-right, then a footer with
  // the name + colorized grade. Shared by both variants so the layout is identical.
  const body = (
    <>
      <View style={styles.thumbnailWrapper}>
        <ClimbListThumbnail
          frames={climb.frames}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          mirrored={climb.mirrored ?? false}
          style={styles.thumbnail}
        />
        <View style={styles.statusBadge}>
          <AscentStatusGlyph climbUuid={climb.uuid} angle={angle} />
        </View>
      </View>

      <View style={styles.footer}>
        <Text variant="subheadline" numberOfLines={1} style={styles.name}>
          {climb.name}
        </Text>
        {/* Colorized grade — same getGradeColor mapping ClimbListItemContent uses
            for the list row, so the two layouts share one visual grade language. */}
        <Text variant="subheadline" numberOfLines={1} style={[styles.grade, { color: gradeColor }]}>
          {formattedGrade}
        </Text>
      </View>
    </>
  );

  const accessibilityLabel = `${climb.name}, ${formattedGrade}`;

  if (variant === 'material') {
    return (
      <PaperCard
        mode="elevated"
        elevation={1}
        onPress={handlePress}
        onLongPress={onOpenActions ? handleLongPress : undefined}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ selected: !!selected }}
        style={[
          styles.materialCard,
          selected
            ? { borderWidth: 2, borderColor: brandColors.primary, backgroundColor: highlight.fill }
            : { borderWidth: 0 },
        ]}
      >
        {body}
      </PaperCard>
    );
  }

  return (
    <PressableSurface
      onPress={handlePress}
      onLongPress={onOpenActions ? handleLongPress : undefined}
      feedback="scale"
      scaleTo={0.97}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!selected }}
      style={[
        styles.glassCard,
        { backgroundColor: systemColors.background },
        selected ? { backgroundColor: highlight.fill, borderColor: highlight.accent } : null,
      ]}
    >
      {body}
    </PressableSurface>
  );
});

export { ClimbGridCard };

const styles = StyleSheet.create({
  glassCard: {
    flex: 1,
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  materialCard: {
    flex: 1,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  thumbnailWrapper: {
    width: '100%',
    aspectRatio: THUMBNAIL_ASPECT_RATIO,
    position: 'relative',
  },
  thumbnail: {
    // Override the fixed 76×96 list cell: fill the column-width wrapper.
    width: '100%',
    height: '100%',
    borderRadius: 0,
  },
  statusBadge: {
    position: 'absolute',
    top: spacing[2],
    right: spacing[2],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  name: {
    flexShrink: 1,
    fontWeight: '600',
  },
  grade: {
    flexShrink: 0,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
