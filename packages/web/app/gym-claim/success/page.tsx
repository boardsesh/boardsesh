import React from 'react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Button from '@mui/material/Button';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutline';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import LocaleLink from '@/app/components/i18n/locale-link';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('boards');
  return createNoIndexMetadata({
    title: t('claimLanding.success.title'),
    description: t('claimLanding.success.body'),
    path: '/gym-claim/success',
    locale,
  });
}

// A gym slug or UUID is lowercase alphanumerics + hyphens. Validate the param
// before putting it in an href so a crafted value can't build a `../`-style path.
const GYM_REF_PATTERN = /^[a-z0-9-]{1,120}$/;

export default async function GymClaimSuccessPage({ searchParams }: { searchParams: Promise<{ gym?: string }> }) {
  const locale = await getLocale();
  const { t } = await getServerTranslation('boards');
  const { gym } = await searchParams;
  const gymRef = gym && GYM_REF_PATTERN.test(gym) ? gym : null;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards']}>
      <Container
        maxWidth="sm"
        sx={{
          py: 8,
          pt: 'calc(var(--global-header-height) + 48px)',
          textAlign: 'center',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <CheckCircleOutlined color="success" sx={{ fontSize: 56 }} />
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {t('claimLanding.success.title')}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t('claimLanding.success.body')}
          </Typography>
          {gymRef && (
            <Button
              component={LocaleLink}
              href={`/gym/${gymRef}/manage`}
              variant="contained"
              size="large"
              startIcon={<SettingsOutlined />}
              sx={{ mt: 1, textTransform: 'none' }}
            >
              {t('claimLanding.success.setupCta')}
            </Button>
          )}
          <MuiLink component={LocaleLink} href="/" underline="hover">
            {t('claimLanding.backHome')}
          </MuiLink>
        </Box>
      </Container>
    </I18nProvider>
  );
}
