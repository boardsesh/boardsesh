/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { growthFixtures } from './growth-fixtures';

interface RecordedFixture {
  querySha256: string;
  rows: Record<string, string | null>[];
}
const recorded = JSON.parse(readFileSync(new URL('./fixture-validation.json', import.meta.url), 'utf8')) as {
  fixtures: Record<keyof typeof growthFixtures, RecordedFixture>;
};

function rows(fixture: keyof typeof growthFixtures) {
  return recorded.fixtures[fixture].rows;
}
function person(personId: string) {
  const result = rows('milestones').find((row) => row.person_id === personId);
  if (!result) throw new Error(`Missing synthetic person ${personId}`);
  return result;
}

describe('growth queries: results from exact HogQL executed on synthetic fixtures', () => {
  it.each(Object.keys(growthFixtures) as (keyof typeof growthFixtures)[])(
    '%s still matches the query validated by PostHog',
    (fixture) => {
      expect(createHash('sha256').update(growthFixtures[fixture]).digest('hex')).toBe(
        recorded.fixtures[fixture].querySha256,
      );
    },
  );

  it('counts each distinct day at bucket boundaries and computes a weighted total', () => {
    expect(rows('buckets').map((row) => [row.previous_users, row.returning_users])).toEqual([
      ['1', '1'],
      ['2', '1'],
      ['2', '1'],
      ['1', '1'],
      ['6', '4'],
    ]);
    expect(rows('buckets').at(-1)?.return_percent).toBe('66.67');
    expect(rows('buckets').at(-1)?.share_percent).toBe('100.0');
    expect(rows('buckets').every((row) => row.exclusive_end === '2026-10-09')).toBe(true);
  });

  it('does not publish a partially refreshed next window at the grid boundary', () => {
    expect(rows('staleBuckets')).toEqual(rows('buckets'));
  });

  it('orders registration before board days while reporting independent board usage', () => {
    expect(person('pre-registration-day').board_days_first28).toBe('2');
    expect(person('pre-registration-day').ordered_board_days_first28).toBe('1');
    expect(person('no-registration').board_days_first28).toBe('2');
    expect(person('no-registration').ordered_board_days_first28).toBe('0');
    expect(person('ordered-four').ordered_board_days_first28).toBe('4');
    expect(person('ordered-four').board_sends_first28).toBe('6');
    expect(person('ordered-four').board_day28).toBe('1');
    expect(person('ordered-four').board_next28).toBe('1');
    expect(person('earliest-web').board_sends_first28).toBe('1');
  });

  it('uses explicit registration over conflicting account dates and tolerates invalid dates', () => {
    expect(person('ordered-four').registered_first28).toBe('1');
    expect(person('property-registration').registered_first28).toBe('1');
    expect(person('invalid-account-date').registered_at).toBeNull();
  });

  it('preserves the earliest verified source and leaves unmatched installs and iOS unknown', () => {
    expect(person('earliest-web').acquisition_source).toBe('Reddit / community');
    expect(person('earliest-web').first_campaign).toBe('first-community');
    expect(person('earliest-web').attribution_evidence).toBe('identity-linked first web landing');
    expect(person('known-play').acquisition_source).toBe('Organic Google Play');
    expect(person('old-install').acquisition_source).toBe('Direct / unknown');
    expect(person('ios-is-unknown').acquisition_source).toBe('Direct / unknown');
  });

  it('uses common mature funnel denominators and previous-stage conversion', () => {
    const preview = rows('activation').filter((row) => row.observation === 'First 28 days (preview)');
    expect(preview.map((row) => row.users)).toEqual(['3', '2', '2', '2', '1']);
    expect(preview.every((row) => row.eligible_users === '3')).toBe(true);
    expect(preview.at(-1)?.previous_stage_conversion_percent).toBe('50.0');
    expect(
      rows('activation')
        .filter((row) => row.observation === 'Full 56-day funnel')
        .every((row) => row.eligible_users === '1'),
    ).toBe(true);
  });

  it('distinguishes full cohort size from eligible users and keeps pending cells null', () => {
    const cohort = rows('cohortMaturity').filter((row) => row.acquisition_week === '2026-09-07');
    expect(cohort[0]).toMatchObject({
      cohort_size: '3',
      eligible_users: '2',
      retained_users: '2',
      retention_percent: '100.0',
    });
    expect(cohort[1]).toMatchObject({
      cohort_size: '3',
      eligible_users: '0',
      retained_users: '0',
      retention_percent: null,
      status: 'Pending',
    });
  });

  it('requires 29 complete days for exact Day28, independently of 28- and 56-day metrics', () => {
    expect(rows('sourceMaturity')[0]).toMatchObject({
      new_users: '4',
      eligible_28d: '3',
      eligible_day28: '2',
      eligible_56d: '1',
      board_day28_percent: '50.0',
      board_next28_percent: '100.0',
      average_board_days: '2.0',
    });
  });
});
