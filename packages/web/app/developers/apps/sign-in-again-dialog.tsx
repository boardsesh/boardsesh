'use client';

import React, { useId } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS } from '@boardsesh/auth-protocol/auth-time';
import LocaleLink from '@/app/components/i18n/locale-link';
import { DEFAULT_LOCALE, isSupportedLocale } from '@/app/lib/i18n/config';
import { signInAgainPath } from '@/app/lib/developer-apps/sign-in-again';

type SignInAgainDialogProps = {
  /** Refused from the edit form, which stays open behind this with what was typed. */
  fromForm: boolean;
  fromWebhook?: boolean;
  onClose: () => void;
};

/**
 * Shown when the backend refuses a redirect URI change, a new secret or a
 * deletion because the developer's sign-in is older than five minutes (#7598).
 * The button goes through the ordinary sign-out and sign-in pages and back to
 * the console, where the developer makes the change again. That round trip
 * leaves the page, so an open form's edits cannot survive it: the dialog says
 * so, and Cancel goes back to the form with them intact.
 */
export default function SignInAgainDialog({ fromForm, fromWebhook = false, onClose }: SignInAgainDialogProps) {
  const { t, i18n } = useTranslation('developers');
  const titleId = useId();
  const locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} maxWidth="xs" fullWidth>
      <DialogTitle id={titleId}>{t('signInAgain.title')}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            {fromWebhook
              ? t('webhooks.reauthBody', { minutes: PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS / 60 })
              : t('signInAgain.body', { minutes: PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS / 60 })}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t('signInAgain.next')}
          </Typography>
          {fromForm ? (
            <Typography variant="body2" color="text.secondary">
              {fromWebhook ? t('webhooks.reauthForm') : t('signInAgain.formKept')}
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1, '& .MuiButton-root': { minHeight: 44 } }}>
        <Button onClick={onClose}>{t('form.cancel')}</Button>
        <Button variant="contained" component={LocaleLink} href={signInAgainPath(locale)} locale={locale}>
          {t('signInAgain.button')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
