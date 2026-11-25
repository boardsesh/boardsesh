import React, { Suspense } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import AuthPageContent from '@/app/auth/login/auth-page-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('auth');
  return createNoIndexMetadata({
    title: t('metadata.login.title'),
    description: t('metadata.login.description'),
    path: '/auth/login',
    locale,
  });
}

function AuthPageFallback({ title }: { title: string }) {
  return (
    <Box
      component="main"
      aria-busy="true"
      sx={{
        pt: 'calc(var(--global-header-height) + var(--spacing-8))',
        px: 3,
        minHeight: '100vh',
        maxWidth: 448,
        mx: 'auto',
      }}
    >
      <Typography component="h1" variant="h4">
        {title}
      </Typography>
      <Skeleton variant="rounded" height={320} sx={{ mt: 3 }} />
    </Box>
  );
}

export default async function AuthPage() {
  const [locale, { t }] = await Promise.all([getLocale(), getServerTranslation('auth')]);
  return (
    <I18nProvider locale={locale} namespaces={['auth', 'marketing']} resourceKeys={{ marketing: ['home.hero'] }}>
      <Suspense fallback={<AuthPageFallback title={t('login.header')} />}>
        <AuthPageContent />
      </Suspense>
    </I18nProvider>
  );
}
