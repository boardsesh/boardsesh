import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { GroupedNotification, GroupedNotificationActor } from '@boardsesh/shared-schema';
import { Avatar } from '../Avatar';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { getBoardConfigForClimb, type PlaylistBoardConfig } from '../../lib/playlists/board-details-for-playlist';
import { useTheme } from '../../providers/theme-provider';

/**
 * Portrait cell for the row's board art. 44 wide is not arbitrary:
 * `ClimbListThumbnail` renders at `Math.max(400, width * 5)` and that number is
 * part of the render cache key, so any width up to 80 resolves to the same
 * `_w400_` PNG the climbs list and play view already wrote. Bumping past 80
 * would silently double the on-disk cache. See docs/react-native-performance.md §6.
 */
const THUMBNAIL_WIDTH = 44;
const THUMBNAIL_HEIGHT = 56;
/** Module-level so the prop identity is stable and `ClimbListThumbnail`'s memo can bail. */
const THUMBNAIL_SIZE = { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT };
/** The setter/actor, tucked over the art's trailing-bottom corner. */
const ACTOR_AVATAR_SIZE = 22;
const ACTOR_RING_WIDTH = 2;

/** Everything needed to draw a row's board art, or null when the row isn't about a climb. */
export type NotificationClimbRender = { frames: string; boardConfig: PlaylistBoardConfig };

/**
 * The board art a notification row can draw, if any — a new climb, a proposal,
 * or a comment or like on an ascent (the resolver walks the tick to its climb
 * for those).
 *
 * Returns null whenever the payload can't produce a render: a row that isn't
 * about a climb, or a backend deploy that predates `climbFrames`. The row then
 * keeps its avatar, which is deliberate — a blank tile in a list reads as
 * broken, a missing one reads as "this row just isn't about a climb".
 *
 * `getBoardConfigForClimb` rather than the playlist variant because
 * `compatibleSizeIds` picks the size: Woods numbers holds independently per
 * size, so the layout default renders a completely different climb
 * (docs/board-art-geometry.md). It is sync and cheap, so this costs a lookup
 * per row, not a query.
 */
export function useNotificationClimbRender(notification: GroupedNotification): NotificationClimbRender | null {
  const { climbFrames, boardType, climbLayoutId, climbCompatibleSizeIds } = notification;

  return useMemo(() => {
    // Layout is required, not optional. `getBoardConfigForClimb` tolerates a
    // missing one and falls back to the layout default — which on a board whose
    // sizes number holds independently draws a DIFFERENT climb rather than
    // failing. The resolver sets frames and layout together, so this can only
    // fire on a malformed payload; better a plain avatar than the wrong holds.
    if (!climbFrames || !boardType || climbLayoutId == null) return null;
    const boardConfig = getBoardConfigForClimb(boardType, climbLayoutId, climbCompatibleSizeIds);
    return boardConfig ? { frames: climbFrames, boardConfig } : null;
  }, [climbFrames, boardType, climbLayoutId, climbCompatibleSizeIds]);
}

type NotificationClimbThumbnailProps = {
  render: NotificationClimbRender;
  /** The row's first actor — the setter, commenter or liker — or undefined when they're gone. */
  actor: GroupedNotificationActor | undefined;
};

/**
 * The board art for one notification row, with the actor's avatar riding the
 * corner so the row still reads "who" first without spending the whole leading
 * slot on a face.
 */
export const NotificationClimbThumbnail = memo(function NotificationClimbThumbnail({
  render,
  actor,
}: NotificationClimbThumbnailProps) {
  const { systemColors } = useTheme();
  const { boardConfig } = render;

  return (
    <View style={styles.slot}>
      <ClimbListThumbnail
        frames={render.frames}
        boardName={boardConfig.boardName}
        layoutId={boardConfig.layoutId}
        sizeId={boardConfig.sizeId}
        setIds={boardConfig.setIds.join(',')}
        size={THUMBNAIL_SIZE}
      />
      {actor ? (
        <View
          style={[styles.actor, { borderColor: systemColors.background, backgroundColor: systemColors.background }]}
        >
          <Avatar uri={actor.avatarUrl} name={actor.displayName} size={ACTOR_AVATAR_SIZE} />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // Positioning only — no radius and deliberately NO `overflow: 'hidden'`.
  // `ClimbListThumbnail` already rounds and clips its own container, and the
  // actor sits at a negative offset outside these bounds, so clipping here
  // would slice the avatar in half.
  slot: {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
  },
  actor: {
    position: 'absolute',
    right: -ACTOR_RING_WIDTH,
    bottom: -ACTOR_RING_WIDTH,
    borderWidth: ACTOR_RING_WIDTH,
    borderRadius: (ACTOR_AVATAR_SIZE + ACTOR_RING_WIDTH * 2) / 2,
  },
});
