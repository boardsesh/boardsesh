import { AppUpdatesCardView } from './AppUpdatesCardView';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { buildEarlyUpdatesSection } from './early-updates-section';
import { appReleaseLabel } from './AppUpdatesCard.logic';
import { readMobileReleaseContext } from '../lib/release-context';
import { useMobileReleaseStatus } from '../lib/use-mobile-release-status';
import { qaSurfingAvailable, surfToStaging } from '../lib/qa/qa-surf';
import { otaBranchKind } from '../lib/qa/pr-branch';
import { returnToOwnTrack } from '../lib/qa/early-updates';
import { useEarlyUpdatesMember, useEarlyUpdatesRow } from '../lib/qa/use-early-updates';
import { useQaBranches } from '../lib/qa/use-qa-branches';
import { useQaMenu } from '../lib/qa/use-qa-menu';
import { reportHandledError } from '../lib/error-reporting';
import { useToast } from '../providers/toast-provider';

export function AppUpdatesCard({
  buildDetails,
  checkForUpdates,
}: {
  buildDetails: ReactNode;
  checkForUpdates: (disabled: boolean, onBusyChange: (busy: boolean) => void) => ReactNode;
}) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { releaseContext, isPending } = useMobileReleaseStatus();
  const [runningContext] = useState(readMobileReleaseContext);
  const earlyUpdates = useEarlyUpdatesRow();
  const member = useEarlyUpdatesMember();
  const qaMenu = useQaMenu();
  const branchesQuery = useQaBranches();
  const branchList = branchesQuery.data?.kind === 'listed' ? branchesQuery.data.list : null;
  const earlyUpdatesMember = member && branchList !== null && branchList.earlyUpdates !== null;
  const currentPrNumber = qaMenu.prNumber;
  const context = releaseContext ?? { ...runningContext, automaticCanary: null };
  const releaseLabel = appReleaseLabel(context);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const available = qaSurfingAvailable();
  const handleBusyChange = useCallback((nextBusy: boolean) => {
    inFlight.current = nextBusy;
    setBusy(nextBusy);
  }, []);

  const handleChannelPick = useCallback(
    (index: number) => {
      if (!available || inFlight.current) return;
      const channel = index === 0 ? 'production' : 'staging';
      inFlight.current = true;
      setBusy(true);
      void (channel === 'staging' ? surfToStaging() : returnToOwnTrack(earlyUpdatesMember))
        .then((outcome) => {
          if (outcome === 'reloading') return;
          inFlight.current = false;
          setBusy(false);
          showToast(
            t(
              outcome === 'early-updates-next-launch'
                ? 'qa.pick.earlyUpdatesNextLaunch'
                : channel === 'staging'
                  ? 'qa.pick.stagingNextLaunch'
                  : 'qa.pick.productionNextLaunch',
            ),
            'info',
          );
        })
        .catch((error: unknown) => {
          inFlight.current = false;
          setBusy(false);
          reportHandledError(error, { tags: { source: 'qa', op: `surf-to-${channel}` } });
          showToast(t(channel === 'production' ? 'qa.shared.leaveFailed' : 'qa.pick.unreachableTitle'), 'error');
        });
    },
    [available, earlyUpdatesMember, showToast, t],
  );

  const earlySection = buildEarlyUpdatesSection(t, {
    state: earlyUpdates.state,
    environment: earlyUpdates.environment,
    onDeferred: (enabled) =>
      showToast(
        t(enabled ? 'mobile.settings.earlyUpdates.joinDeferred' : 'mobile.settings.earlyUpdates.leaveDeferred'),
        'info',
      ),
    onBusyChange: handleBusyChange,
    onError: (error) => {
      reportHandledError(error, { tags: { source: 'qa', op: 'early-updates-choice' } });
      showToast(t('qa.pick.unreachableTitle'), 'error');
    },
  });
  const earlyRow = earlySection.rows[0];
  const showEarlyUpdates = earlyUpdates.show;
  const actions = [
    {
      label: t(earlyUpdatesMember ? 'qa.pick.earlyUpdatesTitle' : 'qa.pick.productionTitle'),
      disabled: busy,
      selected:
        (earlyUpdatesMember ? context.branch === 'pr-beta' : otaBranchKind(context.branch ?? null) === 'default') &&
        context.channel === 'production',
    },
    ...(branchList?.staging
      ? [
          {
            label: t('qa.pick.stagingTitle'),
            disabled: busy,
            selected: context.branch === 'pr-staging' || context.channel === 'staging',
          },
        ]
      : []),
  ];

  return (
    <AppUpdatesCardView
      buildDetails={buildDetails}
      releaseLabel={releaseLabel}
      context={context}
      isPending={isPending}
      busy={busy}
      updateControl={() => checkForUpdates(busy, handleBusyChange)}
      available={available}
      actions={actions}
      onChannelPick={handleChannelPick}
      showEarlyUpdates={showEarlyUpdates}
      earlyRow={earlyRow}
      earlyState={earlyUpdates.state}
      onEarlyUpdatesChange={(next) => {
        if (!inFlight.current && earlyRow?.kind === 'toggle') earlyRow.onValueChange(next);
      }}
      showQa={qaMenu.show}
      currentPrNumber={currentPrNumber}
      onOpenPreviews={() => router.push('/qa/previews')}
      onOpenQa={() => router.push(currentPrNumber !== null ? '/qa/brief' : '/qa/previews')}
    />
  );
}
