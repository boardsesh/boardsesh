import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { CncCatalog, CncLicenceTier } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import { formatPrice } from './configurator/configurator-state';
import styles from './build-plans.module.css';

/**
 * Where a ten-build or OEM enquiry goes. A mailto rather than a form on
 * purpose: those deals are a conversation about what someone is building, and a
 * contact form would collect three fields and then need a human anyway.
 */
const MULTI_BUILD_CONTACT_EMAIL = 'support@boardsesh.com';

/**
 * The server-rendered half of `/build-plans`: heading, what you get, and what
 * the two licences cost.
 *
 * Server, not client, and that is the point of splitting it from the
 * configurator. This is the copy a search engine and a first paint see — an h1,
 * real paragraphs, real prices, and crawlable links to the licence and to the
 * buyer's own orders — none of which should wait on hydration or on a flag the
 * browser has to resolve for itself.
 *
 * Prices are formatted from the catalogue's `amountCents` with the request's
 * own locale, so the number on the page is the number Stripe will charge, in
 * the currency the catalogue set it in.
 */
export default async function BuildPlansContent({ catalog, locale }: { catalog: CncCatalog | null; locale: string }) {
  const { t } = await getServerTranslation('cnc');

  // Every entry carries the same two tier prices today. Taking them from the
  // first entry rather than the tier list of whichever wall is selected keeps
  // this component free of configurator state; the configurator shows the price
  // for the wall actually chosen.
  const tiers = catalog?.entries[0]?.tiers ?? [];
  const priceFor = (tier: CncLicenceTier): string | null => {
    const price = tiers.find((candidate) => candidate.tier === tier);
    return price ? formatPrice(price.amountCents, price.currency, locale) : null;
  };

  const contactHref = `mailto:${MULTI_BUILD_CONTACT_EMAIL}?subject=${encodeURIComponent(t('tiers.contact.subject'))}`;

  return (
    <>
      <Box component="section" className={styles.hero}>
        <Typography variant="h1" className={styles.heroTitle}>
          {t('hero.title')}
        </Typography>
        <Typography variant="body1" className={styles.heroSubtitle}>
          {t('hero.subtitle')}
        </Typography>
        <Typography variant="body2" component="p" className={styles.firstBoard}>
          {t('hero.firstBoard')}
        </Typography>

        <Box sx={{ mt: 3 }}>
          <Typography variant="h2" className={styles.sectionHeading}>
            {t('hero.included.heading')}
          </Typography>
          <ul className={styles.includedList}>
            <li>
              <Typography variant="body1" component="span">
                {t('hero.included.dxf')}
              </Typography>
            </li>
            <li>
              <Typography variant="body1" component="span">
                {t('hero.included.pdf')}
              </Typography>
            </li>
            <li>
              <Typography variant="body1" component="span">
                {t('hero.included.bom')}
              </Typography>
            </li>
            <li>
              <Typography variant="body1" component="span">
                {t('hero.included.licence')}
              </Typography>
            </li>
          </ul>
        </Box>
      </Box>

      <Box component="section">
        <Typography variant="h2" className={styles.sectionHeading}>
          {t('tiers.heading')}
        </Typography>
        <Typography variant="body1" sx={{ mb: 2 }}>
          {t('tiers.intro')}
        </Typography>

        <Box className={styles.tierGrid}>
          <Card className={styles.tierCard} variant="outlined">
            <CardContent>
              <Typography variant="h3" className={styles.sectionHeading}>
                {t('tiers.personal.name')}
              </Typography>
              {priceFor('personal') && (
                <Typography
                  variant="h4"
                  className={styles.tierPrice}
                  sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}
                >
                  {priceFor('personal')}
                </Typography>
              )}
              <Typography variant="body2" color="text.secondary">
                {t('tiers.personal.blurb')}
              </Typography>
            </CardContent>
          </Card>

          <Card className={styles.tierCard} variant="outlined">
            <CardContent>
              <Typography variant="h3" className={styles.sectionHeading}>
                {t('tiers.commercial.name')}
              </Typography>
              {priceFor('commercial_single') && (
                <Typography
                  variant="h4"
                  className={styles.tierPrice}
                  sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}
                >
                  {priceFor('commercial_single')}
                </Typography>
              )}
              <Typography variant="body2" color="text.secondary">
                {t('tiers.commercial.blurb')}
              </Typography>
            </CardContent>
          </Card>
        </Box>

        <Card className={styles.contactCard} variant="outlined" sx={{ mt: 2 }}>
          <CardContent>
            <Typography variant="h3" className={styles.sectionHeading}>
              {t('tiers.contact.heading')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {t('tiers.contact.body')}
            </Typography>
            <MuiLink href={contactHref} variant="body2">
              {t('tiers.contact.cta')}
            </MuiLink>
          </CardContent>
        </Card>

        <Stack direction="row" spacing={3} sx={{ mt: 2 }} flexWrap="wrap">
          <MuiLink component={LocaleLink} href="/build-plans/licence" variant="body2">
            {t('tiers.licenceLink')}
          </MuiLink>
          <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2">
            {t('tiers.ordersLink')}
          </MuiLink>
        </Stack>
      </Box>

      <Typography variant="body2" color="text.secondary" className={styles.trademarkNote}>
        {t('hero.trademarkNote')}
      </Typography>
    </>
  );
}
