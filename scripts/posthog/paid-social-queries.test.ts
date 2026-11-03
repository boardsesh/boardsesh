/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { paidSocialDashboard } from './paid-social-dashboard';
import {
  PAID_SOCIAL_SOURCES,
  TAGGED_LANDING_URL,
  paidSocialAdsQuery,
  paidSocialAndroidInstallsQuery,
  paidSocialAndroidOutcomesQuery,
  paidSocialLandingQuery,
  paidSocialStoreClicksQuery,
} from './paid-social-queries';
import { paidSocialValidationQueries } from './paid-social-validation';

type ValidationKey = keyof typeof paidSocialValidationQueries;
interface RecordedRun {
  querySha256: string;
  rowCount: number;
  totals?: Record<string, number>;
}
const recorded = JSON.parse(readFileSync(new URL('./paid-social-validation.json', import.meta.url), 'utf8')) as {
  runs: Record<ValidationKey, RecordedRun>;
};

const wwwQueries = [paidSocialLandingQuery(), paidSocialStoreClicksQuery(), paidSocialAdsQuery()];
const androidQueries = [paidSocialAndroidInstallsQuery(), paidSocialAndroidOutcomesQuery()];

describe('paid social queries executed in PostHog', () => {
  it.each(Object.keys(paidSocialValidationQueries) as ValidationKey[])(
    '%s matches the exact query that ran live',
    (key) => {
      expect(recorded.runs[key]?.querySha256).toBe(
        createHash('sha256').update(paidSocialValidationQueries[key]).digest('hex'),
      );
    },
  );

  it('reconciles store-click denominators with the landing tile on real tagged traffic', () => {
    const { probeLanding, probeStoreClicks, probeAds } = recorded.runs;
    expect(probeLanding.totals?.landing_sessions).toBeGreaterThan(0);
    expect(probeStoreClicks.totals?.landing_sessions).toBe(probeLanding.totals?.landing_sessions);
    expect(probeAds.totals?.landing_sessions).toBe(probeLanding.totals?.landing_sessions);
    expect(probeAds.totals?.store_clicks).toBe(probeStoreClicks.totals?.store_clicks);
  });

  it('reconciles dated Android installs between the install and outcome tiles', () => {
    const { probeAndroidInstalls, probeAndroidOutcomes } = recorded.runs;
    expect(probeAndroidInstalls.totals?.people).toBeGreaterThan(0);
    expect(probeAndroidOutcomes.totals?.new_installs).toBe(probeAndroidInstalls.totals?.people);
  });
});

describe('paid social population rules', () => {
  it('filters the three paid-social sources, lower-cased', () => {
    expect(PAID_SOCIAL_SOURCES).toEqual(['reddit', 'instagram', 'meta']);
    for (const query of [...wwwQueries, ...androidQueries]) {
      expect(query).toContain("IN ('reddit', 'instagram', 'meta')");
    }
  });

  it('excludes the internal cohort from every query', () => {
    for (const query of [...wwwQueries, ...androidQueries]) {
      expect(query).toContain('NOT IN COHORT 295337');
    }
  });

  it('keeps www anonymous: www library, session keys, crawler rule, no person campaign properties', () => {
    for (const query of wwwQueries) {
      expect(query).toContain("properties.$lib = 'js'");
      expect(query).toContain('properties.$session_id');
      expect(query).toContain("'windows crawler, arm 1'");
      expect(query).toContain("'windows crawler, arm 2'");
      expect(query).toContain("'lightpanda'");
      expect(query).not.toContain('$initial_utm');
      expect(query).not.toContain('person.properties');
      expect(query).toContain('{filters.dateRange.from}');
    }
  });

  it('maps bare click ids the way store links do', () => {
    const query = paidSocialLandingQuery();
    expect(query).toMatch(/properties\.rdt_cid[\s\S]*\[\?&\]rdt_cid=\(\[\^&#\]\*\)'\), ''\)\)\), 'reddit'/);
    expect(query).toMatch(/properties\.fbclid[\s\S]*\[\?&\]fbclid=\(\[\^&#\]\*\)'\), ''\)\)\), 'meta'/);
  });

  it('counts a landing only when the first pageview URL itself carried the tag', () => {
    for (const query of wwwQueries) {
      expect(query).toContain(`match(landing_sessions.entry_url, '${TAGGED_LANDING_URL}')`);
    }
  });

  it('never tests presence with a bare != comparison', () => {
    for (const query of [...wwwQueries, ...androidQueries]) {
      expect(query).not.toMatch(/!= ''/);
    }
  });

  it('dates Android installs by install_begin_timestamp, not Install Attributed', () => {
    for (const query of androidQueries) {
      expect(query).toContain('install_begin_timestamp');
      expect(query).not.toContain('Install Attributed');
    }
    expect(paidSocialAndroidOutcomesQuery()).toContain("growth_native_newcomers.platform = 'Android'");
    expect(paidSocialAndroidOutcomesQuery()).toContain("properties.$os = 'Android'");
  });
});

describe('paid social dashboard definition', () => {
  it('has the five data tiles plus the intro and iOS text cards', () => {
    expect(paidSocialDashboard.insights.map((insight) => insight.key)).toEqual([
      'landing-sessions',
      'store-clicks',
      'ads',
      'android-installs',
      'android-outcomes',
    ]);
    expect(paidSocialDashboard.intro.body).toContain('295337');
  });

  it('explains where iOS installs are counted', () => {
    const { body } = paidSocialDashboard.ios;
    expect(body).toContain('App Store Connect');
    expect(body).toContain('reddit-<code>');
    expect(body).toContain('instagram-<code>');
    expect(body).toContain('5 first-time downloads');
    expect(body).toContain('NEXT_PUBLIC_APP_STORE_PROVIDER_ID');
  });

  it('formats 0–100 rates with a percent suffix only', () => {
    for (const insight of paidSocialDashboard.insights) {
      for (const entry of insight.query.tableSettings.columns) {
        expect(Boolean(entry.settings.formatting)).toBe(entry.column.endsWith('_percent'));
      }
    }
  });
});
