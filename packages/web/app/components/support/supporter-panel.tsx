'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import type { MySupporterStatus } from '@boardsesh/graphql/operations/support';
import LocaleLink from '@/app/components/i18n/locale-link';
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { useSupporterStatus, type SupporterLinkOutcome } from './use-supporter-status';

type SupporterPanelProps = {
  /**
   * `thanks`: inside the `/support?thanks=1` card, right after a payment.
   * Signed out it invites a sign-in instead.
   * `settings`: the card on `/settings`, which is only ever shown signed in.
   */
  variant: 'thanks' | 'settings';
};

/** Where a signed-out giver comes back to after signing in. */
const THANKS_PATH = '/support?thanks=1';

type Translate = (key: string, options?: Record<string, unknown>) => string;

function outcomeLine(outcome: SupporterLinkOutcome, email: string, t: Translate): string {
  switch (outcome) {
    case 'linked':
      return t('supporter.link.linked');
    case 'expired':
      return t('supporter.link.expired');
    case 'notFound':
      return t('supporter.link.notFound', { email });
    case 'emailNotVerified':
      return t('supporter.link.emailNotVerified');
    case 'unavailable':
      return t('supporter.link.unavailable');
    case 'rateLimited':
      return t('supporter.link.rateLimited');
    case 'failed':
      return t('supporter.link.failed');
  }
}

function formatDate(isoDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(isoDate));
}

/** One honest line about what the backend has on record for this account. */
function statusLine(status: MySupporterStatus, locale: string, t: Translate): string {
  if (status.hasSubscription) {
    return status.cancelAtPeriodEnd ? t('supporter.status.monthlyEnding') : t('supporter.status.monthly');
  }
  if (status.isSupporter && status.creditUntil) {
    return t('supporter.status.until', { date: formatDate(status.creditUntil, locale) });
  }
  if (status.isSupporter) return t('supporter.status.current');
  return status.source ? t('supporter.status.ended') : t('supporter.status.none');
}

/**
 * Public credit and "Already gave? Link it", shared by the `/support` thank-you
 * card and `/settings`. Credit is off until the climber switches it on, and the
 * switch works before a payment lands, so it can be set straight after paying.
 */
export default function SupporterPanel({ variant }: SupporterPanelProps) {
  const { t, i18n } = useTranslation('settings');
  const locale: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  const supporter = useSupporterStatus();

  if (supporter.isSessionLoading) return null;

  if (!supporter.isSignedIn) {
    if (variant !== 'thanks') return null;
    const callbackUrl = encodeURIComponent(localeHref(THANKS_PATH, locale));
    return (
      <Box data-testid="supporter-panel-signed-out" sx={{ display: 'grid', gap: 1.5, justifyItems: 'start' }}>
        <Typography variant="body2" component="p" color="text.secondary">
          {t('supporter.signedOut.body')}
        </Typography>
        <Button component={LocaleLink} href={`/auth/login?callbackUrl=${callbackUrl}`} variant="outlined">
          {t('supporter.signedOut.cta')}
        </Button>
      </Box>
    );
  }

  const { status } = supporter;
  return (
    <Box data-testid="supporter-panel" sx={{ display: 'grid', gap: 1.5, justifyItems: 'start' }}>
      {supporter.isStatusLoading ? <CircularProgress size={20} aria-label={t('supporter.status.loading')} /> : null}
      {!supporter.isStatusLoading && supporter.statusFailed && !status ? (
        <Typography variant="body2" component="p" color="error">
          {t('supporter.status.error')}
        </Typography>
      ) : null}
      {status ? (
        <Typography variant="body2" component="p" data-testid="supporter-status">
          {statusLine(status, locale, t)}
        </Typography>
      ) : null}
      {variant === 'thanks' && status && !status.isSupporter ? (
        <Typography variant="body2" component="p" color="text.secondary">
          {t('supporter.status.confirming')}
        </Typography>
      ) : null}

      <FormControlLabel
        control={
          <Switch
            checked={status?.showPublicly ?? false}
            disabled={!status || supporter.isSavingVisibility}
            onChange={(_event, checked) => supporter.setShowPublicly(checked)}
            inputProps={{ 'aria-describedby': 'supporter-visibility-hint' }}
          />
        }
        label={t('supporter.visibility.label')}
      />
      <Typography id="supporter-visibility-hint" variant="body2" component="p" color="text.secondary">
        {t('supporter.visibility.hint')}
      </Typography>
      {supporter.visibilityFailed ? (
        <Typography variant="body2" component="p" color="error" role="alert">
          {t('supporter.visibility.error')}
        </Typography>
      ) : null}

      <Button
        variant="outlined"
        onClick={supporter.linkPastGift}
        // Linking still works when the status read failed: it returns a fresh status.
        disabled={supporter.isStatusLoading || supporter.isLinking}
        data-testid="supporter-link-cta"
      >
        {supporter.isLinking ? t('supporter.link.pending') : t('supporter.link.cta')}
      </Button>
      {supporter.email ? (
        <Typography variant="body2" component="p" color="text.secondary">
          {t('supporter.link.hint', { email: supporter.email })}
        </Typography>
      ) : null}
      {supporter.linkOutcome ? (
        <Typography
          variant="body2"
          component="p"
          role="status"
          data-testid="supporter-link-outcome"
          color={supporter.linkOutcome === 'linked' ? 'text.primary' : 'text.secondary'}
        >
          {outcomeLine(supporter.linkOutcome, supporter.email ?? '', t)}
        </Typography>
      ) : null}
    </Box>
  );
}
