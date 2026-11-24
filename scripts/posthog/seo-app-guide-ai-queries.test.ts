import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { seoAppGuideAiFixtureExpected, seoAppGuideAiFixtureQuery } from './seo-app-guide-ai-fixtures';
import { AI_SEARCH_REFERRAL_HOSTS, seoAppGuideAiReferralsQuery } from './seo-app-guide-queries';

const recorded = JSON.parse(readFileSync(new URL('./seo-app-guide-ai-validation.json', import.meta.url), 'utf8')) as {
  fixtureQuerySha256: string;
  fixtureRows: (string | number)[][];
};

describe('AI search guide referrals', () => {
  it('pins live HogQL results for session attribution, timestamp ties, bots and window edges', () => {
    expect(createHash('sha256').update(seoAppGuideAiFixtureQuery).digest('hex')).toBe(recorded.fixtureQuerySha256);
    expect(recorded.fixtureRows).toEqual(seoAppGuideAiFixtureExpected);
  });

  it('uses the www consented population and exact human referral hosts', () => {
    const query = seoAppGuideAiReferralsQuery();
    expect(AI_SEARCH_REFERRAL_HOSTS).toEqual(['chatgpt.com', 'perplexity.ai', 'claude.ai']);
    expect(query).toContain('person_id NOT IN COHORT 295337');
    expect(query).toContain("properties.$lib = 'js'");
    expect(query).toContain('timestamp >= {filters.dateRange.from} - INTERVAL 1 DAY');
    expect(query).toContain('timestamp < {filters.dateRange.to}');
    expect(query).not.toContain('person.properties');
  });
});
