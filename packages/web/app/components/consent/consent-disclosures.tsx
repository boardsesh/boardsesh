'use client';

import { useTranslation } from 'react-i18next';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';

/** The same disclosures remain available when the optional dialog cannot load. */
export default function ConsentDisclosures({ onClose, syncFailed }: { onClose: () => void; syncFailed: boolean }) {
  const { t } = useTranslation('consent');
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t('body')}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('adMeasurement')}
      </Typography>
      <MuiLink component={LocaleLink} href="/privacy" onNavigate={onClose}>
        {t('privacyLink')}
      </MuiLink>
      {syncFailed && <Typography role="status">{t('syncError')}</Typography>}
    </Stack>
  );
}
