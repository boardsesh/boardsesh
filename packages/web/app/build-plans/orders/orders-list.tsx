import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { getBoardDisplayName } from '@boardsesh/climb-actions';
import type { CncCatalog, CncOrder } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createOrderDateFormatter } from '../format-date';
import { finaliseHref, isPreviewStatus, newestPreviewReadyLicenceId, tierLabel, wallLabel } from '../order-display';
import { EmptyPanel, SectionCard, StatusChip } from '../ui';
import styles from './orders.module.css';

/**
 * Every wall this buyer has previewed or bought, newest first.
 *
 * Server-rendered: the list never changes while it is on screen (a status moves
 * on the DETAIL page, which polls), so it needs no client bundle at all. Each
 * row's link is a real anchor via `LocaleLink`, not a click handler, so it
 * middle-clicks and survives a keyboard.
 *
 * Exactly one row is allowed to shout: the newest `preview_ready` order, which
 * is the only one with something for the buyer to do. It takes the accent rule
 * and a "Finalise" link into the configurator; everything else is a quiet row
 * with an "Open" link.
 */
export default async function OrdersList({
  orders,
  catalog,
  locale,
}: {
  orders: readonly CncOrder[];
  catalog: CncCatalog | null;
  locale: string;
}) {
  const { t } = await getServerTranslation('cnc');
  const dateFormat = createOrderDateFormatter(locale, { dateStyle: 'medium' });

  if (orders.length === 0) {
    return (
      <EmptyPanel
        title={t('orders.empty')}
        body={t('orders.emptyBody')}
        action={
          <Button component={LocaleLink} href="/build-plans" variant="contained">
            {t('orders.emptyCta')}
          </Button>
        }
      />
    );
  }

  const finaliseLicenceId = newestPreviewReadyLicenceId(orders);

  return (
    <Box className={styles.rowList}>
      {orders.map((order) => {
        const isFinalisable = order.licenceId === finaliseLicenceId;
        // A free preview has no order date to speak of, so the row says when it
        // was drawn instead of pretending somebody ordered something.
        const dateLine = isPreviewStatus(order.status)
          ? t('orders.previewedOn', { date: dateFormat.format(new Date(order.createdAt)) })
          : t('orders.orderedOn', { date: dateFormat.format(new Date(order.createdAt)) });

        return (
          <SectionCard
            key={order.licenceId}
            component="article"
            padding="tight"
            tone={isFinalisable ? 'accent' : 'default'}
          >
            <Box className={styles.row}>
              <Box className={styles.rowMain}>
                <Typography component="p" className={styles.licenceId}>
                  {order.licenceId}
                </Typography>
                <Typography variant="body2" component="p" className={styles.rowMeta}>
                  {`${getBoardDisplayName(order.boardName)} ${wallLabel(catalog, order)} · ${tierLabel(order.tier, t)}`}
                </Typography>
                <Typography variant="body2" component="p" className={styles.rowMeta}>
                  {dateLine}
                </Typography>
              </Box>

              <Box className={styles.rowSide}>
                {/* i18n-keep cnc:status.preview_queued */}
                <StatusChip status={order.status} label={t(`status.${order.status}`)} />
                {isFinalisable ? (
                  <MuiLink component={LocaleLink} href={finaliseHref(order.licenceId)} variant="body2">
                    {t('orders.finalise')}
                  </MuiLink>
                ) : (
                  <MuiLink
                    component={LocaleLink}
                    href={`/build-plans/orders/${order.licenceId}`}
                    variant="body2"
                    aria-label={t('orders.viewOne', { licenceId: order.licenceId })}
                  >
                    {t('orders.view')}
                  </MuiLink>
                )}
              </Box>
            </Box>
          </SectionCard>
        );
      })}
    </Box>
  );
}
