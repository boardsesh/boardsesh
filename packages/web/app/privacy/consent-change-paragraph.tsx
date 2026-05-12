'use client';

import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { Trans, useTranslation } from 'react-i18next';

import LocaleLink from '@/app/components/i18n/locale-link';

/**
 * The "you can change your mind from <Settings>" paragraph in the privacy
 * page lives as its own client component so it can use `react-i18next`'s
 * `<Trans>` to keep the sentence as a single translation key. The rest of
 * the page stays SSR — only this paragraph needs the inline link.
 */
export default function ConsentChangeParagraph() {
  const { t } = useTranslation('marketing');
  return (
    <Typography variant="body1" sx={{ mb: 1.5, lineHeight: 1.7 }}>
      <Trans
        t={t}
        i18nKey="privacy.consent.body2"
        components={{ a: <MuiLink component={LocaleLink} href="/settings" /> }}
      />
    </Typography>
  );
}
