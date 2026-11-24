'use client';

import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useGymClimbRankings, type GymClimbRankingRequest } from '@boardsesh/board-react';
import {
  createGymClimbRankingFormat,
  formatGymReportingTime,
  GYM_CLIMB_RANKING_MODE_COPY,
  GYM_CLIMB_RANKING_MODES,
  GYM_CLIMB_RANKING_STATUS_COPY,
  GymReportingViewerChangedError,
  gymClimbRankingRowKey,
} from '@boardsesh/graphql';
import { formatGradeByDifficultyId } from '@boardsesh/play-view';
import type {
  GymClimbRankingMode,
  GymClimbRankingRow,
  GymClimbRankingTarget,
  GymStatsInput,
} from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { browserSessionGuard, isSessionSuperseded } from '@/app/lib/auth/session-guard';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { DEFAULT_LOCALE, isSupportedLocale } from '@/app/lib/i18n/config';
import { applyLocale } from '@/app/lib/i18n/locale-href';
import {
  GymClimbRankingPrivateArt,
  readGymClimbRankingPreview,
  type GymClimbRankingPreview,
} from './gym-climb-ranking-preview';

type Props = GymStatsInput & {
  viewerId: string;
  overviewGymUuid: string;
  token: string;
  mode: GymClimbRankingMode;
  chooseMode: (mode: GymClimbRankingMode) => void;
};

type Selection = {
  target: GymClimbRankingTarget;
  preview: GymClimbRankingPreview;
  isCurrent: () => boolean;
};

function openPublicClimb(path: string) {
  // Opening after verification may hit browser popup policy. The dialog then
  // offers the same checked link as a direct user action.
  const tab = window.open('', '_blank');
  if (!tab) return false;
  tab.opener = null;
  tab.location.replace(path);
  return true;
}

const readServerEpoch = () => 0;

