'use client';

import React from 'react';
import MuiAlert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { useTranslation } from 'react-i18next';

/**
 * Shown in place of silence when an action still did not go through after the
 * session re-check (a `ReloadRequiredError` from `guardedActionFetch`). Inline,
 * not a toast: the snackbar drops a toast from before an account change, and
 * this one must show after a new login of the same account too.
 */
export default function ReloadPageAlert() {
  const { t } = useTranslation('settings');
  return (
    <MuiAlert
      severity="warning"
      sx={{ mb: 2 }}
      action={
        <Button color="inherit" size="small" onClick={() => window.location.reload()}>
          {t('reloadRequired.action')}
        </Button>
      }
    >
      {t('reloadRequired.message')}
    </MuiAlert>
  );
}

/** A write the server refused once and saved nothing for (`WriteRefusedError`): press again. */
export function TryAgainAlert() {
  const { t } = useTranslation('settings');
  return (
    <MuiAlert severity="info" sx={{ mb: 2 }}>
      {t('writeRefused.tryAgain')}
    </MuiAlert>
  );
}
