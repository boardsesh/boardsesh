import { describe, expect, it } from 'vite-plus/test';
import type { TFunction } from 'i18next';
import enMarketing from '@boardsesh/i18n/locales/en-US/marketing.json';
import { formatCommunityProof } from '../community-proof';

/** The real English sentence, filled the way i18next fills `{{placeholders}}`. */
const englishT = ((key: string, values: Record<string, string>) => {
  expect(key).toBe('home.hero.proof');
  return enMarketing.home.hero.proof.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name]);
}) as unknown as TFunction;

describe('formatCommunityProof', () => {
  it('says "about": climbers to the hundred, climbs lit to the thousand', () => {
    expect(formatCommunityProof({ climbersLast30Days: 3249, litLast30Days: 205_800 }, englishT, 'en-US')).toBe(
      'In the last 30 days, about 3,200 climbers used Boardsesh to light a climb on their board 206,000 times.',
    );
  });

  it("formats the numbers in the page's language", () => {
    const line = formatCommunityProof({ climbersLast30Days: 3251, litLast30Days: 205_499 }, englishT, 'de');

    expect(line).toContain('3.300');
    expect(line).toContain('205.000');
  });
});
