import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { seoAppGuideFixtureExpected, seoAppGuideFixtureQuery } from './seo-app-guide-fixtures';
import { APP_GUIDE_PATHS, RETIRED_APP_GUIDE_PATHS, seoAppGuideSessionsQuery } from './seo-app-guide-queries';

const recorded = JSON.parse(readFileSync(new URL('./seo-app-guide-validation.json', import.meta.url), 'utf8')) as {
  fixtureQuerySha256: string;
  fixtureRows: (string | number)[][];
};

describe('SEO app guide measurement', () => {
  it('pins the actual fixture query executed by PostHog', () => {
    expect(createHash('sha256').update(seoAppGuideFixtureQuery).digest('hex')).toBe(recorded.fixtureQuerySha256);
    expect(recorded.fixtureRows).toEqual(seoAppGuideFixtureExpected);
  });

  it('buckets the six live guides, and counts the retired Aurora brand URLs as /apps/aurora', () => {
    expect(APP_GUIDE_PATHS).toEqual([
      '/apps',
      '/apps/kilter',
      '/apps/aurora',
      '/apps/moonboard',
      '/apps/woods',
      '/compare/spray-wall-apps',
    ]);
    expect(Object.keys(RETIRED_APP_GUIDE_PATHS).sort()).toEqual([
      '/apps/decoy',
      '/apps/grasshopper',
      '/apps/so-ill',
      '/apps/tension',
      '/apps/touchstone',
    ]);
    expect(new Set(Object.values(RETIRED_APP_GUIDE_PATHS))).toEqual(new Set(['/apps/aurora']));
  });

  it('keeps the production population bounded, consented and separate from native installs', () => {
    const query = seoAppGuideSessionsQuery();
    expect(query).toContain('person_id NOT IN COHORT 295337');
    expect(query).toContain("properties.$lib = 'js'");
    expect(query).toContain('timestamp >= {filters.dateRange.from} - INTERVAL 1 DAY');
    expect(query).toContain('timestamp < {filters.dateRange.to}');
    expect(query).not.toContain('Install Attributed');
    expect(query).not.toContain('person.properties');
  });
});
