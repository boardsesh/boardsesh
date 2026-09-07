'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { getBoardDisplayName } from '@boardsesh/climb-actions';
import type { CncDownloadKind, CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import {
  CREATE_CNC_DOWNLOAD_GRANT,
  type CreateCncDownloadGrantMutationResponse,
  type CreateCncDownloadGrantMutationVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient, getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { cncErrorKey, type CncErrorKey } from '../../cnc-error';
import { createOrderDateFormatter } from '../../format-date';
import { finaliseHref, previewImageLabel, tierLabel } from '../../order-display';
import { KeyValueList, PageFrame, PreviewGallery, SectionCard, StatusChip, type KeyValueItem } from '../../ui';
import { orderRefetchInterval, useCncOrderPoll } from '../../use-cnc-order-poll';
import styles from '../orders.module.css';

/**
 * One order, both halves of its life: the free watermarked preview and, once it
 * has been finalised, the licensed pack.
 *
 * The preview never goes away. A buyer who has paid still sees the sheets they
 * approved — that is what they checked before spending money, and hiding it the
 * moment the invoice lands is how a support ticket starts.
 */

/**
 * `true` only for a well-formed URL on the backend this client already talks
 * to, derived from the same helper that builds the GraphQL endpoint so the two
 * can never drift apart.
 *
 * The grant URL is a server-supplied string that goes straight into
 * `window.location`, so it gets the same origin pin as the Stripe redirect.
 * The parse is guarded: a malformed URL must show the buyer an error, not
 * throw inside the click handler.
 */
export function isBackendDownloadUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(getGraphQLHttpUrl()).origin;
  } catch {
    return false;
  }
}

/**
 * The four stages an order walks, free half first.
 *
 * Four, not eight: the buyer does not care whether a job is queued or being
 * drawn, only whether the wait is the preview's or the pack's. The live status
 * chip in the header carries the finer detail.
 */
const TIMELINE_STEPS = ['preview', 'finalised', 'building', 'ready'] as const;
type TimelineStep = (typeof TIMELINE_STEPS)[number];

/**
 * How many steps are behind us. -1 means the preview is still being drawn.
 *
 * A `failed` order was paid, queued and picked up — it just never finished, so
 * it stops at "cutting the files" rather than resetting to nothing. A
 * `preview_failed` one never got past the first stage.
 */
