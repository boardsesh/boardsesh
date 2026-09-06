import React from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { GET_CNC_ORDER, type GetCncOrderQueryResponse } from '@boardsesh/graphql/operations/cnc-packs';
import type { CncOrder } from '@boardsesh/shared-schema';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { CNC_FLAG_OFF_METADATA, fetchCncCatalog, isCncPacksEnabled, requireCncPacksFlag } from '../../build-plans-page';
import { wallLabel } from '../../order-display';
import styles from '../../build-plans.module.css';
import OrderStatus from './order-status';

/** One person's order, with a live status. Never cached, never static. */
export const dynamic = 'force-dynamic';

type OrderRouteProps = {
  params: Promise<{ licenceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const LICENCE_ID_LENGTH = 'BS-CNC-'.length + 6;

/**
 * The shape the backend mints: `BS-CNC-` plus six characters (see
 * `generateLicenceId` in `packages/backend/src/services/cnc/licence-id.ts`,
 * whose alphabet is a subset of this one — the route only needs to reject
 * junk, and the backend still answers null for anything it did not issue).
 *
 * Checked before the id reaches the login callback URL or the GraphQL
 * variables, so a crafted path cannot smuggle an arbitrary string through this
 * route. The explicit length check is not redundant with the anchored pattern:
 * `$` also matches before a trailing newline.
 */
const LICENCE_ID_PATTERN = /^BS-CNC-[A-Z0-9]{6}$/;

/**
 * `notFound()` rather than a 400: it matches what an unknown-but-well-formed
 * licence already gets, which keeps "no such order", "not your order" and "not
 * a licence id at all" indistinguishable from outside.
 */
function isLicenceIdShape(licenceId: string): boolean {
  return licenceId.length === LICENCE_ID_LENGTH && LICENCE_ID_PATTERN.test(licenceId);
}

/**
 * `noindex, follow`. Stays that way after launch — a purchase receipt is a
 * utility surface. The licence id is in the title because that is how a buyer
 * picks this tab out of five open ones.
 */
export async function generateMetadata(props: OrderRouteProps): Promise<Metadata> {
  if (!(await isCncPacksEnabled())) return CNC_FLAG_OFF_METADATA;

  const { licenceId } = await props.params;
  const { t, locale } = await getServerTranslation('cnc');
  return createNoIndexMetadata({
    title: t('metadata.order.title', { licenceId }),
    description: t('metadata.order.description'),
    path: `/build-plans/orders/${licenceId}`,
    locale,
  });
}

export default async function BuildPlanOrderPage(props: OrderRouteProps) {
  await requireCncPacksFlag();

  const { licenceId } = await props.params;
  if (!isLicenceIdShape(licenceId)) {
    notFound();
  }
  const searchParams = await props.searchParams;

  const authToken = await getServerAuthToken();
  if (!authToken) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(`/build-plans/orders/${licenceId}`)}`);
  }

  const { t, locale } = await getServerTranslation('cnc');

  // `cncOrder` answers null for a licence that does not exist AND for one that
  // belongs to somebody else — deliberately indistinguishable, so this page
  // must not treat them differently either.
  const [order, catalog] = await Promise.all([
    executeAuthenticatedGraphQL<GetCncOrderQueryResponse>(GET_CNC_ORDER, { licenceId }, authToken)
      .then((response) => response.cncOrder)
      .catch((error: unknown) => {
        console.error('cncOrder failed:', error);
        return null satisfies CncOrder | null;
      }),
    fetchCncCatalog(),
  ]);

  if (!order) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'cnc']}>
        <Box component="main" className={styles.page}>
          <Typography variant="h1" className={styles.heroTitle}>
            {t('order.notFound.heading')}
          </Typography>
          <Typography variant="body1" className={styles.heroSubtitle}>
            {t('order.notFound.body')}
          </Typography>
          <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2" sx={{ mt: 2, display: 'block' }}>
            {t('order.back')}
          </MuiLink>
        </Box>
      </I18nProvider>
    );
  }

  // `?checkout=success&checkout=cancelled` parses as an array, so take the
  // first entry rather than comparing an array to a string and silently
  // dropping the alert Stripe sent the buyer back for.
  const rawCheckoutParam = searchParams.checkout;
  const checkoutParam = Array.isArray(rawCheckoutParam) ? rawCheckoutParam[0] : rawCheckoutParam;
  const checkoutOutcome = checkoutParam === 'success' || checkoutParam === 'cancelled' ? checkoutParam : null;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'cnc']}>
      <Box component="main" className={styles.page}>
        <OrderStatus
          initialOrder={order}
          wallLabel={wallLabel(catalog, order)}
          checkoutOutcome={checkoutOutcome}
          locale={locale}
        />
      </Box>
    </I18nProvider>
  );
}
