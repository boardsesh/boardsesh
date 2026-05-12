'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

import LocaleLink from '@/app/components/i18n/locale-link';
import type { ConsentDecision } from '@/app/lib/consent';
import type { ConsentRejectionSource } from '@/app/lib/consent-events';

import { useConsent } from './consent-context';

type Props = {
  open: boolean;
  onClose: () => void;
  /**
   * Where this dialog was opened from. Forwarded to the rejection-tracking
   * event so we can tell whether users are rejecting from the first-touch
   * banner customize flow vs the /settings entry. Defaults to `'dialog'`.
   */
  source?: ConsentRejectionSource;
};

const decisionFromSwitch = (checked: boolean): ConsentDecision => (checked ? 'granted' : 'denied');

/**
 * Granular consent dialog. Two category toggles plus a read-only
 * "Strictly necessary" block. The Cancel action lives in the dialog's
 * action row alongside Save so users can back out without writing.
 */
export default function ConsentDialog({ open, onClose, source = 'dialog' }: Props) {
  const { t } = useTranslation('consent');
  const { state, saveCategories } = useConsent();

  const [analyticsOn, setAnalyticsOn] = useState<boolean>(state.analytics === 'granted');
  const [errorOn, setErrorOn] = useState<boolean>(state.errorMonitoring === 'granted');

  // Seed the toggles from the latest stored state whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setAnalyticsOn(state.analytics === 'granted');
    setErrorOn(state.errorMonitoring === 'granted');
  }, [open, state.analytics, state.errorMonitoring]);

  const handleSave = async () => {
    await saveCategories(
      {
        analytics: decisionFromSwitch(analyticsOn),
        errorMonitoring: decisionFromSwitch(errorOn),
      },
      source,
    );
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="consent-dialog-title">
      <DialogTitle id="consent-dialog-title">{t('dialog.title')}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Typography variant="body2" color="text.secondary">
            {t('dialog.intro')}
          </Typography>

          <Stack
            spacing={0.5}
            sx={(theme) => ({
              padding: theme.spacing(1.5),
              borderRadius: theme.shape.borderRadius,
              backgroundColor: theme.palette.action.hover,
            })}
          >
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <Typography variant="subtitle2">{t('dialog.essential.title')}</Typography>
              <Chip label={t('dialog.essential.status')} size="small" color="default" />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {t('dialog.essential.body')}
            </Typography>
          </Stack>

          <Divider flexItem />

          <Stack spacing={0.5}>
            <FormControlLabel
              sx={{ marginRight: 0, alignItems: 'flex-start' }}
              control={
                <Switch
                  checked={analyticsOn}
                  onChange={(_, checked) => setAnalyticsOn(checked)}
                  inputProps={{ 'aria-label': t('dialog.analytics.title') }}
                />
              }
              labelPlacement="start"
              label={
                <Stack spacing={0.25} sx={{ flexGrow: 1, paddingRight: 1 }}>
                  <Typography variant="subtitle2">{t('dialog.analytics.title')}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('dialog.analytics.body')}
                  </Typography>
                </Stack>
              }
            />
          </Stack>

          <Divider flexItem />

          <Stack spacing={0.5}>
            <FormControlLabel
              sx={{ marginRight: 0, alignItems: 'flex-start' }}
              control={
                <Switch
                  checked={errorOn}
                  onChange={(_, checked) => setErrorOn(checked)}
                  inputProps={{ 'aria-label': t('dialog.errorMonitoring.title') }}
                />
              }
              labelPlacement="start"
              label={
                <Stack spacing={0.25} sx={{ flexGrow: 1, paddingRight: 1 }}>
                  <Typography variant="subtitle2">{t('dialog.errorMonitoring.title')}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('dialog.errorMonitoring.body')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('dialog.footer.noteOnErrors')}
                  </Typography>
                </Stack>
              }
            />
          </Stack>

          <Typography variant="body2">
            <MuiLink component={LocaleLink} href="/privacy">
              {t('dialog.footer.privacyLink')}
            </MuiLink>
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="text">
          {t('dialog.actions.cancel')}
        </Button>
        <Button onClick={handleSave} variant="contained">
          {t('dialog.actions.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
