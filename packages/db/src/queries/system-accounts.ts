import { SYSTEM_USER_ID } from './boards/serial-dedupe';

/** The reserved account the recommendations job owns its generated cohort playlists under. */
export const RECOMMENDATIONS_USER_ID = 'system-recommendations';

/** The reserved account the hold-classifier job writes its shadow hold classifications under. */
export const HOLD_CLASSIFIER_USER_ID = 'system-hold-classifier';

/**
 * Every account nobody signs in to: the system catalogue account
 * (`SYSTEM_USER_ID`, which holds unclaimed synced gyms, Aurora gym walls and
 * the walls a deleted account hands over) and the job accounts above. They can
 * own items people comment on, but nobody reads their inbox, so nothing should
 * notify them.
 */
export const NON_HUMAN_USER_IDS: ReadonlySet<string> = new Set([
  SYSTEM_USER_ID,
  RECOMMENDATIONS_USER_ID,
  HOLD_CLASSIFIER_USER_ID,
]);
