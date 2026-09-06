import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { GroupedNotification, GroupedNotificationActor } from '@boardsesh/shared-schema';
import { Avatar } from '../Avatar';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { useTheme } from '../../providers/theme-provider';
import { notificationClimbRender, type NotificationClimbRender } from './notification-climb-render';

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

type NotificationClimbThumbnailProps = {
  render: NotificationClimbRender;
  /** The row's first actor — the setter, commenter or liker — or undefined when they're gone. */
  actor: GroupedNotificationActor | undefined;
};

/**
 * Hook form for the row. The pure function is what the list's `getItemType`
 * calls — it must run outside a component, and both must agree or FlashList
 * recycles a thumbnail cell into an avatar row.
 */
export function useNotificationClimbRender(notification: GroupedNotification): NotificationClimbRender | null {
  const { climbFrames, boardType, climbLayoutId, climbCompatibleSizeIds } = notification;

  return useMemo(
    () => notificationClimbRender(notification),
    // Deliberately the four fields the resolution reads, NOT `notification`.
    // React Query mints a new group object whenever any field changes, so
    // listing the object would re-resolve the board every time an unrelated
    // one moves — `isRead` flipping on mark-read, or `commentBody` arriving.
    // Adding `notification` here to satisfy the rule silently undoes that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [climbFrames, boardType, climbLayoutId, climbCompatibleSizeIds],
  );
}

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
