import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import { cachedCommunityStats } from '@/app/lib/graphql/server-cached-client';
import { formatCommunityProof } from '@/app/lib/community-proof';
import type { Locale } from '@/app/lib/i18n/config';
import { getServerTranslation, getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';

const lineSx = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: `${themeTokens.spacing[3]}px`,
  margin: 0,
  color: 'var(--neutral-700)',
  fontSize: themeTokens.typography.fontSize.base,
  lineHeight: themeTokens.typography.lineHeight.normal,
  fontVariantNumeric: 'tabular-nums',
};

// Amber is the "lit" colour: a hold lit on the wall. The icon is decoration and
// carries no words, so it is not text the contrast audit measures. One line of
// the text is 16px at 1.5, 24px tall, so a 24px icon sits on the first line.
const iconSx = {
  flex: 'none',
  width: themeTokens.spacing[6],
  height: themeTokens.spacing[6],
  color: 'var(--color-amber)',
};

/**
 * The site-wide 30-day line, on a public page: "In the last 30 days, about
 * 3,200 climbers used Boardsesh to light a climb on their board 206,000 times."
 *
 * One cached read (`cachedCommunityStats`, six hours on the web plus an hour in
 * Redis, one key for the whole site, the same one the homepage reads), and the
 * homepage's own sentence and rounding through `formatCommunityProof`. Renders
 * nothing when the numbers could not be read: a missing line is honest, a "0"
 * would say nobody climbs.
 */
export default async function CommunityProofLine({ locale: requestedLocale }: { locale?: Locale } = {}) {
  const [communityStats, { t, locale }] = await Promise.all([
    cachedCommunityStats(),
    requestedLocale ? getServerTranslationForLocale(requestedLocale, 'marketing') : getServerTranslation('marketing'),
  ]);
  if (!communityStats) return null;

  return (
    <Typography component="p" sx={lineSx}>
      <LightbulbIcon aria-hidden sx={iconSx} />
      <Box component="span">{formatCommunityProof(communityStats, t, locale)}</Box>
    </Typography>
  );
}
