import { SYSTEM_USER_ID } from './boards/serial-dedupe';
import { HOLD_CLASSIFIER_USER_ID, RECOMMENDATIONS_USER_ID } from './system-account-constants';

export { HOLD_CLASSIFIER_USER_ID, RECOMMENDATIONS_USER_ID } from './system-account-constants';

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
