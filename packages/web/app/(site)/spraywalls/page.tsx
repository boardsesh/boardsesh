import BoardAppGuideLink from '@/app/components/marketing/board-app-guide-link';
import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, PageCard, Prose } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('website');
  return createPageMetadata({ title: t('sprayTitle'), description: t('sprayLead'), path: '/spraywalls', locale });
}

export default async function SprayWallsPage() {
  const [{ t }, labels] = await Promise.all([getServerTranslation('website'), getStoreButtonLabels()]);
  return (
    <PageShell title={t('sprayTitle')} lead={t('sprayLead')} width="wide">
      <StoreInstallButtons placement="spraywalls" labels={labels} align="start" />
      <Prose>{t('sprayNoLights')}</Prose>
      <MuiLink
        component={LocaleLink}
        href="/spraywalls/find"
        sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
      >
        {t('findSprayWall')}
      </MuiLink>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2, my: 4 }}>
        <PageCard>
          <Typography component="h2" variant="h5">
            {t('sprayStep1')}
          </Typography>
        </PageCard>
        <PageCard>
          <Typography component="h2" variant="h5">
            {t('sprayStep2')}
          </Typography>
        </PageCard>
        <PageCard>
          <Typography component="h2" variant="h5">
            {t('sprayStep3')}
          </Typography>
        </PageCard>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 4,
          alignItems: 'start',
        }}
      >
        <Image
          src={resolveStaticAssetUrl('/images/help/spray-wall-photo.webp')}
          alt={t('sprayStep1')}
          width={1752}
          height={2047}
          sizes="(max-width: 760px) 90vw, 480px"
          className="website-wall-photo"
        />
        <PageSection title={t('photoPrivacy')}>
          <Prose>{t('sprayPrivacy')}</Prose>
          <Prose>{t('sprayTraining')}</Prose>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'start', gap: 2, mt: 3 }}>
            <BoardAppGuideLink board="spray" />
            <MuiLink component={LocaleLink} href="/help/spray-walls">
              {t('photoGuide')}
            </MuiLink>
            <MuiLink component={LocaleLink} href="/privacy">
              {t('privacyPolicy')}
            </MuiLink>
            <MuiLink component={LocaleLink} href="/boards">
              {t('compatibility')}
            </MuiLink>
          </Box>
        </PageSection>
      </Box>
    </PageShell>
  );
}
