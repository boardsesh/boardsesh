'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { msUntilExpiry, summariseStats } from '@/app/lib/admin/spray-training-overlay';
import {
  GET_SPRAY_TRAINING_QUEUE,
  SET_SPRAY_TRAINING_REVIEW,
  type GetSprayTrainingQueueQueryResponse,
  type GetSprayTrainingQueueQueryVariables,
  type SetSprayTrainingReviewMutationResponse,
  type SetSprayTrainingReviewMutationVariables,
  type SprayTrainingQueueItemData,
  type SprayTrainingReviewStatus,
} from '@boardsesh/graphql/operations';
import SprayTrainingReviewDialog, { type SprayTrainingDecision } from './spray-training-review-dialog';

/** The backend caps a page at 25. */
const PAGE_SIZE = 25;
/** Never refetch faster than this, so a clock-skewed expiry cannot loop. */
const MIN_REFRESH_DELAY_MS = 5000;
/** setTimeout fires at once for anything past 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

type Totals = GetSprayTrainingQueueQueryResponse['sprayTrainingQueue']['totals'];

const EMPTY_TOTALS: Totals = { unreviewed: 0, approved: 0, rejected: 0 };

function totalsKey(status: SprayTrainingReviewStatus): keyof Totals {
  if (status === 'APPROVED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  return 'unreviewed';
}

export default function SprayTrainingPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [status, setStatus] = useState<SprayTrainingReviewStatus>('UNREVIEWED');
  const [items, setItems] = useState<SprayTrainingQueueItemData[]>([]);
  const [totals, setTotals] = useState<Totals>(EMPTY_TOTALS);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  // The offset that failed, so Retry re-requests the same page.
  const [error, setError] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [snackbar, setSnackbar] = useState('');
  // Drops a response that lands after the status tab changed.
  const requestCounter = useRef(0);

  const fetchPage = useCallback(
    async (offset: number, forStatus: SprayTrainingReviewStatus) => {
      if (!token) return;
      const requestId = ++requestCounter.current;
      setLoading(true);
      setError(null);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<GetSprayTrainingQueueQueryResponse, GetSprayTrainingQueueQueryVariables>(
          GET_SPRAY_TRAINING_QUEUE,
          { status: forStatus, limit: PAGE_SIZE, offset },
        );
        if (requestId !== requestCounter.current) return;
        const page = result.sprayTrainingQueue;
        setItems((previous) => (offset === 0 ? page.items : [...previous, ...page.items]));
        setHasMore(page.hasMore);
        setTotals(page.totals);
      } catch (err) {
        if (requestId !== requestCounter.current) return;
        console.error('[SprayTrainingPanel] Failed to fetch queue:', err);
        setError(offset);
      } finally {
        if (requestId === requestCounter.current) setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    setItems([]);
    void fetchPage(0, status);
  }, [fetchPage, status]);

  // Photo URLs are 15-minute signatures. Re-read every loaded page shortly
  // before the earliest one stops working, keeping the open wall in place.
  const itemCount = items.length;
  const earliestExpiry = items.reduce<string | null>((earliest, item) => {
    const expiresAt = item.photo?.expiresAt ?? null;
    if (!expiresAt) return earliest;
    return earliest === null || Date.parse(expiresAt) < Date.parse(earliest) ? expiresAt : earliest;
  }, null);

  useEffect(() => {
    if (!token || earliestExpiry === null) return undefined;
    const delay = Math.min(
      MAX_TIMER_MS,
      Math.max(MIN_REFRESH_DELAY_MS, msUntilExpiry(earliestExpiry, Date.now()) ?? 0),
    );
    const timer = setTimeout(async () => {
      const requestId = ++requestCounter.current;
      try {
        const client = createGraphQLHttpClient(token);
        const pages: SprayTrainingQueueItemData[] = [];
        let latestTotals: Totals | null = null;
        let latestHasMore = false;
        for (let offset = 0; offset < Math.max(itemCount, 1); offset += PAGE_SIZE) {
          const result = await client.request<GetSprayTrainingQueueQueryResponse, GetSprayTrainingQueueQueryVariables>(
            GET_SPRAY_TRAINING_QUEUE,
            { status, limit: PAGE_SIZE, offset },
          );
          pages.push(...result.sprayTrainingQueue.items);
          latestTotals = result.sprayTrainingQueue.totals;
          latestHasMore = result.sprayTrainingQueue.hasMore;
          if (!result.sprayTrainingQueue.hasMore) break;
        }
        if (requestId !== requestCounter.current) return;
        setItems(pages);
        setHasMore(latestHasMore);
        if (latestTotals) setTotals(latestTotals);
      } catch (err) {
        console.error('[SprayTrainingPanel] Failed to refresh photo links:', err);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [token, earliestExpiry, itemCount, status]);

  const selectedIndex = items.findIndex((item) => item.versionId === selectedId);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : null;

  const closeDialog = useCallback(() => setSelectedId(null), []);
  const goPrevious = useCallback(() => {
    if (selectedIndex > 0) setSelectedId(items[selectedIndex - 1].versionId);
  }, [items, selectedIndex]);
  const goNext = useCallback(() => {
    if (selectedIndex >= 0 && selectedIndex < items.length - 1) setSelectedId(items[selectedIndex + 1].versionId);
  }, [items, selectedIndex]);

  const decide = useCallback(
    async (item: SprayTrainingQueueItemData, decision: SprayTrainingDecision) => {
      if (!token) return;
      setDeciding(true);
      try {
        const client = createGraphQLHttpClient(token);
        await client.request<SetSprayTrainingReviewMutationResponse, SetSprayTrainingReviewMutationVariables>(
          SET_SPRAY_TRAINING_REVIEW,
          {
            input: {
              versionId: item.versionId,
              status: decision.status,
              reason: decision.reason ?? null,
              notes: decision.notes ?? null,
            },
          },
        );
        // The wall leaves this tab, so the next one takes its slot in the dialog.
        const index = items.findIndex((entry) => entry.versionId === item.versionId);
        const remaining = items.filter((entry) => entry.versionId !== item.versionId);
        setItems(remaining);
        setTotals((previous) => ({
          ...previous,
          [totalsKey(status)]: Math.max(0, previous[totalsKey(status)] - 1),
          [totalsKey(decision.status)]: previous[totalsKey(decision.status)] + 1,
        }));
        const successor = remaining[Math.min(index, remaining.length - 1)];
        setSelectedId(successor ? successor.versionId : null);
        if (decision.status === 'APPROVED') setSnackbar(t('sprayTraining.snackbar.approved'));
        else if (decision.status === 'REJECTED') setSnackbar(t('sprayTraining.snackbar.rejected'));
        else setSnackbar(t('sprayTraining.snackbar.reset'));
      } catch (err) {
        console.error('[SprayTrainingPanel] Failed to save review:', err);
        setSnackbar(t('sprayTraining.snackbar.failed'));
      } finally {
        setDeciding(false);
      }
    },
    [token, items, status, t],
  );

  return (
    <Box>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={status}
        onChange={(_event, next: SprayTrainingReviewStatus | null) => {
          if (next) setStatus(next);
        }}
        aria-label={t('sprayTraining.statusLabel')}
        sx={{ mb: 2, flexWrap: 'wrap' }}
      >
        <ToggleButton value="UNREVIEWED" sx={{ textTransform: 'none' }}>
          {t('sprayTraining.status.unreviewed', { total: totals.unreviewed })}
        </ToggleButton>
        <ToggleButton value="APPROVED" sx={{ textTransform: 'none' }}>
          {t('sprayTraining.status.approved', { total: totals.approved })}
        </ToggleButton>
        <ToggleButton value="REJECTED" sx={{ textTransform: 'none' }}>
          {t('sprayTraining.status.rejected', { total: totals.rejected })}
        </ToggleButton>
      </ToggleButtonGroup>

      {error !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => fetchPage(error, status)}
              sx={{ textTransform: 'none' }}
            >
              {t('sprayTraining.retry')}
            </Button>
          }
        >
          {t('sprayTraining.error')}
        </Alert>
      )}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)', md: 'repeat(4, 1fr)' },
        }}
      >
        {items.map((item) => {
          const stats = summariseStats(item.stats);
          return (
            <Card key={item.versionId} variant="outlined">
              <CardActionArea
                onClick={() => setSelectedId(item.versionId)}
                aria-label={t('sprayTraining.card.open', { version: item.versionNumber })}
              >
                {item.photo ? (
                  <Box
                    component="img"
                    src={item.photo.thumbUrl ?? item.photo.url}
                    alt=""
                    loading="lazy"
                    sx={{ display: 'block', width: '100%', aspectRatio: '4 / 3', objectFit: 'cover' }}
                  />
                ) : (
                  <Box sx={{ aspectRatio: '4 / 3', bgcolor: themeTokens.neutral[100] }} />
                )}
                <CardContent sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, p: 1 }}>
                  <Chip size="small" label={t('sprayTraining.card.holds', { total: stats.holdCount })} />
                  <Chip size="small" label={t('sprayTraining.card.edited', { percent: stats.editedPercent })} />
                  <Chip size="small" label={t('sprayTraining.card.accepted', { percent: stats.acceptedPercent })} />
                  <Chip size="small" label={t('sprayTraining.card.deleted', { total: stats.deletedSuggestions })} />
                </CardContent>
              </CardActionArea>
            </Card>
          );
        })}
      </Box>

      {items.length === 0 && !loading && error === null && (
        <Typography variant="body2" sx={{ color: themeTokens.neutral[400], py: 2, textAlign: 'center' }}>
          {t('sprayTraining.empty')}
        </Typography>
      )}
      {loading && (
        <Box sx={{ textAlign: 'center' }}>
          <CircularProgress size={20} sx={{ my: 2 }} />
        </Box>
      )}
      {hasMore && (
        <Box sx={{ mt: 2, textAlign: 'center' }}>
          <Button
            variant="outlined"
            onClick={() => fetchPage(items.length, status)}
            disabled={loading}
            sx={{ textTransform: 'none' }}
          >
            {t('sprayTraining.loadMore')}
          </Button>
        </Box>
      )}

      <SprayTrainingReviewDialog
        item={selectedItem}
        position={selectedIndex + 1}
        total={items.length}
        busy={deciding}
        onClose={closeDialog}
        onPrevious={goPrevious}
        onNext={goNext}
        onDecide={decide}
      />

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}
