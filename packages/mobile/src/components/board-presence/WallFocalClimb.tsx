import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { useBoardPresenceCurrent } from '@boardsesh/board-presence-react';
import type { BoardName } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { BoardDriverAvatar } from './BoardDriverAvatar';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { getBoardRenderData } from '../../lib/board-details';
import { computeContainedBoardSize } from '../play-drawer/play-drawer-layout';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing, borderRadius } from '../../theme/tokens';

/**
 * The landscape wall tab's leading focal pane: a large contain-fit render of the
 * currently-lit climb with its name / grade / who lit it, or a dim placeholder
 * when the wall is dark. Non-scrolling — it stays put as the "what's lit RIGHT
 * NOW" anchor while the trailing list scrolls.
 *
 * The board art MUST contain-fit (board aspect ratios span ~0.43 tall Kilter to
 * ~1.81 wide Kilter), so the box is measured with `onLayout` and the art sized
 * via `computeContainedBoardSize` — never a fixed `aspectRatio` on the container,
 * which would crop or letterbox several boards. Recomputed on every width change
 * (rotation / Split View); the contained size is not memoized across a resize.
 */
function setIdsToNumbers(setIds: string): number[] {
  return (
    setIds
      .split(',')
      .map((setIdText) => setIdText.trim())
      // Drop empty tokens BEFORE Number(): Number('') is 0 (finite), so an empty
      // setIds string would otherwise yield [0] and slip past the length===0 guard.
      .filter((setIdText) => setIdText.length > 0)
      .map((setIdText) => Number(setIdText))
      .filter((setIdValue) => Number.isFinite(setIdValue))
  );
}

function WallFocalClimbComponent({ boardConfig }: { boardConfig: BoardConfig | null }) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { currentClimb } = useBoardPresenceCurrent();

  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const renderData = useMemo(() => {
    if (!boardConfig) return null;
    const setIds = setIdsToNumbers(boardConfig.setIds);
    if (setIds.length === 0) return null;
    return getBoardRenderData({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds,
    });
  }, [boardConfig]);

  const contained =
    box && renderData
      ? computeContainedBoardSize(box.width, box.height, renderData.boardWidth / renderData.boardHeight)
      : null;

  const litBy = currentClimb?.sentByDisplayName?.trim() || null;
  const setter = currentClimb?.setter?.trim();
  const grade = currentClimb?.grade ? formatGrade(currentClimb.grade) : null;
  const gradeColor = getGradeColor(currentClimb?.grade ?? '') ?? DEFAULT_GRADE_COLOR;

  return (
    <View style={styles.root}>
      <View style={styles.artBox} onLayout={handleLayout}>
        {currentClimb && boardConfig && renderData ? (
          // Lit climb: render the art once the box is measured. For the pre-measure
          // frame (box null → contained null) render nothing, NOT the dark
          // placeholder — otherwise the pane briefly claims the wall is dark while a
          // climb is actually lit.
          contained ? (
            <BoardImageNative
              frames={currentClimb.frames ?? ''}
              boardName={boardConfig.boardName as BoardName}
              layoutId={boardConfig.layoutId}
              sizeId={boardConfig.sizeId}
              setIds={boardConfig.setIds}
              boardWidth={renderData.boardWidth}
              boardHeight={renderData.boardHeight}
              style={{
                width: contained.width,
                height: contained.height,
                borderRadius: borderRadius.lg,
                overflow: 'hidden',
              }}
            />
          ) : null
        ) : (
          <View style={styles.darkWall}>
            <Icon name="lightbulb" size={40} color={systemColors.tertiaryLabel} />
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.darkText}>
              {t('mobile.boardPresence.wallDark')}
            </Text>
          </View>
        )}
      </View>
      {currentClimb ? (
        <View style={styles.meta}>
          <View style={styles.nameRow}>
            <Text variant="title3" color={systemColors.label} numberOfLines={1} style={styles.name}>
              {currentClimb.name ?? ''}
            </Text>
            {grade ? (
              <Text variant="title3" style={[styles.grade, { color: gradeColor }]}>
                {grade}
              </Text>
            ) : null}
          </View>
          {setter ? (
            <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
              {t('mobile.boardPresence.setByLine', { setter })}
            </Text>
          ) : null}
          {litBy ? (
            <View style={styles.driverRow}>
              <BoardDriverAvatar
                size={22}
                userId={currentClimb.sentByUserId}
                uri={currentClimb.sentByAvatarUrl}
                name={litBy}
                status="connected"
                accessibilityLabel={t('mobile.boardPresence.drivenByA11y', { name: litBy })}
              />
              <Text variant="caption1" color={brandColors.warning} numberOfLines={1} style={styles.driverName}>
                {litBy}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const WallFocalClimb = memo(WallFocalClimbComponent);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: spacing[4],
    gap: spacing[3],
  },
  artBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  darkWall: {
    alignItems: 'center',
    gap: spacing[2],
  },
  darkText: {
    textAlign: 'center',
  },
  meta: {
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  name: {
    flex: 1,
  },
  grade: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingTop: 2,
  },
  driverName: {
    flexShrink: 1,
  },
});
