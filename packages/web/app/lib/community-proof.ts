import type { TFunction } from 'i18next';

/** The two rolling 30-day totals `cachedCommunityStats()` returns. */
export type CommunityStats = {
  climbersLast30Days: number;
  litLast30Days: number;
};

/**
 * The site-wide 30-day line: "In the last 30 days, about 3,200 climbers used
 * Boardsesh to light a climb on their board 206,000 times."
 *
 * One sentence (`marketing:home.hero.proof`) and one rounding for every page
 * that prints it, the homepage and the board lists, so the two never disagree
 * about the same cached numbers. Climbers round to the hundred and climbs lit
 * to the thousand: the copy says "about", and an exact count would read as
 * precise when it is a cached rolling total.
 *
 * `t` must be a `marketing` translator (`getServerTranslation('marketing')`).
 * Numbers are formatted in the page's locale, so 206,000 is 206.000 in German.
 */
export function formatCommunityProof(stats: CommunityStats, t: TFunction, locale: string): string {
  const numberFormat = new Intl.NumberFormat(locale);
  return t('home.hero.proof', {
    formattedClimbers: numberFormat.format(Math.round(stats.climbersLast30Days / 100) * 100),
    formattedClimbs: numberFormat.format(Math.round(stats.litLast30Days / 1000) * 1000),
  });
}
