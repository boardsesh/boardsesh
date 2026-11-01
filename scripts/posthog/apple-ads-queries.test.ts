/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appleAdsDashboard } from './apple-ads-dashboard';
import { appleAdsFixtures, APPLE_ADS_FIXTURE_WINDOW } from './apple-ads-fixtures';
import { appleAdsUnmappedSpendQuery, liveAppleAdsSources } from './apple-ads-queries';

interface RecordedFixture {
  querySha256: string;
  rows: Record<string, string | null>[];
}
const recorded = JSON.parse(readFileSync(new URL('./apple-ads-fixture-validation.json', import.meta.url), 'utf8')) as {
  fixtures: Record<keyof typeof appleAdsFixtures, RecordedFixture>;
};
function rows(fixture: keyof typeof appleAdsFixtures) {
  return recorded.fixtures[fixture].rows;
}
function downloadClickOutcome(fixture: 'outcomes' | 'staleOutcomes') {
  const result = rows(fixture).find((row) => row.conversion_type === 'Download' && row.claim_type === 'Click');
  if (!result) throw new Error(`Missing synthetic Download/Click outcome in ${fixture}`);
  return result;
}

describe('Apple Ads exact HogQL synthetic validation', () => {
  it.each(Object.keys(appleAdsFixtures) as (keyof typeof appleAdsFixtures)[])(
    '%s matches the exact query executed by PostHog',
    (fixture) => {
      expect(recorded.fixtures[fixture].querySha256).toBe(
        createHash('sha256').update(appleAdsFixtures[fixture]).digest('hex'),
      );
    },
  );

  it('deduplicates report rows, excludes null placeholders and keeps currencies separate', () => {
    const aud = rows('delivery').find((row) => row.currency === 'AUD');
    const usd = rows('delivery').find((row) => row.currency === 'USD');
    expect(aud).toMatchObject({
      spend: '22',
      reporting_days: '2',
      installs: '14',
      tap_installs: '9',
      view_installs: '5',
    });
    expect(usd).toMatchObject({ spend: '5', reporting_days: '1', installs: '3' });
  });

  it('does not publish inflated totals when one daily key has conflicting versions', () => {
    expect(rows('conflictingDelivery').find((row) => row.currency === 'AUD')).toMatchObject({
      conflicting_daily_rows: '1',
      spend: null,
      installs: null,
      cost_per_reported_install: null,
    });
  });

  it('computes residual from all named-keyword rows without a display limit', () => {
    expect(rows('keywords').find((row) => row.keyword_id === 'keyword-a')).toMatchObject({ spend: '10' });
    expect(rows('unmappedSpend').find((row) => row.currency === 'AUD')).toMatchObject({
      campaign_spend: '22',
      named_keyword_spend: '14',
      unmapped_spend: '8',
    });
    expect(appleAdsUnmappedSpendQuery().match(/LIMIT \d+/g)).toEqual(['LIMIT 100']);
  });

  it('includes a selected end-of-day but preserves exact-midnight exclusivity', () => {
    expect(rows('inclusiveReportEnd').find((row) => row.currency === 'AUD')).toMatchObject({
      reporting_days: '2',
      spend: '22',
    });
    expect(rows('exclusiveReportEnd').find((row) => row.currency === 'AUD')).toMatchObject({
      reporting_days: '1',
      spend: '10',
    });
  });

  it('retains missing-screen people and separates redownload, impression and unknown evidence', () => {
    expect(
      rows('coverage').find((row) => row.conversion_type === 'Download' && row.claim_type === 'Click'),
    ).toMatchObject({
      attributed_people: '9',
      unidentified_people: '7',
      without_captured_screen: '1',
    });
    expect(rows('coverage').find((row) => row.claim_type === 'Impression')).toMatchObject({
      attributed_people: '1',
      unknown_keyword_people: '1',
      unknown_country_people: '1',
    });
    expect(rows('coverage').find((row) => row.conversion_type === 'Redownload')).toMatchObject({
      attributed_people: '1',
    });
    expect(rows('outcomes').some((row) => row.conversion_type === 'Redownload')).toBe(false);
  });

  it('uses current attribution for earlier events and counts pre-screen verified receipts once', () => {
    expect(downloadClickOutcome('outcomes')).toMatchObject({
      clean_newcomers: '8',
      observed_signup_people: '2',
      eligible_7d: '7',
      board_active_7d: '3',
      eligible_14d: '5',
      returned_days7_13: '1',
      eligible_28d: '3',
      two_board_days_28d: '2',
      eligible_56d: '2',
      returned_days28_55: '1',
    });
    const sources = liveAppleAdsSources(APPLE_ADS_FIXTURE_WINDOW);
    expect(sources.people).toContain('FROM persons');
    expect(sources.people).toContain("properties.apple_ads_attribution_status = 'attributed'");
    expect(sources.activity).not.toContain('person.properties.apple_ads_');
    expect(sources.observedPeople).not.toContain('event IN');
    expect(sources.observedPeople).toContain('FROM events');
    expect(sources.registrations).toContain('INTERVAL 365 DAY');
    expect(sources.registrations).not.toContain(APPLE_ADS_FIXTURE_WINDOW.from);
  });

  it('counts a real spray-wall action while excluding save and unrelated restore triggers', () => {
    expect(downloadClickOutcome('outcomes')).toMatchObject({ spray_active_7d: '1' });
  });

  it('caps maturity and event observation at a stale model cutoff', () => {
    expect(downloadClickOutcome('staleOutcomes')).toMatchObject({
      clean_newcomers: '7',
      eligible_7d: '5',
      board_active_7d: '2',
      eligible_28d: '2',
      eligible_56d: '0',
      return_days28_55_percent: null,
    });
  });

  it('shows missing freshness as null instead of an epoch date', () => {
    expect(rows('emptyFreshness')).toHaveLength(3);
    expect(rows('emptyFreshness').every((row) => row.latest_observation === null)).toBe(true);
  });

  it('keeps target-release auth evidence visible despite over 100 newer screen-only OTA groups', () => {
    expect(rows('authQuality')).toHaveLength(2);
    expect(rows('authQuality')[0]).toMatchObject({
      app_version: '2.7.0',
      ota_update_id: 'target-270-ota',
      login_attempters: '1',
      login_success_people: '1',
      signup_people: '1',
      board_active_people: '1',
      latest_event_utc: '2026-10-31T23:53:00Z',
      measurement_status: 'Awaiting verified release evidence',
    });
    expect(rows('authQuality')[1]).toMatchObject({
      app_version: '2.6.0',
      login_attempters: '1',
      login_success_people: '0',
      measurement_status: 'Known incomplete auth measurement; do not infer signup conversion',
    });
  });

  it('preserves all-source IDs and exposes the unverified release and limited diagnostic', () => {
    expect(appleAdsDashboard.baselineInsightIds).toEqual([
      12710428, 12710441, 12710442, 12710444, 12710446, 12710447, 12710450,
    ]);
    expect(appleAdsDashboard.intro.body).toContain('awaiting verified release evidence');
    expect(appleAdsDashboard.additions.find((insight) => insight.key === 'auth-counts')?.description).toContain(
      'Top 25',
    );
    expect(appleAdsDashboard.additions.every((insight) => !/cost per (signup|climber)/i.test(insight.name))).toBe(true);
  });

  it('leads tables with decision metrics and formats existing 0–100 rates without rescaling', () => {
    const delivery = appleAdsDashboard.additions.find((insight) => insight.key === 'delivery');
    if (delivery?.query.kind !== 'DataVisualizationNode') throw new Error('Missing delivery table');
    expect(delivery.query.tableSettings?.columns.slice(0, 4).map((entry) => entry.column)).toEqual([
      'campaign_name',
      'currency',
      'spend',
      'installs',
    ]);
    expect(
      delivery.query.tableSettings?.columns.find((entry) => entry.column === 'view_install_percent')?.settings
        .formatting,
    ).toEqual({
      style: 'number',
      decimalPlaces: 2,
      suffix: '%',
    });
    expect(delivery.query.tableSettings?.columns.every((entry) => !('display' in entry.settings))).toBe(true);
  });
});
