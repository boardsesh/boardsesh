import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { boardConfigLabel, disambiguateBoardSubtitles, stripGymNamePrefix } from '@boardsesh/board-config';
import { Text } from '../Text';
import { AccessoryClimbThumbnail } from '../queue-control/AccessoryClimbThumbnail';
import { useBoardRecentClimb } from '../../lib/graphql/hooks/use-board-recent-climb';
import { useTheme } from '../../providers/theme-provider';
import { useGymBoards } from '../../lib/graphql/hooks/use-gym-boards';
import { spacing, borderRadius } from '../../theme/tokens';

/** Board art beside each row — small enough not to set the row's height floor. */
const THUMBNAIL_SIZE = 36;

/** Rows shown before the list collapses behind "Show all N boards". */
const COLLAPSED_ROW_COUNT = 2;

export type GymWallSwitcherProps = {
  /** The board the climber is on. Its gym is the roster we list. */
  activeBoard: UserBoard | null;
  /** Hop to this board. The sheet stays open — see `useSwitchBoard`. */
  onSelectBoard: (board: UserBoard) => void;
};

/**
 * The other boards at this gym, as one tap each.
 *
 * A gym with a Kilter beside a Tension is ordinary, and until now moving between
 * them meant leaving this sheet for the full board picker — a cross-gym carousel
 * that lists boards in other cities before the wall ten metres away.
 *
 * Renders nothing at all when there is nothing to switch to: one board at the
 * gym, or a home wall with no gym at all, where "walk over to the other one" is
 * simply false. Not an empty state, not a disabled row — the sheet looks exactly
 * as it did before.
 *
 * Owns its own query rather than taking rows as a prop, so the roster resolving
 * re-renders this subtree alone instead of rebuilding the panel's list header
 * (hero, stat tiles, hardest send) with it.
 *
 * Presentation-agnostic on purpose: it mounts no sheet and no overlay, because
 * an `@expo/ui` sheet cannot stack over the one this already lives in. Same
 * shape as InlinePlaylistPicker — see docs/mobile-sheets-vs-routes.md.
 */
