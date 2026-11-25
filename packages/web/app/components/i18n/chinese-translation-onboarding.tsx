'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import {
  chineseTranslationOnboardingKey,
  getChineseTerminologyFormUrl,
  isChineseTranslationLocale,
} from '@boardsesh/i18n';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { useConsent } from '../consent/consent-state-provider';
import type { ConsentRegionPromptState } from '../consent/use-consent-region-prompt';

export default function ChineseTranslationOnboarding({ consentRegion }: { consentRegion: ConsentRegionPromptState }) {
  const formUrl = getChineseTerminologyFormUrl(process.env.NEXT_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL);
  const { t, i18n } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const pathname = usePathnameWithoutLocale();
  const chromeLess = isChromeLessPath(pathname.toLowerCase());
  const { dialogOpen } = useConsent();
  const eligible = isChineseTranslationLocale(i18n.language) && !chromeLess;
  const { prompt: consentPrompt, settled: consentSettled } = consentRegion;

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    void getPreference<boolean>(chineseTranslationOnboardingKey(formUrl)).then((seen) => {
      if (!cancelled) setOpen(seen !== true);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, formUrl]);

  const dismiss = () => {
    setOpen(false);
    void setPreference(chineseTranslationOnboardingKey(formUrl), true);
  };

  return (
    <Dialog
      open={eligible && open && consentSettled && !dialogOpen && !consentPrompt}
      onClose={dismiss}
      aria-labelledby="chinese-translation-title"
    >
      <DialogTitle id="chinese-translation-title">{t('chineseTranslation.title')}</DialogTitle>
      <DialogContent>
        <Typography paragraph>{t('chineseTranslation.body')}</Typography>
        <Typography paragraph>{t('chineseTranslation.terms')}</Typography>
        <Typography>{formUrl ? t('chineseTranslation.invitation') : t('chineseTranslation.formPending')}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={dismiss}>{t('chineseTranslation.continue')}</Button>
        {formUrl && (
          <Button
            component="a"
            href={formUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={dismiss}
            variant="contained"
          >
            {t('chineseTranslation.openForm')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
