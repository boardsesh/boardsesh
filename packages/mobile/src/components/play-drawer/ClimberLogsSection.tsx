// The play drawer's "Climber logs" card: how the climb went for the people the
// viewer follows. A header line with the server's counts, the grades they gave,
// up to four rows, then "See all logs" into the virtualised sheet.
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
import { GradePill } from '../ascent-marks';
import { ClimberLogRow } from './ClimberLogRow';
import {
  INLINE_CLIMBER_LOG_CAP,
  groupClimberLogs,
  rankClimberLogGroups,
  takeInlineGroups,
  tallyGivenGrades,
} from './climber-logs';
import { useFollowingClimbLogs } from '../../lib/graphql/hooks/use-following-climb-logs';
import { useOfflineQueryState, type OfflineQueryReason } from '../../hooks/use-offline-query-state';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

type ClimberLogsSectionProps = {
  climbUuid: string;
  boardName: string;
  /** The angle the board is set to. */
  angle: number;
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
const SKELETON_ROW_HEIGHT = 72;
const PILE_AVATAR_SIZE = 28;
const PILE_SIZE = 3;

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
const SKELETON_ROWS = Array.from({ length: INLINE_CLIMBER_LOG_CAP }, (_, index) => index);

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
  followState,
  onSeeAll,
  onPressClimber,
  onFindClimbers,
}: ClimberLogsSectionProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
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
  const groups = useMemo(() => rankClimberLogGroups(groupClimberLogs(items ?? [], angle)), [items, angle]);
  const tally = useMemo(() => tallyGivenGrades(groups), [groups]);

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

  // At most INLINE_CLIMBER_LOG_CAP rows, never the whole result: the drawer
  // body is a plain ScrollView (docs/react-native-performance.md section 2).
  const inlineGroups = takeInlineGroups(groups);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.pile}>
          {inlineGroups.slice(0, PILE_SIZE).map((group, index) => (
            <View key={group.userId} style={index > 0 ? styles.pileOverlap : undefined}>
              <Avatar uri={group.avatarUrl} name={group.displayName} size={PILE_AVATAR_SIZE} />
            </View>
          ))}
        </View>
        <View style={styles.headerText}>
          <Text variant="subheadline" style={styles.headline}>
            {t('mobile.climberLogs.headerLine', {
              headline: t('mobile.climberLogs.headline', { count: summary.climberCount }),
              sent: t('mobile.climberLogs.sentCount', { count: summary.senderCount }),
            })}
          </Text>
          {/* The tally is counted from the rows, so it is only shown when the
              rows are every log there is. */}
          {tally.length > 0 && !hasMore ? (
            <View style={styles.tally}>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('mobile.climberLogs.gradeTally')}
              </Text>
              {tally.map(({ difficultyId, count }) => (
                <View key={difficultyId} testID="climber-logs-tally-grade" style={styles.tallyItem}>
                  <GradePill difficultyId={difficultyId} />
                  <Text variant="footnote" color={systemColors.secondaryLabel}>
                    {t('mobile.climberLogs.gradeTallyItem', { count })}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>

      <View>
        {inlineGroups.map((group) => (
          <ClimberLogRow
            key={group.userId}
            group={group}
            boardAngle={angle}
            hideEarlier={hasMore}
            onPressClimber={onPressClimber}
          />
        ))}
      </View>

      <PressableSurface onPress={onSeeAll} feedback="opacity" accessibilityRole="button" style={styles.seeAll}>
        <Text variant="subheadline" style={styles.seeAllLabel}>
          {t('mobile.climberLogs.seeAll')}
        </Text>
        <Icon name="chevron.right" size={16} color={systemColors.secondaryLabel} />
      </PressableSurface>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[2],
  },
  empty: {
    gap: spacing[2],
  },
  cta: {
    alignItems: 'flex-start',
    marginTop: spacing[1],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  pile: {
    flexDirection: 'row',
  },
  pileOverlap: {
    marginLeft: -spacing[2],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
  headline: {
    fontWeight: '600',
  },
  tally: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
  },
  tallyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  seeAll: {
    minHeight: MIN_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  seeAllLabel: {
    fontWeight: '600',
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
    width: 36,
    height: 36,
    borderRadius: 18,
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
