'use client';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import LocaleLink from '@/app/components/i18n/locale-link';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { useConsent } from './consent-provider';

export default function ConsentBanner() {
  const { t } = useTranslation('consent');
  const { decide, dialogOpen, closeChoices, syncFailed } = useConsent();
  const pathname = usePathnameWithoutLocale();
  if (isChromeLessPath(pathname.toLowerCase())) return null;
  const choose = (choice: 'granted' | 'denied') => {
    void decide(choice);
    closeChoices();
  };
  const copy = (
    <>
      <Typography variant="body2" color="text.secondary">
        {t('body')}
      </Typography>
      <MuiLink component={LocaleLink} href="/privacy">
        {t('privacyLink')}
      </MuiLink>
    </>
  );
  return (
    <>
      <Box
        className="analytics-consent-banner"
        role="region"
        aria-labelledby="consent-banner-title"
        data-testid="consent-banner"
        sx={{
          position: 'fixed',
          zIndex: (theme) => theme.zIndex.tooltip,
          bottom: 0,
          left: 0,
          right: 0,
          p: { xs: 1, sm: 2 },
          pb: 'max(8px, env(safe-area-inset-bottom))',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <Paper elevation={8} sx={{ p: 2, maxWidth: 600, width: '100%' }}>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2" id="consent-banner-title">
              {t('title')}
            </Typography>
            {copy}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button variant="outlined" fullWidth onClick={() => choose('granted')}>
                {t('allow')}
              </Button>
              <Button variant="outlined" fullWidth onClick={() => choose('denied')}>
                {t('deny')}
              </Button>
            </Stack>
          </Stack>
        </Paper>
      </Box>
      <Dialog open={dialogOpen} onClose={closeChoices} fullWidth maxWidth="sm">
        <DialogTitle>{t('privacyChoices')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {copy}
            {syncFailed && <Typography role="status">{t('syncError')}</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeChoices}>{t('close')}</Button>
          <Button variant="outlined" onClick={() => choose('granted')}>
            {t('allow')}
          </Button>
          <Button variant="outlined" onClick={() => choose('denied')}>
            {t('deny')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
