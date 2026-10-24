/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { communityFixtures } from './community-fixtures';
import { communityQueries, liveSources } from './community-queries';

type FixtureName = keyof typeof communityFixtures;

const recorded = JSON.parse(readFileSync(new URL('./community-fixture-validation.json', import.meta.url), 'utf8')) as {
  fixtures: Record<FixtureName, { querySha256: string; rows: Record<string, string>[] }>;
};

function rows(fixture: FixtureName) {
  return recorded.fixtures[fixture].rows;
}

describe('community recap queries: results PostHog returned for the exact fixture HogQL', () => {
  it.each(Object.keys(communityFixtures) as FixtureName[])('%s still matches the query PostHog ran', (fixture) => {
    expect(createHash('sha256').update(communityFixtures[fixture]).digest('hex')).toBe(
      recorded.fixtures[fixture].querySha256,
    );
  });

  it('labels the running month and keeps every month in order', () => {
    expect(rows('monthlyPeople').map((row) => row.month_label)).toEqual(['2026-10', '2026-11', '2026-12 (so far)']);
    expect(rows('monthlyClimbs').map((row) => row.month_label)).toEqual(['2026-10', '2026-11', '2026-12 (so far)']);
  });

  it('ranks the latest complete month, drops padding rows and shows movement', () => {
    expect(rows('topGyms').map((row) => [row.month, row.rank, row.gym, row.vs_last_month, row.link])).toEqual([
      ['2026-11', '1', 'Gym A', '+2', 'https://boardsesh.com/gym/gym-a'],
      ['2026-11', '2', 'Crag B', '-1', 'https://boardsesh.com/gym/crag-b'],
      ['2026-11', '3', 'No Link Gym', 'new', ''],
    ]);
  });

  it('shows an unnamed climber as anonymous with no movement', () => {
    expect(rows('topClimbers').map((row) => [row.rank, row.climber, row.vs_last_month])).toEqual([
      ['1', 'Sam', '+1'],
      ['2', 'Anonymous climber', ''],
      ['3', 'Alex', 'new'],
    ]);
  });

  it('writes a post with separators, the 30-day line and linked gyms', () => {
    const [post] = rows('redditPost');
    expect(post.reddit_post).toContain('**Boardsesh in November 2026**');
    expect(post.reddit_post).toContain('2,104 climbers lit 1,234,567 climbs on their boards (+2369% on last month)');
    expect(post.reddit_post).toContain('3,105 climbers used Boardsesh in the last 30 days');
    expect(post.reddit_post).toContain('1. [Gym A](https://boardsesh.com/gym/gym-a): 1,500 climbers');
    expect(post.reddit_post).toContain('2. Anonymous climber: 380 sends');
    expect(post.reddit_post).not.toContain('Running Month Gym');
  });
});

describe('community recap queries: live sources', () => {
  it('keeps only the newest copy of each re-sent event', () => {
    for (const source of [liveSources.summary, liveSources.ranks, liveSources.activeUsers]) {
      expect(source).toContain('ORDER BY created_at DESC');
      expect(source).toContain('LIMIT 1 BY uuid');
    }
  });

  it('reads only the system actors that send these aggregates', () => {
    expect(liveSources.summary).toContain(`distinct_id = 'system:community-monthly'`);
    expect(liveSources.ranks).toContain(`distinct_id = 'system:community-monthly'`);
    expect(liveSources.activeUsers).toContain(`distinct_id = 'system:active-users'`);
  });

  it.each(Object.keys(communityQueries) as (keyof typeof communityQueries)[])(
    '%s never splits climbers by board brand',
    (name) => {
      const query = communityQueries[name]();
      expect(query).not.toMatch(/board_?type|kilter|tension|moonboard/i);
    },
  );
});
