import { memo } from 'react';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useBoardDriver } from '../board-presence/use-board-driver';
import { compactAgoParts } from '../../lib/format-relative-time';

/** Avatar diameter for the on-wall driver in the drawer header's leading slot. */
const DRIVER_AVATAR_SIZE = 32;

/**
 * Shown in the play drawer when the displayed climb is the live wall climb behind
 * the accessory bar — a peer (or another climber on this board) is driving the
 * wall over BLE and this climb is physically lit right now.
 *
 * Ambient status, not a promotable preview: the driver's avatar with one recency
 * cue in its top-right corner. While they're actively connected the corner wears
 * the amber Bluetooth glyph; once they've dropped or gone quiet, that same corner
 * swaps to a compact "how long ago they lit it" label ("5m", "2h"). The avatar
 * opens the driver's profile on tap (degrading to a non-interactive "?" for an
 * anonymous holder), and the name rides the accessibility label so screen readers
 * keep parity.
 *
 * Renders inline in the DrawerHeader's leading slot — to the left of the climb
 * name, opposite the grade. The banner owns the driver's face while it's up; the
 * lightbulb pip is suppressed (see PlayDrawer / PlayDrawerActionBar) so the same
 * face never appears twice.
 */
export const PlayDrawerOnWallBanner = memo(function PlayDrawerOnWallBanner() {
  const { t } = useTranslation('session');
  const driver = useBoardDriver();
  const name = driver?.displayName?.trim() || null;
  const accessibilityLabel = name
    ? t('mobile.boardPresence.drivenByA11y', { name })
    : t('mobile.boardPresence.drivenByAnonA11y');

  // Actively connected (a holder, recently active) → the corner keeps the BLE
  // glyph. Once they've dropped or gone quiet (and we know when they last lit
  // it) → the same corner shows a compact "how long ago" instead.
  const isStale = driver != null && (!driver.isHeld || driver.isIdle) && driver.lastSentAtMs != null;

  let litAgo: string | null = null;
  if (isStale && driver?.lastSentAtMs != null) {
    const { unit, count } = compactAgoParts(driver.lastSentAtMs, Date.now());
    litAgo =
      unit === 'now'
        ? t('mobile.boardPresence.litAgoNow')
        : unit === 'minutes'
          ? t('mobile.boardPresence.litAgoMinutes', { count })
          : unit === 'hours'
            ? t('mobile.boardPresence.litAgoHours', { count })
            : unit === 'days'
              ? t('mobile.boardPresence.litAgoDays', { count })
              : t('mobile.boardPresence.litAgoWeeks', { count });
  }

  return (
    <Animated.View entering={FadeIn.springify().damping(15).stiffness(200)}>
      <BoardDriverAvatar
        size={DRIVER_AVATAR_SIZE}
        userId={driver?.userId ?? null}
        uri={driver?.avatarUrl ?? null}
        name={name}
        status={litAgo ? 'none' : 'connected'}
        cornerLabel={litAgo}
        accessibilityLabel={accessibilityLabel}
      />
    </Animated.View>
  );
});
