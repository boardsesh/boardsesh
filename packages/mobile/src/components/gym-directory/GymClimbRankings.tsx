import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  createGymClimbRankingFormat,
  formatGymReportingTime,
  GYM_CLIMB_RANKING_MODE_COPY,
  GYM_CLIMB_RANKING_MODES,
  GYM_CLIMB_RANKING_STATUS_COPY,
  gymClimbRankingRowKey,
} from '@boardsesh/graphql';
import { useGymClimbRankings, type GymClimbRankingRequest } from '@boardsesh/board-react';
import type { GymClimbRankingMode, GymClimbRankingRow, GymStatsInput } from '@boardsesh/shared-schema';
import {
  captureAuthCredentialGeneration,
  isAuthCredentialGenerationCurrent,
  subscribeAuthCredentialGenerationChanges,
} from '../../lib/auth-store';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getHttpClient } from '../../lib/graphql/client';
import { requestForGymViewer } from '../../lib/graphql/hooks/use-gym-reporting';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { AppMenu } from '../AppMenu';
import { Button } from '../Button';
import { Text } from '../Text';
import {
  createGymClimbPreviewAuthorization,
  readGymClimbPreview,
  type GymClimbPreviewAuthorization,
} from './gym-climb-ranking-preview';

type RankingState = ReturnType<typeof useGymClimbRankings>;
type EntryModel = ReturnType<ReturnType<typeof createGymClimbRankingFormat>>;

type RankingControls = {
  mode: GymClimbRankingMode;
  chooseMode: (mode: GymClimbRankingMode) => void;
  quietAvailable: boolean;
  ranking: RankingState;
  targetError: boolean;
};

export type GymClimbRankingListRow =
  | { kind: 'ranking-controls'; key: string; controls: RankingControls }
  | { kind: 'ranked-climb'; key: string; model: EntryModel; row: GymClimbRankingRow }
  | { kind: 'ranking-paging'; key: string; loadMore: () => void; paging: boolean };

type RankingListOptions = GymStatsInput & {
  viewerId: string;
  overviewGymUuid: string;
  active: boolean;
  mode: GymClimbRankingMode;
  chooseMode: (mode: GymClimbRankingMode) => void;
};

export function useGymClimbRankingRows({ chooseMode, ...options }: RankingListOptions) {
  const { i18n } = useTranslation('boards');
  const { formatGradeByDifficultyId } = useGradeFormat();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const credentialEpoch = useSyncExternalStore(
    subscribeAuthCredentialGenerationChanges,
    captureAuthCredentialGeneration,
    captureAuthCredentialGeneration,
  );
  const isCredentialCurrent = useCallback(() => isAuthCredentialGenerationCurrent(credentialEpoch), [credentialEpoch]);
  const { viewerId, active, gymUuid, boardUuid, period, mode } = options;
  const request = useMemo<GymClimbRankingRequest>(
    () => (document, variables, signal) =>
      requestForGymViewer(viewerId, () => getHttpClient().request({ document, variables, signal })),
    [viewerId],
  );
  const ranking = useGymClimbRankings({ ...options, credentialEpoch, isCredentialCurrent, request });
  const scopeKey = JSON.stringify([viewerId, credentialEpoch, gymUuid, boardUuid, period]);
  const targetScope = JSON.stringify([scopeKey, mode]);
  const [quietScope, setQuietScope] = useState<string | null>(null);
  const [failedScope, setFailedScope] = useState<string | null>(null);
  const preview = useRef<GymClimbPreviewAuthorization | null>(null);
  const quiet =
    ranking.state === 'READY' || ranking.state === 'PAGE_CHANGED' ? ranking.report?.quietAvailable : undefined;
  const quietAvailable = quiet === true || (quiet !== false && quietScope === scopeKey);
  useEffect(() => {
    if (ranking.state !== 'READY') return;
    setQuietScope(quiet ? scopeKey : null);
    if (!quiet && mode === 'QUIET_CLIMBS') chooseMode('MOST_SENT');
  }, [chooseMode, mode, quiet, ranking.state, scopeKey]);

  const { resolveTarget } = ranking;
  const openRow = useCallback(
    async (row: GymClimbRankingRow) => {
      setFailedScope(null);
      try {
        const selection = await resolveTarget(row, (target, signal) => readGymClimbPreview(viewerId, target, signal));
        if (!selection?.isCurrent()) return;
        preview.current?.retire();
        const authorization = createGymClimbPreviewAuthorization(selection.expiresAt, credentialEpoch);
        preview.current = authorization;
        openClimbInPlayDrawer(
          { kind: 'climb', climb: selection.result.climb, boardConfig: selection.result.config },
          { openPlayDrawer, router },
          {
            preview: true,
            rankedPreview: {
              authorization,
              referenceDifficulty: selection.result.referenceDifficulty,
              sprayArt: selection.result.sprayArt,
            },
          },
        );
      } catch {
        setFailedScope(targetScope);
      }
    },
    [credentialEpoch, openPlayDrawer, resolveTarget, router, targetScope, viewerId],
  );

  const modeForRows = ranking.report?.mode ?? mode;
  const timeZone = ranking.report?.timeZone ?? 'UTC';
  const rows = useMemo<GymClimbRankingListRow[]>(() => {
    const format = createGymClimbRankingFormat(i18n.language || 'en-US', timeZone, formatGradeByDifficultyId);
    return ranking.rows.map((row) => ({
      key: `ranking:${gymClimbRankingRowKey(row)}`,
      kind: 'ranked-climb',
      model: format(row, modeForRows),
      row,
    }));
  }, [formatGradeByDifficultyId, i18n.language, modeForRows, ranking.rows, timeZone]);
  const listRows: GymClimbRankingListRow[] = active
    ? [
        {
          key: 'ranking-controls',
          kind: 'ranking-controls',
          controls: {
            mode,
            chooseMode,
            quietAvailable,
            ranking,
            targetError: failedScope === targetScope,
          },
        },
        ...rows,
      ]
    : [];
  if (active && ranking.canLoadMore) {
    listRows.push({
      key: 'ranking-paging',
      kind: 'ranking-paging',
      loadMore: ranking.loadMore,
      paging: ranking.paging,
    });
  }
  return { rows: listRows, openRow };
}

