'use client';
import { useEffect, type ReactNode } from 'react';
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
import { useConsent } from './consent-state-provider';
import { useConsentRegionPromptState, type ConsentRegionPromptState } from './use-consent-region-prompt';

export default function ConsentBanner({ children }: { children?: (region: ConsentRegionPromptState) => ReactNode }) {
  const { t } = useTranslation('consent');
  const { decide, dialogOpen, openChoices, closeChoices, syncFailed, reportPromptShowing } = useConsent();
  const pathname = usePathnameWithoutLocale();
  const chromeLess = isChromeLessPath(pathname.toLowerCase());
  // The banner asks only in the prompt regions (or an unknown one). Privacy
  // choices in the footer and Settings open the dialog below for everyone.
  // The welcome consumes this same lookup state, including focus refreshes.
  const region = useConsentRegionPromptState(!chromeLess);
  // The card is up, or may still come up while the region lookup is out.
  const promptShowing = region.prompt || !region.settled;
  useEffect(() => reportPromptShowing(promptShowing), [promptShowing, reportPromptShowing]);
  if (chromeLess) return null;
  const choose = (choice: 'granted' | 'denied') => {
    void decide(choice);
    closeChoices();
  };
  const copy = (
    <>
      <Typography variant="body2" color="text.secondary">
        {t('body')}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('adMeasurement')}
      </Typography>
      <MuiLink component={LocaleLink} href="/privacy" onNavigate={closeChoices}>
        {t('privacyLink')}
      </MuiLink>
    </>
  );
  return (
    <>
      {region.prompt && (
        <Box
          className="analytics-consent-banner"
          role="region"
          aria-labelledby="consent-banner-title"
          data-testid="consent-banner"
          sx={{
            position: 'fixed',
            zIndex: (theme) => theme.zIndex.modal - 1,
            bottom: 0,
            left: 0,
            right: 0,
            px: 2,
            pb: 'max(16px, env(safe-area-inset-bottom))',
            display: 'flex',
            justifyContent: 'flex-start',
            pointerEvents: 'none',
          }}
        >
          <Paper elevation={8} sx={{ p: 1.5, maxWidth: 420, width: '100%', pointerEvents: 'auto' }}>
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography variant="h6" component="h2" id="consent-banner-title">
                  {t('title')}
                </Typography>
                <Button
                  variant="text"
                  size="small"
                  onClick={openChoices}
                  aria-haspopup="dialog"
                  sx={{ minHeight: 44, minWidth: 44, flexShrink: 0, textDecoration: 'underline' }}
                >
                  {t('details')}
                </Button>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {t('bannerSummary')}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" fullWidth sx={{ minHeight: 44 }} onClick={() => choose('granted')}>
                  {t('allow')}
                </Button>
                <Button variant="outlined" fullWidth sx={{ minHeight: 44 }} onClick={() => choose('denied')}>
                  {t('deny')}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        </Box>
      )}
      <Dialog open={dialogOpen} onClose={closeChoices} fullWidth maxWidth="sm" aria-labelledby="consent-choices-title">
        <DialogTitle id="consent-choices-title">{t('privacyChoices')}</DialogTitle>
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
      {children?.(region)}
    </>
  );
}