function GymWallSwitcherComponent({ activeBoard, onSelectBoard }: GymWallSwitcherProps) {
  const { t } = useTranslation('session');
  const { brandColors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { data: gymBoards } = useGymBoards(activeBoard?.gymUuid ?? null);

  const siblings = useMemo(
    () => (gymBoards ?? []).filter((board) => board.uuid !== activeBoard?.uuid),
    [gymBoards, activeBoard?.uuid],
  );

  // One pass over the whole sibling set, never per row: the helper decides what
  // to append by looking at which boards collide with which, so calling it per
  // row would give each one a different answer (and #5272 is precisely the case
  // where every row collides).
  const subtitles = useMemo(() => disambiguateBoardSubtitles(siblings, { scope: 'within-gym' }), [siblings]);

  const handleExpand = useCallback(() => setExpanded(true), []);

  if (siblings.length === 0) return null;

  const visibleSiblings = expanded ? siblings : siblings.slice(0, COLLAPSED_ROW_COUNT);
  const hiddenCount = siblings.length - visibleSiblings.length;
  const gymName = activeBoard?.gymName;

  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={
        gymName
          ? t('mobile.boardPresence.gymWalls.header', { gym: gymName })
          : t('mobile.boardPresence.gymWalls.headerNoGym')
      }
      style={styles.section}
    >
      {visibleSiblings.map((board, index) => (
        <GymWallRow
          key={board.uuid}
          board={board}
          subtitle={subtitles[index]}
          sharesClimbsWithActive={sharesClimbs(board, activeBoard)}
          onSelectBoard={onSelectBoard}
        />
      ))}

      {hiddenCount > 0 ? (
        <Pressable onPress={handleExpand} accessibilityRole="button" style={styles.showAll}>
          <Text variant="subheadline" color={brandColors.primary}>
            {t('mobile.boardPresence.gymWalls.showAll', { count: siblings.length })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Whether hopping to this board changes which climbs are available, or only
 * which physical wall you stand at. Two walls set up identically hold the same
 * problems at the same grades, and saying so is the useful half of the "show
 * them as one entry" request on #5272 — without hiding that they have separate
 * feeds, which is what a merged row could never show.
 */
function sharesClimbs(board: UserBoard, activeBoard: UserBoard | null): boolean {
  if (!activeBoard) return false;
  return (
    board.boardType === activeBoard.boardType &&
    board.layoutId === activeBoard.layoutId &&
    board.sizeId === activeBoard.sizeId &&
    board.setIds === activeBoard.setIds
  );
}

type GymWallRowProps = {
  board: UserBoard;
  subtitle: string;
  sharesClimbsWithActive: boolean;
  onSelectBoard: (board: UserBoard) => void;
};

/**
 * One board. The whole row is the tap target and there is no chevron: a chevron
 * promises a drill-in, and this row acts.
 */
const GymWallRow = memo(function GymWallRow({
  board,
  subtitle,
  sharesClimbsWithActive,
  onSelectBoard,
}: GymWallRowProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const handlePress = useCallback(() => onSelectBoard(board), [board, onSelectBoard]);

  // Board art for THIS board, lit with whatever was last put up on it. A board
  // with history reads at a glance — you recognise the wall you were on and what
  // is on it now — where the generic glyph this replaces was the same picture on
  // every row. A board nobody has lit yet still renders its own art, just bare.
  const recentClimb = useBoardRecentClimb(board.boardId);
  const thumbnailBoardConfig = useMemo(
    () => ({
      boardName: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
    }),
    [board.boardType, board.layoutId, board.sizeId, board.setIds, board.angle],
  );
  const thumbnailClimb = useMemo(
    () => ({
      boardType: board.boardType,
      layoutId: board.layoutId,
      angle: recentClimb?.angle ?? board.angle,
      frames: recentClimb?.frames ?? '',
      compatibleSizeIds: null,
    }),
    [board.boardType, board.layoutId, board.angle, recentClimb?.angle, recentClimb?.frames],
  );

  // The gym already names itself in the section heading, and the wall crawl
  // prefixes every imported board with it — repeating it here spends the row's
  // whole width before reaching the part that tells two boards apart.
  const title = stripGymNamePrefix(board.name, board.gymName) || board.name;

  // The subtitle already leads with what the board is, and the disambiguator
  // appends a facet — which may itself be the angle — only when two boards
  // collide. So this composes the remaining facts onto it rather than building a
  // second description: printing the config again is how a row ended up reading
  // "Original 12×12 with kickboard · Original 12×12 with kickboard · 45°".
  //
  // The board's OWN angle, never the one the climber is on: carrying the current
  // angle across is how someone ends up "on" a fixed board at 40 degrees.
  const angleLabel =
    board.isAngleAdjustable === false
      ? t('mobile.boardPresence.gymWalls.angleFixed', { angle: board.angle })
      : t('mobile.boardPresence.gymWalls.angle', { angle: board.angle });
  const subtitleAlreadyNamesAngle = subtitle.endsWith(`${board.angle}°`);
  const detail = [
    subtitle || (boardConfigLabel(board) ?? board.boardType),
    subtitleAlreadyNamesAngle ? null : angleLabel,
    board.hasLeds === false ? t('mobile.boardPresence.gymWalls.noLights') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.boardPresence.gymWalls.rowAria', { board: title })}
      style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
    >
      <AccessoryClimbThumbnail climb={thumbnailClimb} boardConfig={thumbnailBoardConfig} size={THUMBNAIL_SIZE} />
      <View style={styles.rowText}>
        <Text variant="subheadline" color={systemColors.label} numberOfLines={1}>
          {title}
        </Text>
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
          {detail}
        </Text>
        {sharesClimbsWithActive ? (
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1}>
            {t('mobile.boardPresence.gymWalls.sameClimbs')}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: borderRadius.md,
  },
  rowText: {
    flex: 1,
    gap: spacing[1] / 2,
  },
  showAll: {
    paddingVertical: spacing[2],
  },
});

export const GymWallSwitcher = memo(GymWallSwitcherComponent);
