// The play drawer's "Climber logs" card: how the climb went for the people the
// viewer follows. One line with the server's counts (and who graded it
// differently), up to four rows for climbers with something to say, then one
// footer button: the climbers with nothing to add, as names, and "See all
// logs" into the virtualised sheet.
//
// People the viewer follows always come first, and a followed climber is never
// pushed off the card: one without a note still has their name in the footer.
//
// The rows come straight from `followingClimbAscents`, so what may be shown
// (spray-wall privacy above all) is decided by the server on every request.
// Nothing here is cached on the phone or read offline.
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { ClimberLogRow } from './ClimberLogRow';
import {
  describeBareNames,
  groupClimberLogs,
  planClimberLogsCard,
  rankClimberLogGroups,
  tallyDisagreeingGrades,
  type ClimberLogGroup,
} from './climber-logs';
import { getGradeLabel } from '../../lib/grade-label';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useFollowingClimbLogs } from '../../lib/graphql/hooks/use-following-climb-logs';
import { useOfflineQueryState, type OfflineQueryReason } from '../../hooks/use-offline-query-state';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

type ClimberLogsSectionProps = {
  climbUuid: string;
  boardName: string;
  /** The angle the board is set to. */
  angle: number;
  /** The climb's grade at that angle, or null when it is not one the app can read. */
  climbGradeId: number | null;
  /**
   * What the phone's own followed-authors snapshot says. `none` answers the
   * card without a request; `unknown` (the snapshot failed to load) asks the
   * server and never claims the viewer follows nobody.
   */
  followState: 'none' | 'some' | 'unknown';
  onSeeAll: () => void;
  onPressClimber: (userId: string) => void;
  onFindClimbers: () => void;
};

const MIN_TARGET = 44;
const SKELETON_ROW_HEIGHT = 64;
const SKELETON_ROW_COUNT = 2;
const FACE_SIZE = 24;
const FACE_CAP = 3;
const SEPARATOR = ' · ';

/** The viewer follows nobody. `children` is where a later fall-through list goes. */
export const ClimberLogsFollowNobody = memo(function ClimberLogsFollowNobody({
  onFindClimbers,
  children,
}: {
  onFindClimbers: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <View style={styles.empty}>
      <Text variant="headline">{t('mobile.climberLogs.emptyFollowNobodyTitle')}</Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {t('mobile.climberLogs.emptyFollowNobodyBody')}
      </Text>
      {children}
      <View style={styles.cta}>
        <Button title={t('mobile.climberLogs.findClimbers')} variant="tonal" size="small" onPress={onFindClimbers} />
      </View>
    </View>
  );
});

/** The viewer follows people, and none of them has logged this climb. */
export const ClimberLogsNobodyLogged = memo(function ClimberLogsNobodyLogged({
  onFindClimbers,
  children,
}: {
  onFindClimbers: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <View style={styles.empty}>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {t('mobile.climberLogs.emptyNobodyLogged')}
      </Text>
      {children}
      <View style={styles.cta}>
        <Button title={t('mobile.climberLogs.findClimbers')} variant="tonal" size="small" onPress={onFindClimbers} />
      </View>
    </View>
  );
});

/**
 * Why there are no rows, sized for a card. `OfflineState` is a full-screen
 * placard; inside the drawer it would push every card below it off the screen.
 */
const ClimberLogsBlocked = memo(function ClimberLogsBlocked({
  reason,
  onRetry,
}: {
  reason: OfflineQueryReason;
  onRetry: () => void;
}) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();

  // Literal keys per reason: the i18n linter rejects a computed key.
  const title = (() => {
    switch (reason) {
      case 'backend_unreachable':
        return tCommon('mobile.offlineState.serverTitle');
      case 'offline_mode':
        return tCommon('mobile.offlineState.offlineModeTitle');
      case 'error':
        return tCommon('mobile.offlineState.errorTitle');
      default:
        return tCommon('mobile.offlineState.title');
    }
  })();

  return (
    <View style={styles.empty}>
      <Text variant="headline">{title}</Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {/* A request that reached a working server and failed is not a signal problem. */}
        {reason === 'error' ? tCommon('mobile.offlineState.errorBody') : t('mobile.climberLogs.offlineBody')}
      </Text>
      <View style={styles.cta}>
        <Button title={tCommon('mobile.offlineState.retry')} variant="tonal" size="small" onPress={onRetry} />
      </View>
    </View>
  );
});

// Fixed heights, so the cards below settle once when the rows land.
const SKELETON_ROWS = Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => index);

