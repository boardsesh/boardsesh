import { memo, useMemo, useState } from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { HoldPlacement } from '../board-renderer/types';
import { computeContainedBoardSize } from './play-drawer-layout';
import { litHoldIdsFromFrames, resolveWallBadgeSide, type WallBadgeKind, type WallBadgeResolution } from './wall-badge';

const BADGE_HEIGHT = 28;
const ICON_SIZE = 13;
// The inset from the board's edge, and the width assumed before the first layout.
const INSET = spacing[2];
const ESTIMATED_WIDTH = 140;
type WallBadgeProps = {
  resolution: WallBadgeResolution;
  /** The board section's measured size; the board is contain-fitted and centred in it. */
  sectionSize: Readonly<{ width: number; height: number }> | null;
  boardWidth: number;
  boardHeight: number;
  holds: readonly HoldPlacement[];
  frames: string;
  boardName: BoardName;
  mirrored: boolean;
};

function WallBadgeImpl({
  resolution,
  sectionSize,
  boardWidth,
  boardHeight,
  holds,
  frames,
  boardName,
  mirrored,
}: WallBadgeProps) {
  const { t } = useTranslation('session');
  const { variant, colorScheme, systemColors, brandColors, m3, m3SurfaceContainers } = useTheme();
  const reduceMotion = useReducedMotion();
  const [badgeWidth, setBadgeWidth] = useState(ESTIMATED_WIDTH);

  const boardBox = useMemo(
    () =>
      sectionSize ? computeContainedBoardSize(sectionSize.width, sectionSize.height, boardWidth / boardHeight) : null,
    [sectionSize, boardWidth, boardHeight],
  );
  const litHoldIds = useMemo(() => litHoldIdsFromFrames(frames, boardName), [frames, boardName]);
  const side = useMemo(
    () =>
      boardBox
        ? resolveWallBadgeSide({
            litHoldIds,
            holds,
            mirrored,
            boardWidth,
            boardHeight,
            footprint: {
              width: (badgeWidth + INSET) / boardBox.width,
              height: (BADGE_HEIGHT + INSET) / boardBox.height,
            },
          })
        : 'left',
    [boardBox, litHoldIds, holds, mirrored, boardWidth, boardHeight, badgeWidth],
  );

  if (resolution === null || !sectionSize || !boardBox) return null;
  const kind: WallBadgeKind = resolution;

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    if (Math.abs(width - badgeWidth) >= 1) setBadgeWidth(width);
  };

  const lit = kind === 'onWall';
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  // Lit takes the `live` hue (the "physically lit" status colour) at full
  // strength so it reads across the room-dark board art; everything else is the
  // neutral chip surface the wall pill uses.
  const surface = lit
    ? { backgroundColor: brandColors.live }
    : isMaterial
      ? { backgroundColor: m3SurfaceContainers.high }
      : {
          backgroundColor: systemColors.secondaryBackground,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: systemColors.separator,
        };
  const ink = lit
    ? colorScheme === 'dark'
      ? brandColors.onAccent
      : brandColors.onPrimary
    : isMaterial
      ? m3.onSurface
      : systemColors.label;
  const label =
    kind === 'onWall'
      ? t('playView.wallState.onWall')
      : kind === 'previewNotLit'
        ? t('playView.wallState.previewNotLit')
        : kind === 'onlyYou'
          ? t('playView.wallState.onlyYouSeeThis')
          : t('playView.wallState.notOnWall');

  const letterbox = {
    top: (sectionSize.height - boardBox.height) / 2 + INSET,
    edge: (sectionSize.width - boardBox.width) / 2 + INSET,
  };

  return (
    <Animated.View
      // Keyed so a new state or corner re-enters instead of sliding across the holds.
      key={`${kind}-${side}`}
      entering={reduceMotion ? undefined : FadeIn.duration(180)}
      pointerEvents="none"
      onLayout={handleLayout}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      testID="play-drawer-wall-badge"
      style={[
        styles.badge,
        surface,
        { top: letterbox.top },
        side === 'left' ? { left: letterbox.edge } : { right: letterbox.edge },
      ]}
    >
      <Icon name={lit ? 'lightbulb.fill' : 'lightbulb.slash'} size={ICON_SIZE} color={ink} />
      <Text
        variant="caption1"
        color={ink}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.label}
      >
        {label}
      </Text>
    </Animated.View>
  );
}

export const WallBadge = memo(WallBadgeImpl);

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    height: BADGE_HEIGHT,
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.full,
  },
  label: {
    fontWeight: '600',
  },
});