function RankingControls({ mode, chooseMode, quietAvailable, ranking, targetError }: RankingControls) {
  const { t, i18n } = useTranslation('boards');
  const { systemColors } = useTheme();
  const modes = GYM_CLIMB_RANKING_MODES.filter((option) => option !== 'QUIET_CLIMBS' || quietAvailable);
  const selectedMode = modes.includes(mode) ? mode : 'MOST_SENT';
  const state = ranking.state;
  const report = ranking.report;
  const timeZone = report?.timeZone ?? 'UTC';
  const locale = i18n.language || 'en-US';
  const time = (instant: string) => formatGymReportingTime(instant, timeZone, locale);
  const showRetry = state !== 'READY' && state !== 'LOADING';
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" variant="title2">
        {t('gymReporting.rankings.title')}
      </Text>
      <AppMenu
        label={t(`gymReporting.rankings.${GYM_CLIMB_RANKING_MODE_COPY[selectedMode].label}`)}
        accessibilityLabel={t('gymReporting.rankings.mode')}
        actions={modes.map((option) => ({
          label: t(`gymReporting.rankings.${GYM_CLIMB_RANKING_MODE_COPY[option].label}`),
          selected: selectedMode === option,
        }))}
        onSelectIndex={(index) => {
          const next = modes[index];
          if (next) chooseMode(next);
        }}
      />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t(`gymReporting.rankings.${GYM_CLIMB_RANKING_MODE_COPY[selectedMode].method}`)}
      </Text>
      {report?.startAt && report.asOf && (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('gymReporting.period', { start: time(report.startAt), end: time(report.asOf) })}
          {' · '}
          {report.timeZoneConfigured ? t('gymReporting.zoneValue', { zone: timeZone }) : t('gymReporting.utcFallback')}
        </Text>
      )}
      {report?.truncated && (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('gymReporting.rankings.firstRanks', { limit: new Intl.NumberFormat(locale).format(200) })}
        </Text>
      )}
      {targetError && <Text accessibilityRole="alert">{t('gymReporting.rankings.climbUnavailable')}</Text>}
      {ranking.opening && <Text accessibilityLiveRegion="polite">{t('gymReporting.rankings.opening')}</Text>}
      {state === 'READY' && !ranking.rows.length && (
        <Text accessibilityLiveRegion="polite">
          {selectedMode === 'QUIET_CLIMBS' ? t('gymReporting.rankings.noExposure') : t('gymReporting.rankings.empty')}
        </Text>
      )}
      {state !== 'READY' && (
        <Text accessibilityLiveRegion="polite">
          {t(`gymReporting.rankings.${GYM_CLIMB_RANKING_STATUS_COPY[state]}`)}
        </Text>
      )}
      {showRetry && <Button title={t('gymReporting.retry')} variant="outlined" onPress={() => void ranking.retry()} />}
    </View>
  );
}

export const GymClimbRankingListItem = memo(function GymClimbRankingListItem({
  item,
  onOpen,
}: {
  item: GymClimbRankingListRow;
  onOpen: (row: GymClimbRankingRow) => void;
}) {
  const { systemColors } = useTheme();
  const { t } = useTranslation(['boards', 'climbs']);
  if (item.kind === 'ranking-controls') return <RankingControls {...item.controls} />;
  if (item.kind === 'ranking-paging') {
    return (
      <View style={styles.section}>
        <Button
          title={t(item.paging ? 'gymReporting.rankings.loading' : 'gymReporting.rankings.loadMore')}
          disabled={item.paging}
          variant="outlined"
          onPress={() => item.loadMore()}
        />
      </View>
    );
  }

  const { model, row } = item;
  const name = model.name || t('climbs:similarClimbs.untitledClimb');
  const title = t('gymReporting.rankings.rankedName', { rank: model.rank, name });
  const angle = t(model.mirrored ? 'gymReporting.rankings.mirroredAngle' : 'gymReporting.rankings.originalAngle', {
    angle: model.angle,
  });
  const subtitle = [model.board, angle, model.grade].filter(Boolean).join(' · ');
  const metrics = model.metrics.map(({ key, values }) => ({ key, label: t(`gymReporting.rankings.${key}`, values) }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, ...metrics.map(({ label }) => label)].join('. ')}
      onPress={() => onOpen(row)}
      style={[styles.entry, { borderTopColor: systemColors.separator }]}
    >
      <Text variant="headline">{title}</Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {subtitle}
      </Text>
      {metrics.map(({ key, label }) => (
        <Text key={key} variant="footnote">
          {label}
        </Text>
      ))}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  section: { gap: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  entry: {
    minHeight: 48,
    gap: spacing[1],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
