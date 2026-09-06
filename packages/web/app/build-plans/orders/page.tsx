import React from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { GET_MY_CNC_ORDERS, type GetMyCncOrdersQueryResponse } from '@boardsesh/graphql/operations/cnc-packs';
import type { CncOrder } from '@boardsesh/shared-schema';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { fetchCncCatalog, requireCncPacksFlag } from '../build-plans-page';
import styles from '../build-plans.module.css';
import OrdersList from './orders-list';

/** Somebody's purchase history. Never cached, never shared, never static. */
export const dynamic = 'force-dynamic';

const ORDERS_PATH = '/build-plans/orders';

/**
 * `noindex, follow`, and this one stays that way after launch: a page that
 * lists what one person bought is a utility surface, not a search surface. The
 * TODO on `/build-plans` does not apply here.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('cnc');
  return createNoIndexMetadata({
    title: t('metadata.orders.title'),
    description: t('metadata.orders.description'),
    path: ORDERS_PATH,
    locale,
  });
}

export default async function BuildPlansOrdersPage() {
  await requireCncPacksFlag();

  // `getServerAuthToken` is BOTH the session read and the credential: it
  // returns the next-auth session cookie, which is what the backend accepts as
  // a Bearer token. `getServerSession(authOptions)` would decode the same
  // cookie a second time and still leave this page needing the raw value for
  // the GraphQL call, so it is deliberately not used here.
  const authToken = await getServerAuthToken();
  if (!authToken) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(ORDERS_PATH)}`);
  }

  const { t, locale } = await getServerTranslation('cnc');

  // The catalogue is only here to turn a size id into a wall label. A failed
  // fetch costs the label, not the list — an order still shows its licence id,
  // status and date, which is what someone came to check.
  const [ordersResult, catalog] = await Promise.all([
    executeAuthenticatedGraphQL<GetMyCncOrdersQueryResponse>(GET_MY_CNC_ORDERS, undefined, authToken)
      .then((response) => ({ ok: true as const, orders: response.myCncOrders }))
      .catch((error: unknown) => {
        console.error('myCncOrders failed:', error);
        return { ok: false as const, orders: [] as CncOrder[] };
      }),
    fetchCncCatalog(),
  ]);

  return (
    <I18nProvider locale={locale} namespaces={['common', 'cnc']}>
      <Box component="main" className={styles.page}>
        <Typography variant="h1" className={styles.heroTitle}>
          {t('orders.heading')}
        </Typography>
        <Typography variant="body1" className={styles.heroSubtitle}>
          {t('orders.intro')}
        </Typography>

        {ordersResult.ok ? (
          <OrdersList orders={ordersResult.orders} catalog={catalog} locale={locale} />
        ) : (
          <Alert severity="error" sx={{ mt: 3 }}>
            {t('orders.loadError')}
          </Alert>
        )}
      </Box>
    </I18nProvider>
  );
}