/** "ana_p, jo_dyno +4", or "ana_p, jo_dyno and more" when the number is not known. */
function useBareNames() {
  const { t } = useTranslation('session');
  return useCallback(
    (groups: readonly ClimberLogGroup[], complete: boolean): string => {
      const { names, extra, andMore } = describeBareNames(groups, complete);
      const listed = names.map((name) => name ?? t('mobile.climberLogs.unknownClimber')).join(', ');
      if (extra > 0) return t('mobile.climberLogs.namesPlus', { names: listed, count: extra });
      return andMore ? t('mobile.climberLogs.namesAndMore', { names: listed }) : listed;
    },
    [t],
  );
}

type BareLinesProps = {
  bareSent: readonly ClimberLogGroup[];
  bareTried: readonly ClimberLogGroup[];
  /** The groups are every climber there is, so "+N" is a true number. */
  complete: boolean;
  /** No climber has a row above, so the line reads "Sent it" instead of "Also sent". */
  standsAlone: boolean;
};

/**
 * The climbers with nothing to add, as up to three faces and two lines of
 * names. Not a tap target of its own: it lives inside the footer button.
 */
const BareLines = memo(function BareLines({ bareSent, bareTried, complete, standsAlone }: BareLinesProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const bareNames = useBareNames();
  const faces = [...bareSent, ...bareTried].slice(0, FACE_CAP);

  return (
    <View style={styles.bare} testID="climber-logs-bare">
      <View style={styles.pile}>
        {faces.map((group, index) => (
          <View key={group.userId} style={index > 0 ? styles.pileOverlap : undefined}>
            <Avatar uri={group.avatarUrl} name={group.displayName} size={FACE_SIZE} />
          </View>
        ))}
      </View>
      <View style={styles.bareText}>
        {bareSent.length > 0 ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            <Text variant="subheadline" style={styles.strong}>
              {standsAlone ? t('mobile.climberLogs.sentIt') : t('mobile.climberLogs.alsoSent')}
            </Text>{' '}
            {bareNames(bareSent, complete)}
          </Text>
        ) : null}
        {bareTried.length > 0 ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            <Text variant="subheadline" style={styles.strong}>
              {t('mobile.climberLogs.triedNoSend')}
            </Text>{' '}
            {bareNames(bareTried, complete)}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

type ClimberLogsFooterProps = BareLinesProps & { ruled: boolean; onSeeAll: () => void };

/**
 * The card's last block: the bare climbers and "See all logs" as ONE button
 * with one chevron. Both lead to the same sheet, so two targets would be two
 * ways to say one thing.
 */
const ClimberLogsFooter = memo(function ClimberLogsFooter({
  bareSent,
  bareTried,
  complete,
  standsAlone,
  ruled,
  onSeeAll,
}: ClimberLogsFooterProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const bareNames = useBareNames();
  const hasBare = bareSent.length + bareTried.length > 0;
  const spoken = [
    bareSent.length > 0
      ? `${standsAlone ? t('mobile.climberLogs.sentIt') : t('mobile.climberLogs.alsoSent')} ${bareNames(bareSent, complete)}`
      : null,
    bareTried.length > 0 ? `${t('mobile.climberLogs.triedNoSend')} ${bareNames(bareTried, complete)}` : null,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <PressableSurface
      onPress={onSeeAll}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={hasBare ? t('mobile.climberLogs.footerA11y', { summary: spoken }) : undefined}
      style={[styles.footer, ruled ? [styles.footerRule, { borderTopColor: systemColors.separator }] : undefined]}
    >
      {hasBare ? (
        <BareLines bareSent={bareSent} bareTried={bareTried} complete={complete} standsAlone={standsAlone} />
      ) : null}
      <View style={styles.seeAll}>
        <Text variant="subheadline" style={styles.strong}>
          {t('mobile.climberLogs.seeAll')}
        </Text>
        <Icon name="chevron.right" size={16} color={systemColors.secondaryLabel} />
      </View>
    </PressableSurface>
  );
});

function ClimberLogsSkeleton() {
  const { systemColors } = useTheme();
  const block = { backgroundColor: systemColors.fill };
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="climber-logs-skeleton">
      <View style={[styles.skeletonHeader, block]} />
      {SKELETON_ROWS.map((index) => (
        <View key={index} testID="climber-logs-skeleton-row" style={styles.skeletonRow}>
          <View style={[styles.skeletonAvatar, block]} />
          <View style={styles.skeletonLines}>
            <View style={[styles.skeletonLineShort, block]} />
            <View style={[styles.skeletonLineLong, block]} />
          </View>
        </View>
      ))}
      <View style={styles.seeAll} />
    </View>
  );
}

export const ClimberLogsSection = memo(function ClimberLogsSection({
  climbUuid,
  boardName,
  angle,
  climbGradeId,
  followState,
  onSeeAll,
  onPressClimber,
  onFindClimbers,
}: ClimberLogsSectionProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  // Same key as DeferredSections' read for the collapsed Logbook line, so React
  // Query serves both from one request.
  const query = useFollowingClimbLogs(boardName, climbUuid, { enabled: followState !== 'none' });
  const offline = useOfflineQueryState(query);
  const { data, refetch } = query;
  const isLoading = query.isLoading;
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const items = data?.items;
  const groups = useMemo(
    () => rankClimberLogGroups(groupClimberLogs(items ?? [], angle, climbGradeId)),
    [items, angle, climbGradeId],
  );
  // Rows for the climbers with something to say, capped; everyone else followed
  // keeps a name in the footer.
  const plan = useMemo(() => planClimberLogsCard(groups), [groups]);
  const tally = useMemo(() => tallyDisagreeingGrades(groups), [groups]);

  if (followState === 'none') return <ClimberLogsFollowNobody onFindClimbers={onFindClimbers} />;

  if (!data) {
    // Includes an older server rejecting the document: it lands here as an
    // error, with no rows. Never work around that by asking for fewer fields.
    if (offline.isBlocked && offline.reason) {
      return <ClimberLogsBlocked reason={offline.reason} onRetry={handleRetry} />;
    }
    if (isLoading) return <ClimberLogsSkeleton />;
    // Not asking yet (the viewer id is still being read): nothing honest to show.
    return null;
  }

  const { summary, hasMore } = data;
  if (summary.climberCount === 0) return <ClimberLogsNobodyLogged onFindClimbers={onFindClimbers} />;

  // The counts are the server's. The grades are counted from the rows, so they
  // only show when the rows are every log there is.
  const summaryLine = [
    t('mobile.climberLogs.headerLine', {
      headline: t('mobile.climberLogs.headline', { count: summary.climberCount }),
      sent: t('mobile.climberLogs.sentCount', { count: summary.senderCount }),
    }),
    ...(hasMore
      ? []
      : tally.map(({ difficultyId, count }) =>
          t('mobile.climberLogs.gradedItCount', {
            count,
            grade: formatGradeByDifficultyId(difficultyId) || getGradeLabel(difficultyId),
          }),
        )),
  ].join(SEPARATOR);

  return (
    <View>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {summaryLine}
      </Text>

      {/* At most INLINE_CLIMBER_LOG_CAP rows, never the whole result: the drawer
          body is a plain ScrollView (docs/react-native-performance.md section 2). */}
      {plan.rows.map((group, index) => (
        <View
          key={group.userId}
          style={index > 0 ? [styles.rowRule, { borderTopColor: systemColors.separator }] : undefined}
        >
          <ClimberLogRow group={group} boardAngle={angle} hideEarlier={hasMore} onPressClimber={onPressClimber} />
        </View>
      ))}

      <ClimberLogsFooter
        bareSent={plan.bareSent}
        bareTried={plan.bareTried}
        complete={!hasMore}
        standsAlone={plan.rows.length === 0}
        ruled={plan.rows.length > 0}
        onSeeAll={onSeeAll}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  empty: {
    gap: spacing[2],
  },
  cta: {
    alignItems: 'flex-start',
    marginTop: spacing[1],
  },
  rowRule: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  strong: {
    fontWeight: '600',
  },
  footer: {
    paddingTop: spacing[1],
  },
  footerRule: {
    marginTop: spacing[1],
    paddingTop: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bare: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingTop: spacing[1],
  },
  pile: {
    flexDirection: 'row',
  },
  pileOverlap: {
    marginLeft: -spacing[2],
  },
  bareText: {
    flex: 1,
    minWidth: 0,
  },
  seeAll: {
    minHeight: MIN_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  skeletonHeader: {
    width: '60%',
    height: 18,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  skeletonRow: {
    height: SKELETON_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  skeletonAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    opacity: 0.55,
  },
  skeletonLines: {
    flex: 1,
    gap: spacing[2],
  },
  skeletonLineShort: {
    width: '45%',
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  skeletonLineLong: {
    width: '80%',
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
});
