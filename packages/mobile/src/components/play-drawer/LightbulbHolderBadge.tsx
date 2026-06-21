import { memo } from 'react';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useBoardDriver } from '../board-presence/use-board-driver';

/**
 * The "who holds the lamp" pip overlaid on the play-drawer lightbulb's top-right
 * corner, shown only when the on-wall banner isn't already carrying the driver
 * in the header (the banner owns the face when it's up — see PlayDrawer). Renders
 * nothing when the wall is free.
 *
 * Non-pressable (it sits in a `pointerEvents="none"` overlay on the lightbulb's
 * own tap target, and forcing `userId={null}` keeps it non-interactive) and it
 * never shows the Bluetooth glyph — the lit lightbulb already signals the
 * connection, so the pip only adds identity plus an idle "?" when the wall has
 * gone quiet.
 */
function LightbulbHolderBadgeComponent({ size = 18 }: { size?: number }) {
  const driver = useBoardDriver();
  // The pip means "who's connected/holding the wall right now", so it only shows
  // for an active holder — not for a climb left lit by someone who's since
  // dropped (that identity still rides the on-wall banner via useBoardDriver).
  if (!driver?.isHeld) return null;

  return (
    <BoardDriverAvatar
      size={size}
      userId={null}
      uri={driver.avatarUrl}
      name={driver.displayName}
      status={driver.isIdle ? 'idle' : 'none'}
    />
  );
}

export const LightbulbHolderBadge = memo(LightbulbHolderBadgeComponent);
