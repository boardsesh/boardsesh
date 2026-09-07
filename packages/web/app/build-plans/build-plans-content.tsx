import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { CncCatalog, CncLicenceTier } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { formatPrice } from './configurator/configurator-state';
import { KeyValueList, PageSection, PriceTag, SectionCard, StepHeading } from './ui';
import styles from './build-plans.module.css';

/**
 * Where a ten-build or OEM enquiry goes. A mailto rather than a form on
 * purpose: those deals are a conversation about what someone is building, and a
 * contact form would collect three fields and then need a human anyway.
 */
const MULTI_BUILD_CONTACT_EMAIL = 'support@boardsesh.com';

/**
 * The server-rendered half of `/build-plans`: how the free preview works, what
 * lands in your account, and what a licence costs.
 *
 * Server, not client, and that is the point of splitting it from the
 * configurator. This is the copy a search engine and a first paint see — real
 * paragraphs, real prices, and crawlable links to the licence and to the
 * buyer's own orders — none of which should wait on hydration or on a flag the
 * browser has to resolve for itself.
 *
 * Prices are formatted from the catalogue's `amountCents` with the request's
 * own locale, so the number on the page is the number Stripe will charge, in
 * the currency the catalogue set it in.
 *
 * Reading order is the buying order: how it works (three steps, because it
 * genuinely is a sequence — nothing else on this surface is numbered), what you
 * get, what it costs, then the configurator. The page's one filled button sits
 * in the header and jumps to `#configure`; everything on the way down is a text
 * link.
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

  const flowSteps = [
    { key: 'configure', title: t('flow.configure.title'), body: t('flow.configure.body') },
    { key: 'preview', title: t('flow.preview.title'), body: t('flow.preview.body') },
    { key: 'finalise', title: t('flow.finalise.title'), body: t('flow.finalise.body') },
  ];

  const included = [
    { key: 'dxf', label: t('hero.included.dxfLabel'), value: t('hero.included.dxf') },
    { key: 'pdf', label: t('hero.included.pdfLabel'), value: t('hero.included.pdf') },
    { key: 'bom', label: t('hero.included.bomLabel'), value: t('hero.included.bom') },
    { key: 'licence', label: t('hero.included.licenceLabel'), value: t('hero.included.licence') },
  ];

  const personalPrice = priceFor('personal');
  const commercialPrice = priceFor('commercial_single');

  return (
    <>
      <PageSection id="how-it-works" title={t('flow.heading')} intro={t('flow.intro')}>
        <Box className={styles.flowGrid}>
          {flowSteps.map((flowStep, index) => (
            <SectionCard key={flowStep.key} padding="tight">
              <StepHeading step={index + 1} title={flowStep.title} description={flowStep.body} />
            </SectionCard>
          ))}
        </Box>
      </PageSection>

      <PageSection id="what-you-get" title={t('hero.included.heading')}>
        <SectionCard>
          <KeyValueList items={included} columns={2} layout="stacked" />
        </SectionCard>
      </PageSection>

      <PageSection id="licences" title={t('tiers.heading')} intro={t('tiers.intro')}>
        <Box className={styles.tierGrid}>
          <SectionCard title={t('tiers.personal.name')}>
            {personalPrice && <PriceTag amount={personalPrice} note={t('tiers.perWall')} size="lg" />}
            <Typography variant="body2" component="p" className={styles.tierBlurb}>
              {t('tiers.personal.blurb')}
            </Typography>
          </SectionCard>

          <SectionCard title={t('tiers.commercial.name')}>
            {commercialPrice && <PriceTag amount={commercialPrice} note={t('tiers.perWall')} size="lg" />}
            <Typography variant="body2" component="p" className={styles.tierBlurb}>
              {t('tiers.commercial.blurb')}
            </Typography>
          </SectionCard>
        </Box>

        <Box className={styles.contactRow}>
          <SectionCard tone="quiet" title={t('tiers.contact.heading')} description={t('tiers.contact.body')}>
            <MuiLink href={contactHref} variant="body2">
              {t('tiers.contact.cta')}
            </MuiLink>
          </SectionCard>
        </Box>
      </PageSection>
    </>
  );
}

/**
 * The header block's actions, rendered by the page into `PageFrame`.
 *
 * Split out from the body so the frame owns where they sit: the primary button
 * and the two crawlable links belong above the fold, on the plate, not halfway
 * down the page after the prices.
 */
export async function BuildPlansHeaderActions() {
  const { t } = await getServerTranslation('cnc');
  return (
    <>
      <Button component="a" href="#configure" variant="contained" size="large">
        {t('hero.cta')}
      </Button>
      <MuiLink component={LocaleLink} href="/build-plans/licence" variant="body2">
        {t('tiers.licenceLink')}
      </MuiLink>
      <MuiLink component={LocaleLink} href="/build-plans/orders" variant="body2">
        {t('tiers.ordersLink')}
      </MuiLink>
    </>
  );
}
