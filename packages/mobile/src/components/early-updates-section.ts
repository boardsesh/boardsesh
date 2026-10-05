import type { TFunction } from 'i18next';
import { hapticSelection } from '../lib/haptics';
import { setEarlyUpdatesChoice, type EarlyUpdatesSyncEnvironment } from '../lib/qa/early-updates';
import type { EarlyUpdatesRowState } from '../lib/qa/use-early-updates';
import type { MoreSection } from './MoreForm.types';

type EarlyUpdatesSectionInput = {
  state: EarlyUpdatesRowState;
  environment: EarlyUpdatesSyncEnvironment;
  /** The change is stored but could not be applied yet; the screen says so. */
  onDeferred: (enabled: boolean) => void;
};

/**
 * More's "App updates" section: the "Get updates early" switch.
 *
 * Extracted from `app/settings/index.tsx` like `buildOfflineModeRow`: the More
 * screen hands its model to a platform-split native form that cannot mount
 * under Vitest, and what is worth a test here is which line each state shows
 * and that a flip goes through `setEarlyUpdatesChoice`.
 *
 * The switch shows the CHOICE and flips at once. The line under it says where
 * the phone actually is, which lags the choice whenever the switch-over needs a
 * network it does not have: "waiting" after switching on, "switching back"
 * after switching off. The row never claims a track the phone is not on.
 *
 * While a PR preview or staging is pinned there is no switch, only a line
 * saying to leave the preview first. Both use the same request header, so a
 * flip would silently drop the preview a tester is in the middle of.
 */
export function buildEarlyUpdatesSection(
  t: TFunction<'common'>,
  { state, environment, onDeferred }: EarlyUpdatesSectionInput,
): MoreSection {
  const section = {
    key: 'earlyUpdates',
    title: t('mobile.settings.earlyUpdates.sectionTitle'),
    footer: t('mobile.settings.earlyUpdates.footer'),
  };

  if (state === 'testing') {
    return {
      ...section,
      rows: [
        {
          kind: 'info',
          key: 'earlyUpdates',
          label: t('mobile.settings.earlyUpdates.title'),
          body: t('mobile.settings.earlyUpdates.testingBody'),
        },
      ],
    };
  }

  const subtitles = {
    off: t('mobile.settings.earlyUpdates.offSubtitle'),
    on: t('mobile.settings.earlyUpdates.onSubtitle'),
    waiting: t('mobile.settings.earlyUpdates.waitingSubtitle'),
    leaving: t('mobile.settings.earlyUpdates.leavingSubtitle'),
  };

  return {
    ...section,
    rows: [
      {
        kind: 'toggle',
        key: 'earlyUpdates',
        label: t('mobile.settings.earlyUpdates.title'),
        subtitle: subtitles[state],
        value: state === 'on' || state === 'waiting',
        onValueChange: (next) => {
          hapticSelection();
          void setEarlyUpdatesChoice(next, environment).then((outcome) => {
            if (outcome === 'deferred' || outcome === 'blocked') onDeferred(next);
          });
        },
      },
    ],
  };
}
