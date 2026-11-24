'use client';

import { useCallback, useState } from 'react';
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
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useGymGradeCollectionPicker, useGymGradeComparison, type GymGradeRequest } from '@boardsesh/board-react';
import { buildGymGradeComparisonRows, formatGymReportingTime, hasGraphqlErrorCode } from '@boardsesh/graphql';
import { formatGradeByDifficultyId } from '@boardsesh/play-view';
import type { GymStatsPeriod } from '@boardsesh/shared-schema';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

type Props = {
  viewerId: string;
  gymUuid: string;
  overviewGymUuid: string;
  token: string;
  boardUuid: string | null;
  period: GymStatsPeriod;
};

function CollectionPicker({
  request,
  viewerId,
  gymUuid,
  overviewGymUuid,
  boardUuid,
  canClear,
  close,
}: {
  request: GymGradeRequest;
  viewerId: string;
  gymUuid: string;
  overviewGymUuid: string;
  boardUuid: string;
  canClear: boolean;
  close: () => void;
}) {
  const { t } = useTranslation('boards');
  const picker = useGymGradeCollectionPicker({ viewerId, gymUuid, overviewGymUuid, request }, boardUuid);
  const choose = (uuid: string | null) => void picker.save(uuid).then(close, () => {});
  return (
    <Dialog open onClose={close} fullWidth maxWidth="sm" aria-labelledby="gym-grade-collection-title">
      <DialogTitle id="gym-grade-collection-title">{t('gymGradeComparison.choose')}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1 }}>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            picker.searchNow();
          }}
          sx={{ display: 'flex', gap: 1, alignItems: 'center', pt: 1 }}
        >
          <TextField
            fullWidth
            size="small"
            label={t('gymGradeComparison.search')}
            value={picker.search}
            onChange={(event) => picker.setSearch(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 100 } }}
          />
          <Button type="submit">{t('gymGradeComparison.search')}</Button>
        </Box>
        {picker.state === 'loading' && <Skeleton height={100} />}
        {picker.state === 'offline' && <Alert severity="info">{t('gymReporting.offline')}</Alert>}
        {(picker.state === 'denied' || picker.state === 'error') && (
          <Alert severity="warning" action={<Button onClick={picker.retry}>{t('gymReporting.retry')}</Button>}>
            {t('gymGradeComparison.loadError')}
          </Alert>
        )}
        {picker.saveError != null && (
          <Alert severity="warning">
            {hasGraphqlErrorCode(picker.saveError, 'COLLECTION_UNAVAILABLE')
              ? t('gymGradeComparison.incompatible')
              : t('gymGradeComparison.saveError')}
          </Alert>
        )}
        {picker.data && picker.data.collections.length === 0 && (
          <Typography role="status" variant="body2">
            {t('gymGradeComparison.noMatches')}
          </Typography>
        )}
        {picker.data && (
          <List disablePadding>
            {picker.data.collections.map((collection) => (
              <ListItem disablePadding key={collection.uuid}>
                <ListItemButton disabled={picker.saving} onClick={() => choose(collection.uuid)}>
                  {collection.name}
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        {picker.canGoBack && <Button onClick={picker.goBack}>{t('gymGradeComparison.previous')}</Button>}
        {picker.goNext && <Button onClick={picker.goNext}>{t('gymGradeComparison.next')}</Button>}
        {canClear && (
          <Button disabled={picker.saving || picker.state !== 'ready'} onClick={() => choose(null)}>
            {t('gymGradeComparison.clear')}
          </Button>
        )}
        <Button onClick={close}>{t('gymReporting.cancel')}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function GymGradeComparisonPanel({ viewerId, gymUuid, overviewGymUuid, token, boardUuid, period }: Props) {
  const { t, i18n } = useTranslation('boards');
  const { gradeFormat } = useGradeFormat();
  const [picker, setPicker] = useState<{ boardUuid: string; canClear: boolean } | null>(null);
  const request: GymGradeRequest = useCallback(
    (document, variables, signal) => createGraphQLHttpClient(token).request({ document, variables, signal }),
    [token],
  );
  const comparison = useGymGradeComparison({ viewerId, gymUuid, overviewGymUuid, request }, boardUuid, period);
  const locale = i18n.language || 'en-US';
  const report = comparison.data;
  const number = new Intl.NumberFormat(locale);
  const statuses = {
    READY: '',
    OWNER_ONLY: t('gymGradeComparison.ownerOnly'),
    WALL_UNAVAILABLE: t('gymGradeComparison.wallUnavailable'),
    CHOOSE_COLLECTION: t('gymGradeComparison.collectionMissing'),
    COLLECTION_UNAVAILABLE: t('gymGradeComparison.collectionUnavailable'),
    COLLECTION_EMPTY: t('gymGradeComparison.collectionEmpty'),
  };

  return (
    <Box component="section" sx={{ display: 'grid', gap: 1.5 }}>
      <Typography component="h3" variant="h6">
        {t('gymGradeComparison.title')}
      </Typography>
      {comparison.state === 'loading' && <Skeleton height={100} />}
      {comparison.state === 'offline' && <Alert severity="info">{t('gymReporting.offline')}</Alert>}
      {(comparison.state === 'denied' || comparison.state === 'error') && (
        <Alert severity="warning" action={<Button onClick={comparison.retry}>{t('gymReporting.retry')}</Button>}>
          {hasGraphqlErrorCode(comparison.error, 'SCOPE_TOO_LARGE')
            ? t('gymGradeComparison.tooLarge')
            : t('gymGradeComparison.loadError')}
        </Alert>
      )}
      {report && (
        <>
          <Typography variant="body2">{t('gymGradeComparison.description')}</Typography>
          <Typography variant="body2">
            {t('gymGradeComparison.window', {
              start: formatGymReportingTime(report.startAt, report.timeZone, locale),
              end: formatGymReportingTime(report.asOf, report.timeZone, locale),
            })}
          </Typography>
          <Typography variant="body2">
            {t('gymGradeComparison.availableTotal', { countText: number.format(report.availableCount) })}
          </Typography>
          <Typography variant="body2">
            {t('gymGradeComparison.sendTotal', { countText: number.format(report.sendCount) })}
          </Typography>
          {report.availableCount === 0 ? (
            <Typography role="status" variant="body2">
              {t('gymGradeComparison.noInventory')}
            </Typography>
          ) : (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              {report.sendCount === 0 && <Typography variant="body2">{t('gymGradeComparison.noSends')}</Typography>}
              {buildGymGradeComparisonRows(report, locale, (difficulty, type) =>
                formatGradeByDifficultyId(difficulty, gradeFormat, type),
              ).map((row) => (
                <Box component="section" key={row.label ?? 'unknown'} sx={{ display: 'grid', gap: 0.5 }}>
                  <Typography component="h4" variant="subtitle2">
                    {row.label ?? t('gymGradeComparison.unknown')}
                  </Typography>
                  {[
                    {
                      key: 'available',
                      label: t('gymGradeComparison.available'),
                      series: row.available,
                      color: 'primary.main',
                    },
                    { key: 'sends', label: t('gymGradeComparison.sends'), series: row.sends, color: 'secondary.main' },
                  ].map(({ key, label, series, color }) => (
                    <Box key={key} sx={{ display: 'grid', gap: 0.5 }}>
                      <Typography variant="body2">
                        {t('gymGradeComparison.point', {
                          series: label,
                          countText: series.countText,
                          share: series.shareText,
                        })}
                      </Typography>
                      <Box aria-hidden sx={{ height: 6, bgcolor: 'action.hover', borderRadius: 2, overflow: 'hidden' }}>
                        <Box sx={{ width: `${series.width * 100}%`, height: '100%', bgcolor: color }} />
                      </Box>
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
          )}
          <Typography component="h4" variant="subtitle2">
            {t('gymGradeComparison.scopes')}
          </Typography>
          <List disablePadding>
            {report.boards.map((board) => {
              const root = report.boards.find((candidate) => candidate.boardUuid === board.physicalBoardUuid);
              return (
                <ListItem key={board.boardUuid} disableGutters sx={{ display: 'grid', gap: 0.5 }}>
                  <Typography variant="subtitle2">
                    {root && root !== board
                      ? t('gymGradeComparison.boardGroup', { board: board.boardName, physical: root.boardName })
                      : board.boardName}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {board.kind === 'SPRAY_WALL' ? t('gymGradeComparison.spray') : t('gymGradeComparison.led')}
                    {board.collectionName ? ` · ${board.collectionName}` : ''}
                  </Typography>
                  <Typography variant="body2">
                    {board.included
                      ? t('gymGradeComparison.included', { countText: number.format(board.variantCount) })
                      : statuses[board.status]}
                  </Typography>
                  {board.kind === 'LED_COLLECTION' && (
                    <Box>
                      <Button
                        onClick={() =>
                          setPicker({ boardUuid: board.boardUuid, canClear: board.status !== 'CHOOSE_COLLECTION' })
                        }
                      >
                        {board.status === 'CHOOSE_COLLECTION'
                          ? t('gymGradeComparison.choose')
                          : t('gymGradeComparison.change')}
                      </Button>
                    </Box>
                  )}
                </ListItem>
              );
            })}
          </List>
        </>
      )}
      {picker && comparison.state !== 'denied' && comparison.state !== 'offline' && (
        <CollectionPicker
          key={picker.boardUuid}
          request={request}
          viewerId={viewerId}
          gymUuid={gymUuid}
          overviewGymUuid={overviewGymUuid}
          boardUuid={picker.boardUuid}
          canClear={picker.canClear}
          close={() => setPicker(null)}
        />
      )}
    </Box>
  );
}
