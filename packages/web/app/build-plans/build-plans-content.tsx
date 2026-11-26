import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { KeyValueList, PageSection, PriceTag, SectionCard, StepHeading } from './ui';
import styles from './build-plans.module.css';

/**
 * Where a ten-build or OEM enquiry goes. A mailto rather than a form on
 * purpose: those deals are a conversation about what someone is building, and a
 * contact form would collect three fields and then need a human anyway.
 */
const PARTNERSHIPS_EMAIL = 'partnerships@boardsesh.com';

/**
 * Server-rendered instructions and licence scopes for the free generator.
 * This content stays available when the catalogue cannot be loaded.
 */
export default async function BuildPlansContent() {
  const { t } = await getServerTranslation('cnc');

  const contactHref = `mailto:${PARTNERSHIPS_EMAIL}?subject=${encodeURIComponent(t('tiers.contact.subject'))}`;

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
            <PriceTag amount={t('tiers.free')} note={t('tiers.perWall')} size="lg" />
            <Typography variant="body2" component="p" className={styles.tierBlurb}>
              {t('tiers.personal.blurb')}
            </Typography>
          </SectionCard>

          <SectionCard title={t('tiers.contact.heading')} description={t('tiers.contact.body')}>
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
