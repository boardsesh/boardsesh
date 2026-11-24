'use client';

import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import type { KioskTheme } from '@boardsesh/kiosk';

export default function KioskAppearanceSettings({
  theme,
  onChange,
}: {
  theme: KioskTheme;
  onChange: (theme: KioskTheme) => void;
}) {
  const { t } = useTranslation('kiosk');
  const appearanceId = useId();
  return (
    <FormControl component="fieldset">
      <FormLabel component="legend" id={`${appearanceId}-label`}>
        {t('manage.editor.appearance.label')}
      </FormLabel>
      <RadioGroup
        row
        aria-labelledby={`${appearanceId}-label`}
        aria-describedby={`${appearanceId}-description`}
        value={theme}
        onChange={(_, selectedTheme) => {
          if (selectedTheme === 'dark' || selectedTheme === 'light') onChange(selectedTheme);
        }}
      >
        <FormControlLabel value="dark" control={<Radio />} label={t('manage.editor.appearance.dark')} />
        <FormControlLabel value="light" control={<Radio />} label={t('manage.editor.appearance.light')} />
      </RadioGroup>
      <FormHelperText id={`${appearanceId}-description`}>{t('manage.editor.appearance.description')}</FormHelperText>
    </FormControl>
  );
}
