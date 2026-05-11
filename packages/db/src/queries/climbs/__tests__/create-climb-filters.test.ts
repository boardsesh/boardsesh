import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import { createClimbFilters } from '../create-climb-filters';
import type { BoardRouteParams, ClimbSearchParams } from '../types';

const params: BoardRouteParams = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  angle: 40,
};

const baseSearch: ClimbSearchParams = {};

/**
 * Flatten a Drizzle SQL fragment into a single inspectable string so tests can
 * assert on the actual SQL produced, not just that *some* condition exists.
 *
 * queryChunks is a mix of:
 *   - { value: ['literal sql'] }
 *   - { name: 'column_name' } (Column/Table instances)
 *   - nested SQL fragments with their own queryChunks
 *   - param markers ({ value: <runtime val> })
 */
function sqlToString<T>(fragment: SQL<T>): string {
  const chunks = (fragment as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
        return String(chunk);
      }
      if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) {
        return sqlToString(chunk as SQL);
      }
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const value = (chunk as { value: unknown }).value;
        if (Array.isArray(value)) return value.join('');
        return String(value);
      }
      if (chunk && typeof chunk === 'object' && 'name' in chunk) {
        return String((chunk as { name: unknown }).name);
      }
      return '';
    })
    .join('');
}

void describe('createClimbFilters: projectsOnly', () => {
  void it('produces no projectsOnly condition by default', () => {
    const f = createClimbFilters(params, baseSearch);
    assert.equal(f.projectsOnlyConditions.length, 0);
  });

  void it('emits a COALESCE(ascensionist_count, 0) = 0 condition when projectsOnly is on', () => {
    const f = createClimbFilters(params, { projectsOnly: true });
    assert.equal(f.projectsOnlyConditions.length, 1);
    const rendered = sqlToString(f.projectsOnlyConditions[0]);
    // Match both the column reference and the zero-equality shape so a future
    // refactor that swaps the condition fails the test.
    assert.match(rendered, /COALESCE/i);
    assert.match(rendered, /ascensionist_count/);
    assert.match(rendered, /= 0/);
  });

  void it('adds the projectsOnly condition to the climb WHERE array', () => {
    const baseline = createClimbFilters(params, baseSearch).getClimbWhereConditions();
    const withProjects = createClimbFilters(params, {
      projectsOnly: true,
    }).getClimbWhereConditions();
    assert.equal(withProjects.length, baseline.length + 1);
    // The new entry must be the COALESCE zero-ascents condition.
    const rendered = withProjects.map(sqlToString).join(' || ');
    assert.match(rendered, /COALESCE[^|]*ascensionist_count[^|]*= 0/i);
  });

  void it('skips the minAscents stats condition when projectsOnly is on (prevents contradictory SQL)', () => {
    const f = createClimbFilters(params, { projectsOnly: true, minAscents: 10 });
    // No stats condition should reference ascensionist_count >= 10 when projectsOnly is on.
    const rendered = f.climbStatsConditions.map(sqlToString).join(' || ');
    assert.doesNotMatch(rendered, /ascensionist_count/);
  });

  void it('emits ascensionist_count >= N when projectsOnly is off and minAscents is set', () => {
    const f = createClimbFilters(params, { projectsOnly: false, minAscents: 10 });
    assert.equal(f.climbStatsConditions.length, 1);
    const rendered = sqlToString(f.climbStatsConditions[0]);
    assert.match(rendered, /ascensionist_count/);
    // Drizzle's gte renders as "... >= $param"; the literal operator is enough
    // to confirm we're asserting on the comparison, not some unrelated predicate.
    assert.match(rendered, />=/);
  });

  void it('keeps stats conditions empty so the stats-driven INNER JOIN path is not selected by projectsOnly alone', () => {
    // search-climbs uses climbStatsConditions.length > 0 to pick the INNER JOIN
    // fast path. projectsOnly must live outside climbStatsConditions so climbs
    // with no stats row are not dropped by the INNER JOIN.
    const f = createClimbFilters(params, { projectsOnly: true });
    assert.equal(f.climbStatsConditions.length, 0);
  });
});

void describe('createClimbFilters: minRating', () => {
  const ratingScaleCases: Array<{ minRating: number; expectedThreshold: string }> = [
    { minRating: 1, expectedThreshold: '0.2' },
    { minRating: 4, expectedThreshold: '0.8' },
    { minRating: 5, expectedThreshold: '1' },
  ];

  for (const { minRating, expectedThreshold } of ratingScaleCases) {
    void it(`scales minRating ${minRating} to stored threshold ${expectedThreshold}`, () => {
      const filters = createClimbFilters(params, { minRating });
      assert.equal(filters.climbStatsConditions.length, 1);

      const rendered = sqlToString(filters.climbStatsConditions[0]);
      assert.match(rendered, /quality_average/);
      assert.match(rendered, />=/);
      assert.match(rendered, new RegExp(`>=\\s*${expectedThreshold}`));
      assert.doesNotMatch(rendered, new RegExp(`>=\\s*${minRating}(?:\\D|$)`));
    });
  }

  void it('does not append a rating filter when minRating is 0', () => {
    const filters = createClimbFilters(params, { minRating: 0 });
    assert.equal(filters.climbStatsConditions.length, 0);
  });

  void it('does not append a rating filter when minRating is undefined', () => {
    const filters = createClimbFilters(params, {});
    assert.equal(filters.climbStatsConditions.length, 0);
  });
});

