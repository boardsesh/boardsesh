import { useTranslation } from 'react-i18next';
import { useBoardDriver, type BoardDriver } from '../board-presence/use-board-driver';
import { compactAgoParts } from '../../lib/format-relative-time';

export type WallDriver = {
  /** Raw board-presence driver, or null when the wall is genuinely free. */
  driver: BoardDriver | null;
  /** Trimmed display name; null for an anonymous or unknown driver. */
  name: string | null;
  /**
   * Compact "how long ago they lit it" ("now", "5m", "2h") once the driver has
   * dropped or gone quiet. Null while they're actively connected — the avatar's
   * Bluetooth glyph carries that case.
   */
  litAgo: string | null;
};

/**
 * Who lit the wall, plus the recency label the wall-state chrome speaks.
 *
 * Lifted out of the old `PlayDrawerOnWallBanner` so the two surfaces that now
 * need it — the header pill's a11y label and the callout's driver row — read one
 * derivation instead of rolling the `compactAgoParts` → `litAgo*` ladder twice.
 */
export function useWallDriver(): WallDriver {
  const { t } = useTranslation('session');
  const driver = useBoardDriver();
  const name = driver?.displayName?.trim() || null;

  // Actively connected (a holder, recently active) → no time label; the avatar
  // keeps its Bluetooth glyph. Once they've dropped or gone quiet (and we know
  // when they last lit it) → a compact "how long ago" instead.
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

  return { driver, name, litAgo };
}
