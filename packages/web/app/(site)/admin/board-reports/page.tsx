import React from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import { themeTokens } from '@/app/theme/theme-config';
import BoardReportsPanel from '@/app/components/admin/board-reports-panel';
import { readBoardReportsTab } from '@/app/components/admin/board-setup-changes-logic';
import LocaleLink from '@/app/components/i18n/locale-link';

// Server-rendered so admin access is enforced before any markup ships, like
// /admin/gym-claims. `adminDirectoryReports` and every action it offers are
// admin-gated on the backend too. The admin layout makes the page noindex.
export const dynamic = 'force-dynamic';

type AdminBoardReportsPageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** A report uuid from the daily digest's link (`?report=<uuid>`), or null. */
function readHighlightedReport(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && /^[0-9a-fA-F-]{36}$/.test(value) ? value : null;
}

export default async function AdminBoardReportsPage({ searchParams }: AdminBoardReportsPageProps) {
  const access = await checkAdmin();
  const locale = await getLocale();
  const { t } = await getServerTranslation('admin');

  if (!access.authenticated) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="warning">{t('auth.signInRequired')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  if (!access.isAdmin) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="error">{t(access.boardScopedOnly ? 'auth.boardScopedNoAccess' : 'auth.noAccess')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  const { report, tab } = await searchParams;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin', 'boards']}>
      <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Typography variant="h5" component="h1" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
          {t('boardReports.title')}
        </Typography>
        <Box sx={{ mb: 3 }}>
          <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ color: 'var(--color-primary)' }}>
            {t('boardReports.backToAdmin')}
          </MuiLink>
        </Box>
        <BoardReportsPanel highlightReportUuid={readHighlightedReport(report)} initialTab={readBoardReportsTab(tab)} />
      </Container>
    </I18nProvider>
  );
}
