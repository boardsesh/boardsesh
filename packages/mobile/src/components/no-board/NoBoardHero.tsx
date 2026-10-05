// The top of the no-board preview: one real board, drawn large, showing the
// most sent climb on it with its holds lit.
//
// It mounts as the unlit wall and lights up when the climbs arrive. Nothing is
// ever drawn over the board: the caption sits under it.

import { memo } from 'react';
import { PixelRatio, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { BoardImageNative } from '../BoardImageNative';
import { LiveClimbGrade, LiveClimbSubtitle } from '../ClimbListItemContent';
import { boardTypeLabel } from '../board-discovery/board-builder-labels';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import type { NoBoardPreviewConfig } from '../../lib/boards/no-board-preview';
import type { NoBoardHeroBox } from '../../lib/boards/no-board-hero-layout';

// i18n-keep climbs.mobile.emptyState.noBoardPreview.heroEyebrow_moonboard
// Picked by i18next from `context` below: "a MoonBoard", not "a MoonBoard board".

type NoBoardHeroProps = {
  config: NoBoardPreviewConfig;
  /** The climb to light. Null draws the unlit wall. */
  climb: Climb | null;
  /** True while the climbs are still on their way: the caption is placeholders. */
  loading: boolean;
  /**
   * False until the climber has seen this screen once. The board photo is a
   * full-size decode, and nothing should pay for it underneath another screen.
   */
  mountBoard: boolean;
  /** The points the board is drawn at. */
  box: NoBoardHeroBox;
  /** The card's hairline. */
  cardBorderColor: string;
  /** The board's own size, from its render data. */
  boardWidth: number;
  boardHeight: number;
  onPress: () => void;
  accessibilityHint: string;
};

function NoBoardHeroComponent({
  config,
  climb,
  loading,
  mountBoard,
  box,
  cardBorderColor,
  boardWidth,
  boardHeight,
  onPress,
  accessibilityHint,
}: NoBoardHeroProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const frames = climb?.frames ?? '';
  // The holds overlay at the size it is shown, not the board's native width;
  // the photo stays full size. Same pairing as `WallHeroStage`.
  const overlayRenderWidth = Math.round(box.width * PixelRatio.get());

  return (
    <Pressable
      testID="no-board-preview-hero"
      onPress={onPress}
      // An unlit wall is not a climb to open.
      disabled={climb === null}
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      style={styles.root}
    >
      <View style={[styles.frame, { width: box.width, height: box.height, borderColor: cardBorderColor }]}>
        <View style={[styles.clip, { backgroundColor: systemColors.secondaryBackground }]}>
          {mountBoard ? (
            // Lighting a climb dims every hold that is not on it. An unlit wall
            // at full strength would make the climb's arrival read as the
            // lights going down, so the wall waits dimmed.
            <View style={climb ? undefined : styles.unlit}>
              <BoardImageNative
                frames={frames}
                boardName={config.boardName}
                layoutId={config.layoutId}
                sizeId={config.sizeId}
                setIds={config.setIds}
                boardWidth={boardWidth}
                boardHeight={boardHeight}
                mirrored={climb?.mirrored ?? false}
                renderWidth={overlayRenderWidth}
                backgroundVariant="full"
                recyclingKey={frames}
                overlayTestID="no-board-preview-hero-lit"
                style={{ width: box.width, height: box.height }}
              />
            </View>
          ) : null}
        </View>
      </View>
      {climb || loading ? (
        <View style={styles.caption}>
          <Text variant="caption1" color={brandColors.primary} numberOfLines={2} style={styles.eyebrow}>
            {t('mobile.emptyState.noBoardPreview.heroEyebrow', {
              board: boardTypeLabel(config.boardName),
              angle: config.angle,
              context: config.boardName,
            })}
          </Text>
          {climb ? (
            <>
              <View style={styles.nameRow}>
                <Text variant="title2" numberOfLines={1} accessibilityRole="header" style={styles.name}>
                  {climb.name}
                </Text>
                <LiveClimbGrade
                  climb={climb}
                  boardName={config.boardName}
                  layoutId={config.layoutId}
                  angle={config.angle}
                  gradeIsConsensus={false}
                />
              </View>
              <LiveClimbSubtitle
                boardName={config.boardName}
                layoutId={config.layoutId}
                climbUuid={climb.uuid}
                angle={config.angle}
                isDraft={climb.is_draft ?? false}
                ascensionistCount={climb.ascensionist_count ?? 0}
                qualityAverage={climb.quality_average}
                setterUsername={climb.setter_username ?? ''}
              />
            </>
          ) : (
            <View
              testID="no-board-preview-hero-loading"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.placeholders}
            >
              <View style={[styles.namePlaceholder, { backgroundColor: systemColors.fill }]} />
              <View style={[styles.statsPlaceholder, { backgroundColor: systemColors.fill }]} />
            </View>
          )}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Memoized: one board photo and one overlay, redrawn only when the climb or the size changes. */
export const NoBoardHero = memo(NoBoardHeroComponent);

const styles = StyleSheet.create({
  root: {
    alignSelf: 'stretch',
  },
  // The border is what tells a pale wall from a white page in light mode. It sits
  // on the outer view; the clip is inside it so the corners stay clean.
  frame: {
    alignSelf: 'center',
    borderRadius: borderRadius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  clip: {
    flex: 1,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unlit: {
    opacity: 0.4,
  },
  caption: {
    marginTop: spacing[3],
    gap: 2,
  },
  eyebrow: {
    fontWeight: '600',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  name: {
    flex: 1,
    minWidth: 0,
  },
  placeholders: {
    gap: spacing[2],
    paddingTop: spacing[1],
  },
  namePlaceholder: {
    width: '62%',
    height: 24,
    borderRadius: borderRadius.full,
  },
  statsPlaceholder: {
    width: '44%',
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.7,
  },
});
