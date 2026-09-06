import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { getBoardDisplayName } from '@boardsesh/climb-actions';
import type { CncCatalog, CncOrder } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import { orderStatusChipColor, wallLabel } from '../order-display';
import styles from '../build-plans.module.css';

/**
 * The buyer's purchased packs, newest first.
 *
 * Server-rendered: this list never changes while it is on screen (a status
 * moves on the DETAIL page, which polls), so it needs no client bundle at all.
 * The link into each order is a real anchor via `LocaleLink`, not a click
 * handler, so it opens in a new tab and survives a keyboard.
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
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  if (orders.length === 0) {
    return (
      <Box sx={{ mt: 3 }}>
        <Typography variant="body1" sx={{ mb: 1.5 }}>
          {t('orders.empty')}
        </Typography>
        <Button component={LocaleLink} href="/build-plans" variant="contained" sx={{ textTransform: 'none' }}>
          {t('orders.emptyCta')}
        </Button>
      </Box>
    );
  }

  return (
    <Box className={styles.orderList}>
      {orders.map((order) => (
        <Card key={order.licenceId} className={styles.orderCard} variant="outlined">
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
                {order.licenceId}
              </Typography>
              <Chip size="small" color={orderStatusChipColor(order.status)} label={t(`status.${order.status}`)} />
            </Stack>

            <Box className={styles.orderMeta}>
              <OrderField
                label={t('orders.board')}
                value={`${getBoardDisplayName(order.boardName)} ${wallLabel(catalog, order)}`}
              />
              <OrderField
                label={t('orders.tier')}
                value={order.tier === 'personal' ? t('tiers.personal.name') : t('tiers.commercial.name')}
              />
              <OrderField label={t('orders.created')} value={dateFormat.format(new Date(order.createdAt))} />
            </Box>

            <Button
              component={LocaleLink}
              href={`/build-plans/orders/${order.licenceId}`}
              size="small"
              sx={{ mt: 1.5, textTransform: 'none' }}
            >
              {t('orders.view')}
            </Button>
          </CardContent>
        </Card>
      ))}
    </Box>
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