export function timelineProgress(status: CncOrderStatus): number {
  switch (status) {
    case 'preview_queued':
    case 'preview_generating':
    case 'preview_failed':
      return -1;
    case 'preview_ready':
    case 'pending_payment':
    case 'cancelled':
      return 0;
    case 'queued':
      return 1;
    case 'generating':
    case 'failed':
      return 2;
    case 'ready':
    case 'refunded':
      return 3;
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
  const [pendingKind, setPendingKind] = useState<CncDownloadKind | null>(null);

  const licenceId = initialOrder.licenceId;
  const { order, isError } = useCncOrderPoll({ initialOrder, token });

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

  const handleDownload = useCallback(
    async (kind: CncDownloadKind) => {
      setDownloadErrorKey(null);
      setPendingKind(kind);
      try {
        const client = createGraphQLHttpClient(token);
        const response = await client.request<
          CreateCncDownloadGrantMutationResponse,
          CreateCncDownloadGrantMutationVariables
        >(CREATE_CNC_DOWNLOAD_GRANT, { licenceId, kind });
        const grantUrl = response.createCncDownloadGrant.url;
        if (!isBackendDownloadUrl(grantUrl)) {
          setDownloadErrorKey('generic');
          setPendingKind(null);
          return;
        }
        // A fresh grant on every click: it lasts five minutes, so a cached one is
        // a dead link most of the time. The navigation leaves the app, so the
        // pending flag is deliberately not cleared on the success path.
        window.location.assign(grantUrl);
      } catch (error) {
        setDownloadErrorKey(cncErrorKey(error));
        setPendingKind(null);
      }
    },
    [token, licenceId],
  );

  // Memoised on the locale alone: constructing an `Intl.DateTimeFormat` walks
  // the ICU locale data, and this component re-renders on every poll tick
  // while an order is moving. The options are a literal, so the formatter only
  // ever needs rebuilding when the locale changes — which is to say never,
  // within one page.
  const dateFormat = useMemo(
    () => createOrderDateFormatter(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  const progress = timelineProgress(order.status);
  const isPreviewRunning = order.status === 'preview_queued' || order.status === 'preview_generating';
  const showPreviewCard = order.hasPreview || isPreviewRunning;
  const failedSubject = encodeURIComponent(t('order.failed.subject', { licenceId }));
  const previewFailedSubject = encodeURIComponent(t('order.previewFailed.subject', { licenceId }));

  const facts: KeyValueItem[] = [
    { key: 'board', label: t('order.board'), value: `${getBoardDisplayName(order.boardName)} ${wallLabel}` },
    { key: 'tier', label: t('order.tier'), value: tierLabel(order.tier, t) },
  ];
  // Chronological, because these are two moments in one order's life and a
  // "drawn at" above a "started at" reads as a mistake.
  facts.push({ key: 'placed', label: t('order.placed'), value: dateFormat.format(new Date(order.createdAt)) });
  if (order.previewGeneratedAt) {
    facts.push({
      key: 'previewed',
      label: t('order.previewed'),
      value: dateFormat.format(new Date(order.previewGeneratedAt)),
    });
  }
  if (order.zipSizeBytes !== null) {
    facts.push({
      key: 'size',
      label: t('order.size'),
      value: t('order.sizeValue', { megabytes: Math.max(1, Math.round(order.zipSizeBytes / 1_000_000)) }),
    });
  }
  // Preview downloads are not counted, so this figure only means anything once
  // there is a licensed pack to download.
  if (order.tier !== null) {
    facts.push({ key: 'downloads', label: t('order.downloads'), value: String(order.downloadCount) });
  }

  return (
    <PageFrame
      eyebrow={
        <Box className={styles.eyebrowRow}>
          <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2">
            {t('order.back')}
          </MuiLink>
          {/* i18n-keep cnc:status.preview_generating */}
          <StatusChip status={order.status} label={t(`status.${order.status}`)} />
        </Box>
      }
      title={<span className={styles.licenceTitle}>{order.licenceId}</span>}
    >
      {checkoutOutcome || isError ? (
        <Box className={styles.alertStack}>
          {checkoutOutcome === 'success' && (
            <Alert severity="success" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
              {t('order.checkoutSuccess')}
            </Alert>
          )}
          {checkoutOutcome === 'cancelled' && (
            <Alert severity="info" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
              {t('order.checkoutCancelled')}
            </Alert>
          )}
          {isError && (
            <Alert severity="error" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
              {t('order.loadError')}
            </Alert>
          )}
        </Box>
      ) : null}

      <SectionCard title={t('order.facts.heading')} headingLevel="h2">
        <KeyValueList items={facts} aria-label={t('order.facts.heading')} />
      </SectionCard>

      <SectionCard title={t('order.timeline.heading')} headingLevel="h2">
        <Box component="ol" className={styles.timeline}>
          {TIMELINE_STEPS.map((step, index) => {
            const done = index <= progress;
            return (
              <Box component="li" key={step} className={styles.timelineStep}>
                <Box aria-hidden className={`${styles.timelineDot} ${done ? styles.timelineDotDone : ''}`} />
                <Typography
                  variant="body2"
                  component="p"
                  className={`${styles.timelineLabel} ${done ? '' : styles.timelineLabelPending}`}
                >
                  {/* i18n-keep cnc:order.timeline.preview */}
                  {t(`order.timeline.${step satisfies TimelineStep}`)}
                </Typography>
              </Box>
            );
          })}
        </Box>
        {orderRefetchInterval(order.status) !== false && (
          <Typography variant="body2" component="p" className={styles.timelineNote}>
            {isPreviewRunning ? t('order.previewWaiting') : t('order.waiting')}
          </Typography>
        )}
      </SectionCard>

      {showPreviewCard && (
        <SectionCard
          title={t('order.preview.heading')}
          description={t('order.preview.note')}
          headingLevel="h2"
          tone={order.status === 'preview_ready' ? 'accent' : 'default'}
        >
          {order.previewImages.length > 0 ? (
            <PreviewGallery
              images={order.previewImages.map((image) => ({
                name: image.name,
                url: image.url,
                label: previewImageLabel(image.name, t),
              }))}
              aria-label={t('order.preview.heading')}
            />
          ) : (
            <Typography variant="body2" component="p" sx={{ color: 'var(--neutral-500)' }}>
              {t('order.preview.drawing')}
            </Typography>
          )}

          {(order.hasPreview || order.status === 'preview_ready') && (
            <Box className={styles.cardActions} sx={{ mt: order.previewImages.length > 0 ? 3 : 2 }}>
              {order.status === 'preview_ready' && (
                <Button component={LocaleLink} href={finaliseHref(order.licenceId)} variant="contained" size="large">
                  {t('order.finalise')}
                </Button>
              )}
              {order.hasPreview && (
                <Button
                  variant="outlined"
                  onClick={() => void handleDownload('PREVIEW')}
                  disabled={pendingKind !== null || !token}
                >
                  {pendingKind === 'PREVIEW' ? t('order.downloading') : t('order.downloadPreview')}
                </Button>
              )}
            </Box>
          )}
        </SectionCard>
      )}

      {order.status === 'ready' && (
        <SectionCard
          title={t('order.downloadCard.heading')}
          description={t('order.downloadCard.note')}
          headingLevel="h2"
        >
          <Button
            variant="contained"
            size="large"
            onClick={() => void handleDownload('FULL')}
            disabled={pendingKind !== null || !token}
          >
            {pendingKind === 'FULL' ? t('order.downloading') : t('order.download')}
          </Button>
        </SectionCard>
      )}

      {downloadErrorKey && (
        <Alert severity="error" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
          {t('order.downloadError')}
        </Alert>
      )}

      {order.status === 'preview_failed' && (
        <Alert severity="error" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
          <Typography variant="subtitle2" component="p" sx={{ fontWeight: 600 }}>
            {t('order.previewFailed.heading')}
          </Typography>
          <Typography variant="body2" component="p">
            {t('order.previewFailed.body')}
          </Typography>
          <MuiLink href={`mailto:${SUPPORT_EMAIL}?subject=${previewFailedSubject}`} variant="body2">
            {t('order.previewFailed.contact')}
          </MuiLink>
        </Alert>
      )}

      {order.status === 'failed' && (
        <Alert severity="error" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
          <Typography variant="subtitle2" component="p" sx={{ fontWeight: 600 }}>
            {t('order.failed.heading')}
          </Typography>
          {/* The backend replaces the generator's real error with one fixed
              public sentence — internal paths and module names never reach a
              buyer — so this renders `errorMessage` verbatim rather than
              mapping it. */}
          {order.errorMessage && (
            <Typography variant="body2" component="p">
              {order.errorMessage}
            </Typography>
          )}
          <MuiLink href={`mailto:${SUPPORT_EMAIL}?subject=${failedSubject}`} variant="body2">
            {t('order.failed.contact')}
          </MuiLink>
        </Alert>
      )}

      {order.status === 'refunded' && (
        <Alert severity="warning" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
          <Typography variant="subtitle2" component="p" sx={{ fontWeight: 600 }}>
            {t('order.refunded.heading')}
          </Typography>
          <Typography variant="body2" component="p">
            {t('order.refunded.body')}
          </Typography>
        </Alert>
      )}
    </PageFrame>
  );
}
