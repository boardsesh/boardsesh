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
import { useIsomorphicLayoutEffect } from '@/app/lib/hooks/use-isomorphic-layout-effect';
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
  type SprayTrainingReviewData,
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

type VerdictOutcome =
  | { kind: 'saved'; review: SprayTrainingReviewData }
  /** The wall left the training set after the page loaded: training switched off, wall deleted or hidden, photo replaced. */
  | { kind: 'refused' }
  | { kind: 'failed' };

async function sendVerdict(
  client: ReturnType<typeof createGraphQLHttpClient>,
  versionId: string,
  decision: SprayTrainingDecision,
): Promise<VerdictOutcome> {
  try {
    const result = await client.request<
      SetSprayTrainingReviewMutationResponse,
      SetSprayTrainingReviewMutationVariables
    >(SET_SPRAY_TRAINING_REVIEW, {
      input: { versionId, status: decision.status, reason: decision.reason ?? null, notes: decision.notes ?? null },
    });
    return { kind: 'saved', review: result.setSprayTrainingReview.review };
  } catch (err) {
    if (isSprayTrainingNotEligibleError(err)) return { kind: 'refused' };
    console.error('[SprayTrainingPanel] Failed to save review:', err);
    return { kind: 'failed' };
  }
}

export default function SprayTrainingPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [status, setStatus] = useState<SprayTrainingReviewStatus>('UNREVIEWED');
  const [items, setItems] = useState<SprayTrainingQueueItemData[]>([]);
  const [totals, setTotals] = useState<SprayTrainingTotalsData>(EMPTY_TOTALS);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  // The offset of the read that failed. Retry does not reuse it: verdicts given
  // since then have shortened the list, and the old offset would skip walls.
  const [failedOffset, setFailedOffset] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The dialog decided the last loaded wall while the queue goes on. It stays
  // open and lands on the first wall of the page being fetched.
  const [resumeReview, setResumeReview] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [snackbar, setSnackbar] = useState('');
  // Bumped by whatever makes an answer still on its way wrong for the list on
  // screen: a newer page read, a tab switch, a verdict. A page read or a link
  // refresh that finds it changed throws its answer away.
  const requestCounter = useRef(0);
  // Whether a page read is on its way, so that dropping it can also clear its
  // spinner and tell the caller to ask again.
  const pageReadInFlight = useRef(false);
  // Counts the times the list was thrown away and read from the top (a tab
  // switch, a new token). A verdict that returns to another list must not
  // patch it.
  const listEpoch = useRef(0);
  // What is on screen now, for code that resumes after an await and would
  // otherwise act on the render it started in.
  const shown = useRef({ status, items, hasMore, selectedId });
  useIsomorphicLayoutEffect(() => {
    shown.current = { status, items, hasMore, selectedId };
  });
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  // Bumped when a link refresh was overtaken, so the effect arms another one.
  const [overtakenRefreshes, setOvertakenRefreshes] = useState(0);

  const fetchPage = useCallback(
    async (offset: number, forStatus: SprayTrainingReviewStatus) => {
      if (!token) return;
      const requestId = ++requestCounter.current;
      pageReadInFlight.current = true;
      setLoading(true);
      setFailedOffset(null);
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
        setFailedOffset(offset);
      } finally {
        if (requestId === requestCounter.current) {
          pageReadInFlight.current = false;
          setLoading(false);
        }
      }
    },
    [token],
  );

  // Throws away whatever answer is on its way. Says whether a page read was
  // among them: its spinner is cleared here, since its own cleanup no longer
  // runs, and the caller asks again once the list has settled.
  const dropReadsInFlight = useCallback(() => {
    requestCounter.current += 1;
    if (!pageReadInFlight.current) return false;
    pageReadInFlight.current = false;
    setLoading(false);
    return true;
  }, []);

  useEffect(() => {
    listEpoch.current += 1;
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
    const retryDelay = Math.min(REFRESH_RETRY_MAX_MS, REFRESH_RETRY_BASE_MS * 2 ** Math.max(0, refreshAttempt - 1));
    const expiryDelay = (msUntilExpiry(earliestExpiry, Date.now()) ?? 0) - REFRESH_LEAD_MS;
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_REFRESH_DELAY_MS, refreshAttempt > 0 ? retryDelay : expiryDelay));
    const timer = setTimeout(async () => {
      // Not bumped: a refresh must not cancel a load-more (nor leave its
      // spinner stuck). A page read or a verdict that starts meanwhile changes
      // this and the stale refresh is dropped.
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
        if (startedAt !== requestCounter.current) {
          // Overtaken, so this answer may predate what is on screen. The links
          // still need renewing, and nothing else is sure to arm the timer.
          setOvertakenRefreshes((count) => count + 1);
          return;
        }
        const seen = new Set<string>();
        setItems(
          pages.filter((entry) => {
            if (seen.has(entry.versionId)) return false;
            seen.add(entry.versionId);
            return true;
          }),
        );
        setHasMore(latestHasMore);
        if (latestTotals) setTotals(latestTotals);
        setRefreshAttempt(0);
      } catch (err) {
        console.error('[SprayTrainingPanel] Failed to refresh photo links:', err);
        setRefreshAttempt((attempt) => attempt + 1);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [token, earliestExpiry, itemCount, status, refreshAttempt, overtakenRefreshes]);

  // Deciding every loaded wall is not the end of the queue. Whatever emptied
  // the list (a verdict, a refused one, a refresh), read the next page. A
  // "Load more" that failed earlier does not stand in the way: it asked for a
  // page past walls that are gone now. Only a failed read of the top of the
  // list is left to Retry, or this would ask again forever.
  const topReadFailed = failedOffset === 0;
  useEffect(() => {
    if (itemCount === 0 && hasMore && !loading && !topReadFailed) void fetchPage(0, status);
  }, [itemCount, hasMore, loading, topReadFailed, fetchPage, status]);

  // The page the dialog was held open for has landed, or is not coming.
  const firstVersionId = items[0]?.versionId ?? null;
  useEffect(() => {
    if (!resumeReview) return;
    if (firstVersionId !== null) setSelectedId(firstVersionId);
    if (firstVersionId !== null || !hasMore || topReadFailed) setResumeReview(false);
  }, [resumeReview, firstVersionId, hasMore, topReadFailed]);

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
      const epochAtSend = listEpoch.current;
      // A page read on its way was aimed at an offset this verdict is about to
      // shift, and the server may answer it from either side of the commit.
      // Drop it now and ask again once the verdict is in.
      const readDroppedAtSend = dropReadsInFlight();
      setDeciding(true);
      const client = createGraphQLHttpClient(token);
      try {
        const outcome = await sendVerdict(client, item.versionId, decision);
        const {
          status: shownStatus,
          items: shownItems,
          hasMore: shownHasMore,
          selectedId: shownSelectedId,
        } = shown.current;
        const listReplaced = listEpoch.current !== epochAtSend;

        if (outcome.kind === 'failed') {
          setSnackbar(t('sprayTraining.snackbar.failed'));
          // Nothing moved on the server, so the read that was dropped goes out again as it was.
          if (readDroppedAtSend && !listReplaced) void fetchPage(shownItems.length, shownStatus);
          return;
        }

        if (outcome.kind === 'refused') setSnackbar(t('sprayTraining.snackbar.notEligible'));
        else if (decision.status === 'APPROVED') setSnackbar(t('sprayTraining.snackbar.approved'));
        else if (decision.status === 'REJECTED') setSnackbar(t('sprayTraining.snackbar.rejected'));
        else setSnackbar(t('sprayTraining.snackbar.reset'));

        if (listReplaced) {
          // The reviewer moved to another tab while this saved. That tab was
          // read around the commit and may sit on either side of it, so ask the
          // server again instead of patching a list this verdict was not given on.
          void fetchPage(0, shownStatus);
          return;
        }

        // Anything that started while the verdict saved was read around the commit too.
        const readDropped = dropReadsInFlight() || readDroppedAtSend;

        if (outcome.kind === 'saved' && decision.status === shownStatus) {
          // Same verdict, new reason or notes: the wall stays on this tab.
          const { review } = outcome;
          setItems((previous) =>
            previous.map((entry) => (entry.versionId === item.versionId ? { ...entry, review } : entry)),
          );
          if (readDropped) void fetchPage(shownItems.length, shownStatus);
          return;
        }

        // The wall leaves this tab.
        const index = shownItems.findIndex((entry) => entry.versionId === item.versionId);
        const remaining = shownItems.filter((entry) => entry.versionId !== item.versionId);
        setItems((previous) => previous.filter((entry) => entry.versionId !== item.versionId));
        if (shownSelectedId === item.versionId) {
          // Still the wall in the dialog, so the next one takes its slot. A
          // dialog the reviewer closed or moved to another wall stays as it is.
          const successor = remaining[Math.min(index, remaining.length - 1)];
          setSelectedId(successor ? successor.versionId : null);
          if (!successor && shownHasMore) setResumeReview(true);
        }
        // An emptied list reads its next page by itself.
        if (readDropped && remaining.length > 0) void fetchPage(remaining.length, shownStatus);

        if (outcome.kind === 'saved') {
          setTotals((previous) => ({
            ...previous,
            [totalsKey(shownStatus)]: Math.max(0, previous[totalsKey(shownStatus)] - 1),
            [totalsKey(decision.status)]: previous[totalsKey(decision.status)] + 1,
          }));
          return;
        }

        // Refused. Count the wall out now, so that whichever server count lands
        // next (this read, or the page an emptied list asks for) is the last
        // word and nothing is subtracted twice.
        setTotals((previous) => ({
          ...previous,
          [totalsKey(shownStatus)]: Math.max(0, previous[totalsKey(shownStatus)] - 1),
        }));
        // Still under `deciding`: a verdict saved while this read was in flight
        // would leave the counts off by one.
        try {
          const fresh = await client.request<GetSprayTrainingTotalsQueryResponse, GetSprayTrainingTotalsQueryVariables>(
            GET_SPRAY_TRAINING_TOTALS,
            { status: shownStatus },
          );
          setTotals(fresh.sprayTrainingQueue.totals);
        } catch (totalsError) {
          console.error('[SprayTrainingPanel] Failed to refresh totals:', totalsError);
        }
      } finally {
        setDeciding(false);
      }
    },
    [token, fetchPage, dropReadsInFlight, t],
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

      {failedOffset !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => fetchPage(items.length, status)}
              // A page read that starts while a verdict saves is aimed at an offset about to shift.
              disabled={deciding}
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

      {items.length === 0 && !loading && failedOffset === null && !hasMore && (
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
            disabled={loading || deciding}
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
