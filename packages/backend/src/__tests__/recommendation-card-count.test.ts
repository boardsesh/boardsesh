import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  buildRecommendationCountSql,
  buildRecommendationRefsSql,
  buildRecommendationSentOverlapSql,
  recommendationStatsConditions,
  type BoardTarget,
  type RecommendationQueryParams,
  type RecommendationType,
  type SerialPlanDb,
} from '@boardsesh/db/queries';

const { state, fakeTx } = vi.hoisted(() => {
  const state = {
    render: (_statement: unknown): string => '',
    executed: [] as string[],
    rowsFor: (_renderedSql: string): unknown[] => [],
  };
  const fakeTx = {
    execute: (statement: unknown) => {
      const rendered = state.render(statement);
      state.executed.push(rendered);
      return Promise.resolve(state.rowsFor(rendered));
    },
  };
  return { state, fakeTx };
});

vi.mock('../db/client', () => ({ db: fakeTx, dbRead: fakeTx }));
import { countRecommendationCardClimbs } from '../graphql/resolvers/playlists/helpers/recommendation-refs';

const dialect = new PgDialect();
state.render = (statement: unknown) => dialect.sqlToQuery(statement as SQL).sql;
const render = (statement: SQL) => dialect.sqlToQuery(statement).sql;

const TARGET: BoardTarget = { boardType: 'kilter', layoutId: 1, sizeId: 10, angle: 40, setIds: [20, 1] };
const tx = fakeTx as unknown as SerialPlanDb;

const isGradeBand = (renderedSql: string) => /max_difficulty/.test(renderedSql);

function paramsFor(type: RecommendationType, overrides: Partial<RecommendationQueryParams> = {}) {
  return {
    type,
    target: TARGET,
    shorterSizeIds: [],
    narrowerSameHeightSizeIds: [],
    gradeBand: type === 'RECOMMENDED_AT_LEVEL' ? { minDifficultyId: 18, maxDifficultyId: 22 } : null,
    excludeUserId: 'user-1',
    freshWindowDays: 365,
    ...overrides,
  } satisfies RecommendationQueryParams;
}

beforeEach(() => {
  state.executed.length = 0;
  state.rowsFor = () => [{ count: 284 }];
});

describe('countRecommendationCardClimbs', () => {
  it('re-reads current authorization on every request after revocation', async () => {
    expect(await countRecommendationCardClimbs('RECOMMENDED_CROWD_FAVORITES', TARGET, 'user-1', tx)).toBe(284);
    state.rowsFor = () => [{ count: 5 }];
    expect(await countRecommendationCardClimbs('RECOMMENDED_CROWD_FAVORITES', TARGET, 'user-1', tx)).toBe(5);
    expect(state.executed).toHaveLength(2);
    expect(
      state.executed.every(
        (statement) => statement.includes('content_privacy') && statement.includes('privacy_revision'),
      ),
    ).toBe(true);
  });
  it('uses the same privacy filter for list, count and sent overlap', () => {
    for (const query of [
      buildRecommendationRefsSql(paramsFor('RECOMMENDED_FRESH'), 0, 10),
      buildRecommendationCountSql(paramsFor('RECOMMENDED_FRESH')),
      buildRecommendationSentOverlapSql(paramsFor('RECOMMENDED_FRESH'), 'user-1'),
    ]) {
      expect(render(query)).toContain('privacy_content.public_consent_revision = privacy_profile.privacy_revision');
      expect(dialect.sqlToQuery(query).params).toContain('user-1');
    }
  });
  it('resolves the personal grade band before its authorized count', async () => {
    state.rowsFor = (statement) =>
      isGradeBand(statement) ? [{ board_type: 'kilter', max_difficulty: 20 }] : [{ count: 50 }];
    expect(await countRecommendationCardClimbs('RECOMMENDED_AT_LEVEL', TARGET, 'user-1', tx)).toBe(50);
    expect(state.executed).toHaveLength(2);
  });
});