void describe('createClimbFilters: personal progress filters are scoped to the current angle', () => {
  // Locks in the angle-scoping contract — a send at one angle must not leak
  // into hide/show filters at a different angle. Each filter renders a
  // (NOT) EXISTS subquery against boardsesh_ticks that must restrict by
  // the `angle` column.
  const userId = 'user-abc';
  const angleParams: BoardRouteParams = { ...params, angle: 50 };

  function progressSql(searchParams: ClimbSearchParams): string {
    const f = createClimbFilters(angleParams, searchParams, userId);
    return f.personalProgressConditions.map(sqlToString).join(' && ');
  }

  void it('emits exactly one progress condition per active filter', () => {
    const f = createClimbFilters(angleParams, { hideCompleted: true }, userId);
    assert.equal(f.personalProgressConditions.length, 1);
  });

  void it('hideCompleted is a NOT EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ hideCompleted: true });
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    // Sanity: targets completions (flash/send), not attempts.
    assert.match(sql, /'flash'.*'send'/);
    assert.doesNotMatch(sql, /'attempt'/);
  });

  void it('hideAttempted is a NOT EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ hideAttempted: true });
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    assert.match(sql, /'attempt'/);
  });

  void it('showOnlyCompleted is a positive EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ showOnlyCompleted: true });
    assert.match(sql, /EXISTS/);
    assert.doesNotMatch(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    assert.match(sql, /'flash'.*'send'/);
  });

  void it('showOnlyAttempted is a positive EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ showOnlyAttempted: true });
    assert.match(sql, /EXISTS/);
    assert.doesNotMatch(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    assert.match(sql, /'attempt'/);
  });

  void it('skips personal progress conditions entirely when no userId is supplied', () => {
    const f = createClimbFilters(angleParams, { hideCompleted: true });
    assert.equal(f.personalProgressConditions.length, 0);
  });

  void it('per-climb userAscents/userAttempts selectors are scoped to the angle column', () => {
    const f = createClimbFilters(angleParams, baseSearch, userId);
    const selects = f.getUserLogbookSelects();
    const ascentsSql = sqlToString(selects.userAscents);
    const attemptsSql = sqlToString(selects.userAttempts);
    assert.match(ascentsSql, /angle\s*=/);
    assert.match(attemptsSql, /angle\s*=/);
    // And the status sets must still match the semantic of each selector.
    assert.match(ascentsSql, /'flash'.*'send'/);
    assert.match(attemptsSql, /'attempt'/);
  });
});

void describe('createClimbFilters: minUserQuality / hideWithoutUserQuality', () => {
  const userId = 'user-abc';
  const angleParams: BoardRouteParams = { ...params, angle: 50 };

  function progressSql(searchParams: ClimbSearchParams): string {
    const f = createClimbFilters(angleParams, searchParams, userId);
    return f.personalProgressConditions.map(sqlToString).join(' && ');
  }

  void it('emits no user-quality condition when both fields are at defaults', () => {
    const f = createClimbFilters(angleParams, {}, userId);
    // The four normal progress filters are all off by default, so this should
    // be empty too.
    assert.equal(f.personalProgressConditions.length, 0);
  });

  void it('minUserQuality with switch OFF: NOT EXISTS clause that allows unrated climbs', () => {
    const sql = progressSql({ minUserQuality: 4 });
    assert.match(sql, /NOT EXISTS/);
    // The threshold predicate must use < (so climbs rated >= threshold AND
    // climbs the user hasn't rated both pass through).
    assert.match(sql, /quality\s*<\s*4/);
  });

  void it('hideWithoutUserQuality with no threshold: positive EXISTS, no quality predicate', () => {
    const sql = progressSql({ hideWithoutUserQuality: true });
    assert.match(sql, /EXISTS/);
    assert.doesNotMatch(sql, /NOT EXISTS/);
    // Without a min threshold there should be no `quality >= N` predicate.
    assert.doesNotMatch(sql, /quality\s*>=/);
    // Nor a `quality <` predicate that would belong to the negative branch.
    assert.doesNotMatch(sql, /quality\s*</);
  });

  void it('minUserQuality + hideWithoutUserQuality: positive EXISTS with quality >= threshold', () => {
    const sql = progressSql({ minUserQuality: 3, hideWithoutUserQuality: true });
    assert.match(sql, /EXISTS/);
    assert.doesNotMatch(sql, /NOT EXISTS/);
    assert.match(sql, /quality\s*>=\s*3/);
  });

  void it('user-quality conditions are NOT scoped to the angle column (quality is angle-independent)', () => {
    // angleParams has angle=50; if the subquery scoped on angle it would
    // render `angle = 50` like the personal-progress filters do.
    const qualitySql = progressSql({ minUserQuality: 4 });
    const progressOnlySql = progressSql({ hideCompleted: true });
    // hideCompleted *does* scope by angle — sanity-check the negative space.
    assert.match(progressOnlySql, /angle\s*=\s*50/);
    // minUserQuality must not.
    assert.doesNotMatch(qualitySql, /angle\s*=\s*50/);
  });

  void it('skips user-quality conditions entirely when no userId is supplied', () => {
    const f = createClimbFilters(angleParams, { minUserQuality: 4, hideWithoutUserQuality: true });
    assert.equal(f.personalProgressConditions.length, 0);
  });
});
