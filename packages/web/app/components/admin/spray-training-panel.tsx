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
import { isSprayTrainingNotEligibleError } from '@boardsesh/graphql/errors';
import {
  GET_SPRAY_TRAINING_QUEUE,
  GET_SPRAY_TRAINING_TOTALS,
  SET_SPRAY_TRAINING_REVIEW,
  type GetSprayTrainingQueueQueryResponse,
  type GetSprayTrainingQueueQueryVariables,
  type GetSprayTrainingTotalsQueryResponse,
  type GetSprayTrainingTotalsQueryVariables,
  type SetSprayTrainingReviewMutationResponse,
  type SetSprayTrainingReviewMutationVariables,
  type SprayTrainingQueueItemData,
  type SprayTrainingReviewStatus,
  type SprayTrainingTotalsData,
} from '@boardsesh/graphql/operations';
import SprayTrainingReviewDialog, { type SprayTrainingDecision } from './spray-training-review-dialog';

/** The backend caps a page at 25. */
const PAGE_SIZE = 25;
/** Never refetch faster than this, so a clock-skewed expiry cannot loop. */
const MIN_REFRESH_DELAY_MS = 5000;
/** Photo links are re-read this long before the earliest one expires. */
const REFRESH_LEAD_MS = 60_000;
/** Backoff after a failed refresh: 15 s, doubling, capped at 5 min. */
const REFRESH_RETRY_BASE_MS = 15_000;
const REFRESH_RETRY_MAX_MS = 300_000;
/** setTimeout fires at once for anything past 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

const EMPTY_TOTALS: SprayTrainingTotalsData = { unreviewed: 0, approved: 0, rejected: 0 };

function totalsKey(status: SprayTrainingReviewStatus): keyof SprayTrainingTotalsData {
  if (status === 'APPROVED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  return 'unreviewed';
}

export default function SprayTrainingPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [status, setStatus] = useState<SprayTrainingReviewStatus>('UNREVIEWED');
  const [items, setItems] = useState<SprayTrainingQueueItemData[]>([]);
  const [totals, setTotals] = useState<SprayTrainingTotalsData>(EMPTY_TOTALS);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  // The offset that failed, so Retry re-requests the same page.
  const [error, setError] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The dialog decided the last loaded wall while the queue goes on. It stays
  // open and lands on the first wall of the page being fetched.
  const [resumeReview, setResumeReview] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [snackbar, setSnackbar] = useState('');
  // Drops a response that lands after the status tab changed.
  const requestCounter = useRef(0);
  // Walls moved to another tab since the last full read. A refresh that was
  // already in flight must not bring them back.
  const decidedIds = useRef<Set<string>>(new Set());
  const [refreshAttempt, setRefreshAttempt] = useState(0);

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
        setItems((previous) => {
          if (offset === 0) return page.items;
          const known = new Set(previous.map((entry) => entry.versionId));
          return [...previous, ...page.items.filter((entry) => !known.has(entry.versionId))];
        });
        // An empty page ends the list whatever it claims, so the drained-list
        // fetch below can never chase its own tail.
        setHasMore(page.hasMore && page.items.length > 0);
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
    decidedIds.current = new Set();
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
    const retryDelay = Math.min(REFRESH_RETRY_MAX_MS, REFRESH_RETRY_BASE_MS * 2 ** Math.max(0, refreshAttempt - 1));
    const expiryDelay = (msUntilExpiry(earliestExpiry, Date.now()) ?? 0) - REFRESH_LEAD_MS;
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_REFRESH_DELAY_MS, refreshAttempt > 0 ? retryDelay : expiryDelay));
    const timer = setTimeout(async () => {
      // Not bumped: a refresh must not cancel a load-more (nor leave its
      // spinner stuck). Any fetchPage that starts meanwhile changes this and
      // the stale refresh is dropped.
      const startedAt = requestCounter.current;
      try {
        const client = createGraphQLHttpClient(token);
        const pages: SprayTrainingQueueItemData[] = [];
        let latestTotals: SprayTrainingTotalsData | null = null;
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
        if (startedAt !== requestCounter.current) return;
        const seen = new Set<string>();
        setItems(
          pages.filter((entry) => {
            if (decidedIds.current.has(entry.versionId) || seen.has(entry.versionId)) return false;
            seen.add(entry.versionId);
            return true;
          }),
        );
        setHasMore(latestHasMore);
        if (latestTotals) setTotals(latestTotals);
        setRefreshAttempt(0);
      } catch (err) {
        console.error('[SprayTrainingPanel] Failed to refresh photo links:', err);
        if (startedAt === requestCounter.current) setRefreshAttempt((attempt) => attempt + 1);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [token, earliestExpiry, itemCount, status, refreshAttempt]);

  // Deciding every loaded wall is not the end of the queue. Whatever emptied
  // the list (a verdict, a refused one, a refresh), read the next page.
  useEffect(() => {
    if (itemCount === 0 && hasMore && !loading && error === null) void fetchPage(0, status);
  }, [itemCount, hasMore, loading, error, fetchPage, status]);

  // The page the dialog was held open for has landed, or is not coming.
  const firstVersionId = items[0]?.versionId ?? null;
  useEffect(() => {
    if (!resumeReview) return;
    if (firstVersionId !== null) setSelectedId(firstVersionId);
    if (firstVersionId !== null || !hasMore || error !== null) setResumeReview(false);
  }, [resumeReview, firstVersionId, hasMore, error]);

  const selectedIndex = items.findIndex((item) => item.versionId === selectedId);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : null;

  const closeDialog = useCallback(() => {
    setSelectedId(null);
    setResumeReview(false);
  }, []);
  const goPrevious = useCallback(() => {
    if (selectedIndex > 0) setSelectedId(items[selectedIndex - 1].versionId);
  }, [items, selectedIndex]);
  const goNext = useCallback(() => {
    if (selectedIndex >= 0 && selectedIndex < items.length - 1) setSelectedId(items[selectedIndex + 1].versionId);
  }, [items, selectedIndex]);

  const decide = useCallback(
    async (item: SprayTrainingQueueItemData, decision: SprayTrainingDecision) => {
      if (!token) return;
      // The wall leaves this tab, so the next one takes its slot in the dialog.
      const leaveTab = () => {
        decidedIds.current.add(item.versionId);
        const index = items.findIndex((entry) => entry.versionId === item.versionId);
        const remaining = items.filter((entry) => entry.versionId !== item.versionId);
        setItems((previous) => previous.filter((entry) => entry.versionId !== item.versionId));
        const successor = remaining[Math.min(index, remaining.length - 1)];
        setSelectedId(successor ? successor.versionId : null);
        if (!successor && hasMore) setResumeReview(true);
      };
      setDeciding(true);
      const client = createGraphQLHttpClient(token);
      try {
        const result = await client.request<
          SetSprayTrainingReviewMutationResponse,
          SetSprayTrainingReviewMutationVariables
        >(SET_SPRAY_TRAINING_REVIEW, {
          input: {
            versionId: item.versionId,
            status: decision.status,
            reason: decision.reason ?? null,
            notes: decision.notes ?? null,
          },
        });
        if (decision.status === status) {
          // Same verdict, new reason or notes: the wall stays on this tab.
          const { review } = result.setSprayTrainingReview;
          setItems((previous) =>
            previous.map((entry) => (entry.versionId === item.versionId ? { ...entry, review } : entry)),
          );
        } else {
          leaveTab();
          setTotals((previous) => ({
            ...previous,
            [totalsKey(status)]: Math.max(0, previous[totalsKey(status)] - 1),
            [totalsKey(decision.status)]: previous[totalsKey(decision.status)] + 1,
          }));
        }
        if (decision.status === 'APPROVED') setSnackbar(t('sprayTraining.snackbar.approved'));
        else if (decision.status === 'REJECTED') setSnackbar(t('sprayTraining.snackbar.rejected'));
        else setSnackbar(t('sprayTraining.snackbar.reset'));
      } catch (err) {
        if (!isSprayTrainingNotEligibleError(err)) {
          console.error('[SprayTrainingPanel] Failed to save review:', err);
          setSnackbar(t('sprayTraining.snackbar.failed'));
          return;
        }
        // The wall left the training set after this page loaded (training
        // switched off, wall deleted or hidden, photo replaced by a newer
        // version). Its photo comes off the screen now, not at the next refresh.
        leaveTab();
        setSnackbar(t('sprayTraining.snackbar.notEligible'));
        // Still under `deciding`: a verdict saved while this read was in flight
        // would leave the counts off by one.
        try {
          const fresh = await client.request<GetSprayTrainingTotalsQueryResponse, GetSprayTrainingTotalsQueryVariables>(
            GET_SPRAY_TRAINING_TOTALS,
            { status },
          );
          setTotals(fresh.sprayTrainingQueue.totals);
        } catch (totalsError) {
          console.error('[SprayTrainingPanel] Failed to refresh totals:', totalsError);
          // Best guess when the server will not say: this tab lost the one wall.
          setTotals((previous) => ({
            ...previous,
            [totalsKey(status)]: Math.max(0, previous[totalsKey(status)] - 1),
          }));
        }
      } finally {
        setDeciding(false);
      }
    },
    [token, items, hasMore, status, t],
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

      {items.length === 0 && !loading && error === null && !hasMore && (
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
        loadingNext={resumeReview && selectedItem === null}
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
