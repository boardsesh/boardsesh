import type { TFunction } from 'i18next';
import type { LedgerAngleSection } from '@boardsesh/profile-stats';

/** How one angle went, in a few words: "Flashed", "Sent in session 3" or "No send yet". */
export function formatAngleResult(t: TFunction<'session'>, section: LedgerAngleSection<unknown>): string {
  if (!section.firstSend) return t('mobile.logbook.angleNoSend');
  if (section.firstSend.flash) return t('mobile.logbook.angleFlashed');
  return t('mobile.logbook.angleSentInSession', { session: section.firstSend.sessionNumber });
}