export function GymClimbRankingsPanel({
  viewerId,
  overviewGymUuid,
  token,
  gymUuid,
  boardUuid,
  period,
  mode,
  chooseMode,
}: Props) {
  const { t, i18n } = useTranslation(['boards', 'climbs']);
  const locale = i18n.language || 'en-US';
  const hrefLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const { gradeFormat } = useGradeFormat();
  const sectionHeading = useId();
  const dialogHeading = useId();
  const guard = browserSessionGuard();
  const readEpoch = useCallback(() => {
    const epoch = guard.capture();
    return guard.isCurrent(epoch) ? epoch : -1;
  }, [guard]);
  const credentialEpoch = useSyncExternalStore(guard.subscribe, readEpoch, readServerEpoch);
  const isCredentialCurrent = useCallback(() => guard.isCurrent(credentialEpoch), [guard, credentialEpoch]);
  const request: GymClimbRankingRequest = useCallback(
    async (document, variables, signal) => {
      try {
        return await createGraphQLHttpClient(token).request({ document, variables, signal });
      } catch (error) {
        if (isSessionSuperseded(error)) throw new GymReportingViewerChangedError();
        throw error;
      }
    },
    [token],
  );
  const ranking = useGymClimbRankings({
    viewerId,
    overviewGymUuid,
    gymUuid,
    boardUuid,
    period,
    mode,
    request,
    credentialEpoch,
    isCredentialCurrent,
    active: true,
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [quietScope, setQuietScope] = useState<string | null>(null);
  const [failedScope, setFailedScope] = useState<string | null>(null);
  const scope = JSON.stringify([viewerId, credentialEpoch, gymUuid, boardUuid, period]);
  const targetScope = JSON.stringify([scope, mode]);
  const quiet =
    ranking.state === 'READY' || ranking.state === 'PAGE_CHANGED' ? ranking.report?.quietAvailable : undefined;
  const quietAvailable = quiet === true || (quiet !== false && quietScope === scope);
  useEffect(() => {
    if (ranking.state !== 'READY') return;
    setQuietScope(quiet ? scope : null);
    if (!quiet && mode === 'QUIET_CLIMBS') chooseMode('MOST_SENT');
  }, [chooseMode, mode, quiet, ranking.state, scope]);

  const currentSelection = ranking.state === 'READY' && selection?.isCurrent() ? selection : null;
  useEffect(() => {
    if (selection && !currentSelection) setSelection(null);
  }, [selection, currentSelection]);

  async function openRow(row: GymClimbRankingRow) {
    setFailedScope(null);
    setSelection(null);
    try {
      const selection = await ranking.resolveTarget(row, async (target, signal) => ({
        target,
        preview: await readGymClimbRankingPreview(token, target, signal),
      }));
      if (!selection?.isCurrent()) return;
      const { target, preview } = selection.result;
      if (preview.kind === 'public' && openPublicClimb(applyLocale(preview.path, hrefLocale))) return;
      setSelection({ preview, target, isCurrent: selection.isCurrent });
    } catch {
      setFailedScope(targetScope);
    }
  }

  const modes = GYM_CLIMB_RANKING_MODES.filter((option) => option !== 'QUIET_CLIMBS' || quietAvailable);
  const selectedMode = modes.includes(mode) ? mode : 'MOST_SENT';
  const report = ranking.report;
  const timeZone = report?.timeZone ?? 'UTC';
  const format = useMemo(
    () =>
      createGymClimbRankingFormat(locale, timeZone, (grade, board) =>
        formatGradeByDifficultyId(grade, gradeFormat, board),
      ),
    [gradeFormat, locale, timeZone],
  );
  const time = (instant: string) => formatGymReportingTime(instant, timeZone, locale);
  const state = ranking.state;
  const defaultClimbName = t('climbs:similarClimbs.untitledClimb');

  return (
    <Box component="section" aria-labelledby={sectionHeading} sx={{ display: 'grid', gap: 1.5 }}>
      <Typography id={sectionHeading} component="h3" variant="h6">
        {t('gymReporting.rankings.title')}
      </Typography>
      <Box>
        <TextField
          select
          size="small"
          label={t('gymReporting.rankings.mode')}
          value={selectedMode}
          onChange={(event) => {
            const next = modes.find((option) => option === event.target.value);
            if (next) chooseMode(next);
          }}
        >
          {modes.map((option) => (
            <MenuItem key={option} value={option}>
              {t(`gymReporting.rankings.${GYM_CLIMB_RANKING_MODE_COPY[option].label}`)}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      <Typography variant="body2" color="text.secondary">
        {t(`gymReporting.rankings.${GYM_CLIMB_RANKING_MODE_COPY[selectedMode].method}`)}
      </Typography>
      {report?.startAt && report.asOf && (
        <Typography variant="body2" color="text.secondary">
          {t('gymReporting.period', { start: time(report.startAt), end: time(report.asOf) })}
          {' · '}
          {report.timeZoneConfigured ? t('gymReporting.zoneValue', { zone: timeZone }) : t('gymReporting.utcFallback')}
        </Typography>
      )}
      {report?.truncated && (
        <Typography variant="body2" color="text.secondary">
          {t('gymReporting.rankings.firstRanks', { limit: new Intl.NumberFormat(locale).format(200) })}
        </Typography>
      )}
      {failedScope === targetScope && <Alert severity="warning">{t('gymReporting.rankings.climbUnavailable')}</Alert>}
      {ranking.opening && (
        <Typography variant="body2" role="status">
          {t('gymReporting.rankings.opening')}
        </Typography>
      )}
      {state === 'LOADING' && (
        <Typography variant="body2" role="status">
          {t('gymReporting.rankings.loading')}
        </Typography>
      )}
      {state !== 'READY' && state !== 'LOADING' && (
        <Alert
          severity="warning"
          action={<Button onClick={() => void ranking.retry()}>{t('gymReporting.retry')}</Button>}
        >
          {t(`gymReporting.rankings.${GYM_CLIMB_RANKING_STATUS_COPY[state]}`)}
        </Alert>
      )}
      {state === 'READY' && !ranking.rows.length && (
        <Typography variant="body2" role="status">
          {selectedMode === 'QUIET_CLIMBS' ? t('gymReporting.rankings.noExposure') : t('gymReporting.rankings.empty')}
        </Typography>
      )}
      {ranking.rows.length > 0 && (
        <List component="ol" disablePadding>
          {ranking.rows.map((row) => {
            const model = format(row, report?.mode ?? mode);
            const angle = t(
              model.mirrored ? 'gymReporting.rankings.mirroredAngle' : 'gymReporting.rankings.originalAngle',
              { angle: model.angle },
            );
            const name = model.name || defaultClimbName;
            return (
              <ListItem key={gymClimbRankingRowKey(row)} component="li" divider disablePadding>
                <ListItemButton
                  component="button"
                  onClick={() => void openRow(row)}
                  sx={{ display: 'block', textAlign: 'start' }}
                >
                  <Typography component="span" variant="subtitle2">
                    {t('gymReporting.rankings.rankedName', { name, rank: model.rank })}
                  </Typography>
                  <Typography component="span" variant="body2" color="text.secondary" display="block">
                    {[model.board, angle, model.grade].filter(Boolean).join(' · ')}
                  </Typography>
                  {model.metrics.map(({ key, values }) => (
                    <Typography component="span" variant="body2" display="block" key={key}>
                      {t(`gymReporting.rankings.${key}`, values)}
                    </Typography>
                  ))}
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      )}
      {ranking.canLoadMore && (
        <Box>
          <Button disabled={ranking.paging} onClick={() => void ranking.loadMore()}>
            {t(ranking.paging ? 'gymReporting.rankings.loading' : 'gymReporting.rankings.loadMore')}
          </Button>
        </Box>
      )}
      {currentSelection && (
        <Dialog open onClose={() => setSelection(null)} aria-labelledby={dialogHeading} fullWidth maxWidth="xs">
          <DialogTitle id={dialogHeading}>{currentSelection.target.name || defaultClimbName}</DialogTitle>
          {currentSelection.preview.kind !== 'public' && (
            <DialogContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {t(
                  currentSelection.target.isMirror
                    ? 'gymReporting.rankings.mirroredAngle'
                    : 'gymReporting.rankings.originalAngle',
                  {
                    angle: new Intl.NumberFormat(locale).format(currentSelection.target.angle),
                  },
                )}
              </Typography>
              <GymClimbRankingPrivateArt
                preview={currentSelection.preview}
                alt={currentSelection.target.name || defaultClimbName}
              />
            </DialogContent>
          )}
          <DialogActions>
            <Button onClick={() => setSelection(null)}>{t('gymReporting.rankings.close')}</Button>
            {currentSelection.preview.kind === 'public' && (
              <Button
                component={LocaleLink}
                href={currentSelection.preview.path}
                target="_blank"
                rel="noopener noreferrer"
                prefetch={false}
              >
                {t('gymReporting.rankings.openClimb')}
              </Button>
            )}
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
