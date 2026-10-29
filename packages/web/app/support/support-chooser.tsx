'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { PageCard } from '@/app/components/ui/page-shell';
import { brandCtaSx, brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import type { SupportCurrency, SupportPageOptions } from './support-links';
import { trackSupportCta } from './support-analytics';
import styles from './support.module.css';

const MONTHLY_CTA_SX = brandCtaSx({ size: 'medium' });
const ONCE_CTA_SX = brandCtaOutlinedSx({ size: 'medium' });
const TOGGLE_SX = { textTransform: 'none', minHeight: 44, px: 2 } as const;

type Cadence = 'monthly' | 'once';

/** Anchor the hero's "Go monthly" button scrolls to. */
export const SUPPORT_CHOOSER_ID = 'give';

type SupportChooserProps = {
  options: SupportPageOptions;
  src: string;
};

/**
 * Monthly first, "Give once" beside it, in AUD or USD.
 *
 * Every href arrives finished from the server (env-read and tagged with `src`).
 * The labels are the env's own, so they are rendered as they came and never
 * sent to analytics: they name amounts. Monthly is the default whenever the
 * chosen currency has a monthly list.
 */
export default function SupportChooser({ options, src }: SupportChooserProps) {
  const { t } = useTranslation('marketing');
  const [currency, setCurrency] = useState<SupportCurrency>(options.defaultCurrency);
  const monthlyLinks = options.monthly[currency] ?? [];
  const onceUrl = options.once[currency];
  const canMonthly = monthlyLinks.length > 0;
  const canOnce = !!onceUrl;
  const [preferredCadence, setPreferredCadence] = useState<Cadence>('monthly');
  // A currency switch can land on a currency without the chosen cadence.
  const cadence: Cadence =
    preferredCadence === 'monthly' ? (canMonthly ? 'monthly' : 'once') : canOnce ? 'once' : 'monthly';
  const currencyLabels: Record<SupportCurrency, string> = {
    aud: t('support.chooser.aud'),
    usd: t('support.chooser.usd'),
  };

  return (
    <PageCard
      variant="elevated"
      className={`${styles.rail} ${styles.chooser}`}
      id={SUPPORT_CHOOSER_ID}
      data-testid="support-chooser"
    >
      <Box className={styles.chooserControls}>
        {canMonthly && canOnce ? (
          <ToggleButtonGroup
            exclusive
            value={cadence}
            aria-label={t('support.chooser.cadenceLabel')}
            onChange={(_event, next: Cadence | null) => {
              if (next) setPreferredCadence(next);
            }}
          >
            <ToggleButton value="monthly" sx={TOGGLE_SX}>
              {t('support.chooser.monthly')}
            </ToggleButton>
            <ToggleButton value="once" sx={TOGGLE_SX}>
              {t('support.chooser.once')}
            </ToggleButton>
          </ToggleButtonGroup>
        ) : null}
        {options.currencies.length > 1 ? (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={currency}
            aria-label={t('support.chooser.currencyLabel')}
            onChange={(_event, next: SupportCurrency | null) => {
              if (next) setCurrency(next);
            }}
          >
            {options.currencies.map((code) => (
              <ToggleButton key={code} value={code} sx={TOGGLE_SX} data-testid={`support-currency-${code}`}>
                {currencyLabels[code]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : null}
      </Box>

      {cadence === 'monthly' || !onceUrl ? (
        <>
          <Typography variant="body1" component="p" color="text.secondary">
            {t('support.chooser.monthlyBody')}
          </Typography>
          <Box className={styles.optionList} data-testid="support-monthly-options">
            {monthlyLinks.map((link, index) => (
              <Button
                key={link.url}
                variant="contained"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                sx={MONTHLY_CTA_SX}
                onClick={() =>
                  trackSupportCta({ cadence: 'monthly', currency, src, option: index + 1, placement: 'options' })
                }
              >
                {link.label}
              </Button>
            ))}
          </Box>
        </>
      ) : (
        <>
          <Typography variant="body1" component="p" color="text.secondary">
            {t('support.oneTime.body')}
          </Typography>
          <Box className={styles.optionList}>
            <Button
              variant="outlined"
              href={onceUrl}
              target="_blank"
              rel="noopener noreferrer"
              sx={ONCE_CTA_SX}
              data-testid="support-once-cta"
              onClick={() => trackSupportCta({ cadence: 'once', currency, src, option: 1, placement: 'options' })}
            >
              {t('support.oneTime.cta')}
            </Button>
          </Box>
        </>
      )}

      <Typography variant="body2" component="p" color="text.secondary" className={styles.chooserNote}>
        {t('support.chooser.publicName')}
      </Typography>
      {cadence === 'monthly' && options.billingPortalUrl ? (
        <Typography variant="body2" component="p" className={styles.chooserNote}>
          <MuiLink href={options.billingPortalUrl} target="_blank" rel="noopener noreferrer">
            {t('support.chooser.manage')}
          </MuiLink>
        </Typography>
      ) : null}
    </PageCard>
  );
}
