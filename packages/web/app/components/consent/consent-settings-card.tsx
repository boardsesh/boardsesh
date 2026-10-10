'use client';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { useConsent } from './consent-provider';
export default function ConsentSettingsCard() {
  const { t } = useTranslation('consent');
  const { granted, openChoices } = useConsent();
  return (
    <Card>
      <CardContent>
        <Typography variant="h5">{t('settingsTitle')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>
          {t('settingsBody')}
        </Typography>
        <Typography variant="body2">{granted ? t('enabled') : t('disabled')}</Typography>
        <Button onClick={openChoices} sx={{ mt: 2 }}>
          {t('privacyChoices')}
        </Button>
      </CardContent>
    </Card>
  );
}
