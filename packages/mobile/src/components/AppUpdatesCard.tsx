import { useCallback, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AppMenu } from './AppMenu';
import { Button } from './Button';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { SwitchRow } from './SwitchRow';
import { Text } from './Text';
import { buildEarlyUpdatesSection } from './early-updates-section';
import { appReleaseLabel, screenshotReleaseScenario, translateAppReleaseLabel } from './AppUpdatesCard.logic';
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
import { useTheme } from '../providers/theme-provider';
import { borderRadius, spacing } from '../theme/tokens';

export function AppUpdatesCard({
  buildDetails,
  checkForUpdates,
}: {
  buildDetails: ReactNode;
  checkForUpdates: (disabled: boolean, onBusyChange: (busy: boolean) => void) => ReactNode;
}) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { releaseContext, isPending } = useMobileReleaseStatus();
  const [runningContext] = useState(readMobileReleaseContext);
  const earlyUpdates = useEarlyUpdatesRow();
  const member = useEarlyUpdatesMember();
  const qaMenu = useQaMenu();
  const branchesQuery = useQaBranches();
  const branchList = branchesQuery.data?.kind === 'listed' ? branchesQuery.data.list : null;
  const earlyUpdatesMember = member && branchList !== null && branchList.earlyUpdates !== null;
  const screenshotScenario = screenshotReleaseScenario();
  const fixture = screenshotScenario !== null;
  const context = fixture
    ? { ...runningContext, channel: 'production', branch: null, automaticCanary: screenshotScenario === 'canary' }
    : (releaseContext ?? { ...runningContext, automaticCanary: null });
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
      if (!available || fixture || inFlight.current) return;
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
          showToast(error instanceof Error && error.message ? error.message : t('qa.pick.unreachableTitle'), 'error');
        });
    },
    [available, fixture, earlyUpdatesMember, showToast, t],
  );

  const earlySection = buildEarlyUpdatesSection(t, {
    state: fixture ? 'off' : earlyUpdates.state,
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
  const showEarlyUpdates = earlyUpdates.show || fixture;
  const actions = [
    {
      label: t(earlyUpdatesMember ? 'qa.pick.earlyUpdatesTitle' : 'qa.pick.productionTitle'),
      disabled: busy || fixture,
      selected:
        (earlyUpdatesMember ? context.branch === 'pr-beta' : otaBranchKind(context.branch ?? null) === 'default') &&
        context.channel === 'production',
    },
    ...(branchList?.staging || fixture
      ? [
          {
            label: t('qa.pick.stagingTitle'),
            disabled: busy || fixture,
            selected: context.branch === 'pr-staging' || context.channel === 'staging',
          },
        ]
      : []),
  ];

  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      <Text variant="headline">{t('mobile.changelog.updates.title')}</Text>
      <View style={styles.releaseLine}>
        <Icon
          name={context.automaticCanary === true ? 'info' : 'success'}
          size={18}
          color={context.automaticCanary === true ? brandColors.warning : brandColors.primary}
        />
        <Text variant="body" style={styles.releaseLabel}>
          {translateAppReleaseLabel(releaseLabel, t)}
        </Text>
      </View>
      {context.automaticCanary === true ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('mobile.changelog.updates.canaryBody')}
        </Text>
      ) : !isPending &&
        context.automaticCanary === null &&
        context.channel === 'production' &&
        otaBranchKind(context.branch ?? null) === 'default' ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('mobile.changelog.updates.statusUnknown')}
        </Text>
      ) : null}
      {buildDetails}
      <View style={styles.controls}>
        {fixture ? (
          <Button
            title={t('mobile.changelog.checkForUpdates')}
            variant="tonal"
            size="small"
            icon="refresh"
            disabled
            onPress={() => undefined}
          />
        ) : (
          checkForUpdates(busy, handleBusyChange)
        )}
        {available || fixture ? (
          <AppMenu
            label={t('mobile.changelog.updates.changeRelease')}
            actions={actions}
            onSelectIndex={handleChannelPick}
          />
        ) : null}
      </View>
      {showEarlyUpdates && earlyRow ? (
        <View style={[styles.section, { borderTopColor: systemColors.separator }]}>
          {earlyRow.kind === 'toggle' ? (
            <SwitchRow
              label={earlyRow.label}
              description={earlyRow.subtitle}
              wrapDescription
              value={earlyRow.value}
              disabled={busy || fixture}
              onValueChange={(next) => {
                if (!inFlight.current && !fixture) earlyRow.onValueChange(next);
              }}
            />
          ) : earlyRow.kind === 'info' ? (
            <>
              <Text variant="subheadline">{earlyRow.label}</Text>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {earlyRow.body}
              </Text>
            </>
          ) : null}
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {earlySection.footer}
          </Text>
        </View>
      ) : null}
      {qaMenu.show || fixture ? (
        <View style={[styles.section, { borderTopColor: systemColors.separator }]}>
          <PressableSurface
            feedback="opacity"
            onPress={() => router.push('/qa/previews')}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.changelog.updates.testPreview')}
            style={styles.navigationRow}
          >
            <Text variant="body" style={styles.releaseLabel}>
              {t('mobile.changelog.updates.testPreview')}
            </Text>
            <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
          </PressableSurface>
          {qaMenu.prNumber !== null ? (
            <PressableSurface
              feedback="opacity"
              onPress={() => router.push('/qa/brief')}
              disabled={busy || fixture}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.changelog.updates.finishTesting', { prNumber: qaMenu.prNumber })}
              style={styles.navigationRow}
            >
              <Text variant="body" style={styles.releaseLabel}>
                {t('mobile.changelog.updates.finishTesting', { prNumber: qaMenu.prNumber })}
              </Text>
              <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
            </PressableSurface>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing[4], borderRadius: borderRadius.lg, gap: spacing[3] },
  releaseLine: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  releaseLabel: { flex: 1 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[3] },
  section: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing[3], gap: spacing[2] },
  navigationRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing[2] },
});
