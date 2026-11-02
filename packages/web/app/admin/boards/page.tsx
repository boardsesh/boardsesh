import React from 'react';
import Alert from '@mui/material/Alert';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import AdminBoardsPanel from '@/app/components/admin/admin-boards-panel';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { themeTokens } from '@/app/theme/theme-config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('admin');
  return createNoIndexMetadata({
    title: t('boards.title'),
    description: t('boards.description'),
    path: '/admin/boards',
    locale,
  });
}

export default async function AdminBoardsPage() {
  const access = await checkAdmin();
  const { t, locale } = await getServerTranslation('admin');
  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin', 'boards']}>
      <Container maxWidth="lg" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        {!access.authenticated ? (
          <Alert severity="warning">{t('auth.signInRequired')}</Alert>
        ) : !access.isAdmin ? (
          <Alert severity="error">{t(access.boardScopedOnly ? 'auth.boardScopedNoAccess' : 'auth.noAccess')}</Alert>
        ) : (
          <>
            <Typography component="h1" variant="h5" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
              {t('boards.title')}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1, mb: 2 }}>
              {t('boards.description')}
            </Typography>
            <AdminBoardsPanel viewerUserId={access.userId} />
          </>
        )}
      </Container>
    </I18nProvider>
  );
}