describe('recommendation count SQL', () => {
  it.each(['RECOMMENDED_CROWD_FAVORITES', 'RECOMMENDED_AT_LEVEL'] as const)(
    '%s is driven from a MATERIALIZED stats CTE with sargable bounds',
    (type) => {
      const rendered = render(buildRecommendationCountSql(paramsFor(type)));
      expect(rendered).toContain('WITH cand AS MATERIALIZED');
      expect(rendered).toContain('s.quality_average >=');
      expect(rendered).not.toContain('COALESCE(s.quality_average, 0) >=');
      expect(rendered).toContain('NOT EXISTS');
    },
  );

  it.each(['RECOMMENDED_HIDDEN_GEMS', 'RECOMMENDED_FRESH'] as const)('%s keeps the catalog-driven plan', (type) => {
    const rendered = render(buildRecommendationCountSql(paramsFor(type)));
    expect(rendered).not.toContain('MATERIALIZED');
    expect(rendered).toMatch(/FROM board_climbs bc/);
  });

  it('drops the viewer exclusion for the cached catalog half', () => {
    const rendered = render(
      buildRecommendationCountSql(paramsFor('RECOMMENDED_CROWD_FAVORITES', { excludeUserId: null })),
    );
    expect(rendered).not.toContain('boardsesh_ticks');
  });

  it('drives the overlap from the viewer ticks and skips the stats join for FRESH', () => {
    const fresh = render(buildRecommendationSentOverlapSql(paramsFor('RECOMMENDED_FRESH'), 'user-1'));
    expect(fresh).toMatch(
      /SELECT t\.board_type, t\.climb_uuid, MAX\(COALESCE\(t\.climb_revision, 1\)\) AS latest_sent_revision\s+FROM boardsesh_ticks t/,
    );
    expect(fresh).not.toContain('board_climb_stats');
    const crowd = render(buildRecommendationSentOverlapSql(paramsFor('RECOMMENDED_CROWD_FAVORITES'), 'user-1'));
    expect(crowd).toContain('JOIN board_climb_stats s');
    expect(crowd).not.toContain('LEFT JOIN board_climb_stats');
  });

  it('reads only sends on the climb’s current holds, in the exclusion and in the overlap (#6023)', () => {
    // The two halves must agree or `catalog count - overlap` is not the excluded count.
    const excluded = render(buildRecommendationCountSql(paramsFor('RECOMMENDED_FRESH')));
    expect(excluded).toContain('COALESCE(t.climb_revision, 1) >= bc.holds_revision_number');
    const overlap = render(buildRecommendationSentOverlapSql(paramsFor('RECOMMENDED_FRESH'), 'user-1'));
    expect(overlap).toContain('COALESCE(sent.latest_sent_revision, 0) >= bc.holds_revision_number');
    // board_climbs is joined once, for the catalogue filter; the epoch rides on it.
    expect(overlap).toContain('JOIN board_climbs bc');
    // Grouped and joined on the board type as well as the uuid.
    expect(overlap).toContain('GROUP BY t.board_type, t.climb_uuid');
    expect(overlap).toContain('JOIN board_climbs bc ON bc.board_type = sent.board_type AND bc.uuid = sent.climb_uuid');
  });

  it('leaves the ranked page query unchanged in shape', () => {
    const rendered = render(buildRecommendationRefsSql(paramsFor('RECOMMENDED_CROWD_FAVORITES'), 0, 20));
    expect(rendered).toContain('COALESCE(s.quality_average, 0) >=');
    expect(rendered).toContain('LEFT JOIN board_setter_stats ss');
    expect(rendered).not.toContain('MATERIALIZED');
  });

  it('refuses sargable bounds that would change the count', () => {
    expect(() => recommendationStatsConditions({ minQuality: 0, minAscents: 20 }, true)).toThrow();
    expect(() => recommendationStatsConditions({ minQuality: 4, minAscents: 0 }, true)).toThrow();
    expect(() => recommendationStatsConditions({ minQuality: 0, minAscents: 0 }, false)).not.toThrow();
  });
});
