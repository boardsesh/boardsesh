import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { themeTokens } from '@/app/theme/theme-config';
import '@/app/components/index.css';

export const metadata: Metadata = { title: '404 | Boardsesh', robots: { index: false, follow: true } };

/** Multiple document roots need one complete fallback for URLs outside every route. */
export default async function GlobalNotFound() {
  const { t } = await getServerTranslationForLocale(DEFAULT_LOCALE, 'common');
  return (
    <html lang="en" data-theme="dark">
      <body>
        <Box
          component="main"
          sx={{
            minHeight: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: themeTokens.semantic.background,
            color: themeTokens.neutral[900],
          }}
        >
          <Typography component="h1" variant="h3">
            404
          </Typography>
          <MuiLink href="/" color="inherit">
            {t('ariaLabels.home')}
          </MuiLink>
        </Box>
      </body>
    </html>
  );
}
