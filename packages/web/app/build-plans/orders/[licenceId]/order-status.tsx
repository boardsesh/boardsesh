'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { getBoardDisplayName } from '@boardsesh/climb-actions';
import type { CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import {
  CREATE_CNC_DOWNLOAD_GRANT,
  GET_CNC_ORDER,
  type CreateCncDownloadGrantMutationResponse,
  type CreateCncDownloadGrantMutationVariables,
  type GetCncOrderQueryResponse,
  type GetCncOrderQueryVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { themeTokens } from '@/app/theme/theme-config';
import { cncErrorKey, type CncErrorKey } from '../../cnc-error';
import { createOrderDateFormatter } from '../../format-date';
import { orderStatusChipColor } from '../../order-display';
import styles from '../../build-plans.module.css';

/**
 * How often an unfinished pack is re-checked.
 *
 * A pack takes a couple of minutes to cut, so five seconds is fast enough that
 * the page never feels stuck and slow enough that a buyer leaving the tab open
 * over lunch costs a few hundred requests, not a few hundred thousand.
 */
export const ORDER_POLL_INTERVAL_MS = 5_000;

/**
 * Statuses that are still moving on their own.
 *
 * `pending_payment` is NOT one of them, and that is the subtle case: it moves
 * only when Stripe's webhook lands, which happens within seconds of a
 * successful checkout — so it is polled too. What is deliberately excluded is
 * every TERMINAL status: `ready`, `failed`, `cancelled` and `refunded` never
 * change again without a human, so polling them is pure waste.
 */
const LIVE_STATUSES: readonly CncOrderStatus[] = ['pending_payment', 'queued', 'generating'];

/**
 * The React Query `refetchInterval` for one status: a number while the order is
 * still moving, `false` once it has settled.
 *
 * Exported because "does polling actually stop at `ready`" is the question
 * worth a test, and asserting it against a pure function beats waiting on
 * timers around a mounted component.
 */
export function orderRefetchInterval(status: CncOrderStatus): number | false {
  return LIVE_STATUSES.includes(status) ? ORDER_POLL_INTERVAL_MS : false;
}

/** The four steps a paid order walks, in order. */
const TIMELINE_STEPS = ['paid', 'queued', 'generating', 'ready'] as const;
type TimelineStep = (typeof TIMELINE_STEPS)[number];

/** How far along a status is. -1 means nothing has happened yet (unpaid). */
function timelineProgress(status: CncOrderStatus): number {
  switch (status) {
    case 'pending_payment':
    case 'cancelled':
      return -1;
    case 'queued':
      return 1;
    case 'generating':
      return 2;
    case 'ready':
    case 'refunded':
      return 3;
    // A failed order was paid, queued and picked up — it just never finished.
    // Showing it stalled at "cutting the files" is more honest than resetting
    // the timeline to nothing.
    case 'failed':
      return 2;
  }
}

const SUPPORT_EMAIL = 'support@boardsesh.com';

type OrderStatusProps = {
  /** Server-fetched, so the first paint already shows the real status. */
  initialOrder: CncOrder;
  wallLabel: string;
  checkoutOutcome: 'success' | 'cancelled' | null;
  locale: string;
};

export default function OrderStatus({ initialOrder, wallLabel, checkoutOutcome, locale }: OrderStatusProps) {
  const { t } = useTranslation('cnc');
  const { token } = useWsAuthToken();
  const router = useLocaleRouter();
  const pathnameWithoutLocale = usePathnameWithoutLocale();
  const [downloadErrorKey, setDownloadErrorKey] = useState<CncErrorKey | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const licenceId = initialOrder.licenceId;

  // The alert above already told the buyer what happened; a refresh or a
  // bookmark of this URL must not say it again. Strip `?checkout=` once the
  // outcome has been shown, the same "clean the param after rendering it"
  // pattern used for `?error=` on the login page.
  useEffect(() => {
    if (!checkoutOutcome) return;
    router.replace(pathnameWithoutLocale);
    // Runs once per mount with an outcome: `router` and `pathnameWithoutLocale`
    // are omitted on purpose, since re-running this on their identity would
    // fight the very replace it just performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query = useQuery({
    queryKey: ['cncOrder', licenceId] as const,
    queryFn: async () => {
      if (!token) throw new Error('OrderStatus: queryFn ran without a token');
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetCncOrderQueryResponse, GetCncOrderQueryVariables>(GET_CNC_ORDER, {
        licenceId,
      });
      return response.cncOrder;
    },
    initialData: initialOrder,
    // Without these two the server-rendered order is treated as infinitely old,
    // so React Query refetches it the instant the component mounts — one wasted
    // round trip per page load, on data that was fetched microseconds earlier
    // in the very same request. `staleTime` matches the poll interval because
    // that IS the freshness contract here; `refetchInterval` fires regardless
    // of staleness, so a live order still polls on time.
    initialDataUpdatedAt: () => Date.now(),
    staleTime: ORDER_POLL_INTERVAL_MS,
    enabled: !!token,
    // Re-read from the latest data on every tick, so the moment the pack turns
    // `ready` the next interval is `false` and the polling stops by itself.
    refetchInterval: (result) => (result.state.data ? orderRefetchInterval(result.state.data.status) : false),
  });

  const order = query.data ?? initialOrder;

  const handleDownload = useCallback(async () => {
    setDownloadErrorKey(null);
    setIsDownloading(true);
    try {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<
        CreateCncDownloadGrantMutationResponse,
        CreateCncDownloadGrantMutationVariables
      >(CREATE_CNC_DOWNLOAD_GRANT, { licenceId });
      // A fresh grant on every click: it lasts five minutes, so a cached one is
      // a dead link most of the time. The navigation leaves the app, so the
      // pending flag is deliberately not cleared on the success path.
      window.location.assign(response.createCncDownloadGrant.url);
    } catch (error) {
      setDownloadErrorKey(cncErrorKey(error));
      setIsDownloading(false);
    }
  }, [token, licenceId]);

  const dateFormat = createOrderDateFormatter(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const progress = timelineProgress(order.status);
  const failedSubject = encodeURIComponent(t('order.failed.subject', { licenceId }));

  return (
    <>
      <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2">
        {t('order.back')}
      </MuiLink>

      <Typography variant="h1" className={styles.heroTitle} sx={{ mt: 1 }}>
        {t('order.heading', { licenceId })}
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <Chip size="small" color={orderStatusChipColor(order.status)} label={t(`status.${order.status}`)} />
      </Stack>

      {checkoutOutcome === 'success' && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {t('order.checkoutSuccess')}
        </Alert>
      )}
      {checkoutOutcome === 'cancelled' && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('order.checkoutCancelled')}
        </Alert>
      )}
      {query.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {t('order.loadError')}
        </Alert>
      )}

      <Box className={styles.orderMeta}>
        <OrderField label={t('order.licence')} value={order.licenceId} />
        <OrderField label={t('order.board')} value={`${getBoardDisplayName(order.boardName)} ${wallLabel}`} />
        <OrderField
          label={t('order.tier')}
          value={order.tier === 'personal' ? t('tiers.personal.name') : t('tiers.commercial.name')}
        />
        <OrderField label={t('order.placed')} value={dateFormat.format(new Date(order.createdAt))} />
        {order.zipSizeBytes !== null && (
          <OrderField
            label={t('order.size')}
            value={t('order.sizeValue', { megabytes: Math.max(1, Math.round(order.zipSizeBytes / 1_000_000)) })}
          />
        )}
        <OrderField label={t('order.downloads')} value={String(order.downloadCount)} />
      </Box>

      <Box sx={{ mt: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
          {t('order.timeline.heading')}
        </Typography>
        <ol className={styles.timeline}>
          {TIMELINE_STEPS.map((step, index) => (
            <li key={step}>
              <Typography variant="body2" color={index <= progress ? 'text.primary' : 'text.secondary'}>
                {t(`order.timeline.${step satisfies TimelineStep}`)}
              </Typography>
            </li>
          ))}
        </ol>
        {orderRefetchInterval(order.status) !== false && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {t('order.waiting')}
          </Typography>
        )}
      </Box>

      {order.status === 'ready' && (
        <Box sx={{ mt: 3 }}>
          <Button
            variant="contained"
            size="large"
            onClick={() => void handleDownload()}
            disabled={isDownloading || !token}
            sx={{ textTransform: 'none' }}
          >
            {isDownloading ? t('order.downloading') : t('order.download')}
          </Button>
          {downloadErrorKey && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {t('order.downloadError')}
            </Alert>
          )}
        </Box>
      )}

      {order.status === 'failed' && (
        <Alert severity="error" sx={{ mt: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
            {t('order.failed.heading')}
          </Typography>
          {/* The backend replaces the generator's real error with one fixed
              public sentence — internal paths and module names never reach a
              buyer — so this renders `errorMessage` verbatim rather than
              mapping it. */}
          {order.errorMessage && <Typography variant="body2">{order.errorMessage}</Typography>}
          <MuiLink href={`mailto:${SUPPORT_EMAIL}?subject=${failedSubject}`} variant="body2">
            {t('order.failed.contact')}
          </MuiLink>
        </Alert>
      )}

      {order.status === 'refunded' && (
        <Alert severity="warning" sx={{ mt: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
            {t('order.refunded.heading')}
          </Typography>
          <Typography variant="body2">{t('order.refunded.body')}</Typography>
        </Alert>
      )}
    </>
  );
}

function OrderField({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" component="p">
        {label}
      </Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );
}
