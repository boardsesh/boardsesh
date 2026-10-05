import type { TFunction } from 'i18next';
import { hapticSelection } from '../lib/haptics';
import { reportHandledError } from '../lib/error-reporting';
import { formatRelativeTime } from '../lib/format-relative-time';
import { setEarlyUpdatesMembership } from '../lib/qa/early-updates';
import type { EarlyUpdatesAvailability } from '../lib/qa/use-early-updates';
import type { MoreSection } from './MoreForm.types';

type EarlyUpdatesSectionInput = {
  /** Opted in, with the feature on. */
  member: boolean;
  availability: EarlyUpdatesAvailability;
  /** When the early-updates branch last published for this binary, if it has. */
  lastUpdateAt: string | null;
  /** Told when the switch could not be applied, so the screen can say so. */
  onToggleFailed: () => void;
};

/**
 * More's "App updates" section: the "Get updates early" switch.
 *
 * Extracted from `app/settings/index.tsx` like `buildOfflineModeRow`: the More
 * screen hands its model to a platform-split native form that cannot mount
 * under Vitest, and what is worth a test here is the row's three states and
 * that a flip goes through `setEarlyUpdatesMembership` (pin first, then the
 * stored choice, then the event).
 *
 * The line under the label carries the state. A member whose binary the server
 * has no early update for reads "waiting", never plain "on": the switch being
 * on is their choice, and the line must not claim an update is coming from a
 * branch that is not serving them.
 *
 * The footer carries the terms, and they are deliberate. It says changes apply
 * on the next open because flipping this never reloads the app. It does not
 * offer leaving as the way out of a broken early update: expo-updates will not
 * load an older bundle, so leaving only takes effect once the regular track
 * passes the bundle already running.
 */
export function buildEarlyUpdatesSection(
  t: TFunction<'common'>,
  { member, availability, lastUpdateAt, onToggleFailed }: EarlyUpdatesSectionInput,
): MoreSection {
  return {
    key: 'earlyUpdates',
    title: t('mobile.settings.earlyUpdates.sectionTitle'),
    footer: t('mobile.settings.earlyUpdates.footer'),
    rows: [
      {
        kind: 'toggle',
        key: 'earlyUpdates',
        label: t('mobile.settings.earlyUpdates.title'),
        subtitle: earlyUpdatesSubtitle(t, member, availability, lastUpdateAt),
        value: member,
        onValueChange: (next) => {
          hapticSelection();
          try {
            setEarlyUpdatesMembership(next);
          } catch (error) {
            reportHandledError(error, { tags: { source: 'ota', op: 'early-updates-toggle' } });
            onToggleFailed();
          }
        },
      },
    ],
  };
}

function earlyUpdatesSubtitle(
  t: TFunction<'common'>,
  member: boolean,
  availability: EarlyUpdatesAvailability,
  lastUpdateAt: string | null,
): string {
  if (!member) return t('mobile.settings.earlyUpdates.offSubtitle');
  if (availability === 'waiting') return t('mobile.settings.earlyUpdates.waitingSubtitle');
  const when = availability === 'offered' ? formatRelativeTime(lastUpdateAt) : '';
  return when.length > 0
    ? t('mobile.settings.earlyUpdates.onSubtitleLatest', { when })
    : t('mobile.settings.earlyUpdates.onSubtitle');
}
