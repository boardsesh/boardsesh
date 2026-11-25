'use client';

import type { ConsentLabels } from './consent-labels';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';

/** The same disclosures remain available when the optional dialog cannot load. */
export default function ConsentDisclosures({
  labels,
  onClose,
  syncFailed,
}: {
  labels: ConsentLabels;
  onClose: () => void;
  syncFailed: boolean;
}) {
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {labels.body}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {labels.adMeasurement}
      </Typography>
      <MuiLink component={LocaleLink} href="/privacy" onNavigate={onClose}>
        {labels.privacyLink}
      </MuiLink>
      {syncFailed && <Typography role="status">{labels.syncError}</Typography>}
    </Stack>
  );
}
