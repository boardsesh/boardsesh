import { describe, expect, it } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, sql, type SQL } from 'drizzle-orm';
import {
  createClimbFilters,
  personalGradeRangeCondition,
  buildPersonalGradeJoinTarget,
  effectiveDifficultySql,
  personalGradeColumnSql,
  crowdGradeSql,
  clampToBoulderScaleSql,
  PERSONAL_GRADE_ALIAS,
  PERSONAL_GRADE_MIN_ID,
  PERSONAL_GRADE_MAX_ID,
  type BoardRouteParams,
  type ClimbSearchParams,
  type PersonalGradeScope,
} from '@boardsesh/db/queries';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';

/**
 * Personal grades (#4796 / #4828) are a rule, not a query: "the difficulty of
 * the climber's LATEST graded tick for (user, board_type, climb_uuid, angle),
 * clamped, falling back to the crowd's rounded display difficulty".
 *
 * The failure this file guards is a row that READS V10 while a V9-V11 filter
 * hides it — which is what happens the moment one read path states the rule
 * differently from another. The repo has shipped exactly that once already,
 * with the Boardsesh-grade toggle: rows displayed one grade while the filter
 * and the sort still keyed `display_difficulty`.
 *
 * So this suite renders SQL and compares STRINGS rather than trusting that the
 * call sites happen to call the same helper. `getClimbWhereConditions()` is
 * what both searchClimbs paths and countClimbs spread into their own `and(...)`,
 * so rendering it here is rendering exactly what those queries send. The
 * end-to-end "the count agrees with the list" check is DB-backed and lives in
 * climb-queries.test.ts — asserting it here would only be this file rendering
 * the same builder twice.
 */

const dialect = new PgDialect();

function render(condition: SQL): string {
  return dialect.sqlToQuery(condition).sql;
}

/** Whitespace-collapsed, lower-cased SQL, for substring assertions on shape. */
function normalized(condition: SQL): string {
  return normalizeSql(render(condition));
}

/**
 * Same, for an already-rendered string, with placeholder NUMBERS erased.
 *
 * `$7` vs `$1` is only where the fragment happens to sit in the surrounding
 * WHERE — it says nothing about the predicate. Erasing the index is what lets
 * "the fragment the shared helper emits" be compared against "the fragment the
 * filter builder actually put in the query"; the bound VALUES are asserted
 * separately, off `sqlToQuery().params`.
 */
function normalizeSql(rendered: string): string {
  return rendered.replace(/\s+/g, ' ').replace(/\$\d+/g, '$?').toLowerCase();
}

const USER_ID = 'grade-rule-user';

const boardParams: BoardRouteParams = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 7,
  set_ids: [1, 2],
  angle: 40,
};

const scope: PersonalGradeScope = {
  boardType: boardParams.board_name,
  angle: boardParams.angle,
  userId: USER_ID,
};

function search(overrides: Partial<ClimbSearchParams> = {}): ClimbSearchParams {
  return { page: 0, pageSize: 20, sortBy: 'difficulty', sortOrder: 'asc', ...overrides };
}

function renderedWhere(searchParams: ClimbSearchParams, userId: string | undefined): string {
  const filters = createClimbFilters(boardParams, searchParams, userId);
  return render(and(...filters.getClimbWhereConditions())!);
}

describe('personal grade rule: one predicate, every site', () => {
  const boundCases = [
    { name: 'both bounds', minGrade: 22, maxGrade: 28 },
    { name: 'min only', minGrade: 22, maxGrade: undefined },
    { name: 'max only', minGrade: undefined, maxGrade: 28 },
  ] as const;

  for (const boundCase of boundCases) {
    describe(boundCase.name, () => {
      const searchParams = search({
        useMyGrades: true,
        minGrade: boundCase.minGrade,
        maxGrade: boundCase.maxGrade,
      });
      const sharedPredicate = personalGradeRangeCondition(boundCase.minGrade, boundCase.maxGrade)!;
      const expectedShape = normalizeSql(render(sharedPredicate));

      it('the filter builder emits exactly the shared predicate', () => {
        expect(normalizeSql(renderedWhere(searchParams, USER_ID))).toContain(expectedShape);
      });

      it('filters on the same COALESCE the sort orders by', () => {
        expect(expectedShape).toContain(normalized(effectiveDifficultySql()));
      });

      it('names the joined subquery, so it cannot bind to a stray "difficulty" column', () => {
        expect(expectedShape).toContain('coalesce("my_grade"."difficulty"');
        expect(expectedShape).not.toMatch(/coalesce\(\s*"difficulty"/);
      });

      it('stays a bare range test — no sublink to trap the crowd-grade bounds inside an OR', () => {
        // A sublink under an OR is never unnested, and it drags the crowd
        // grade-range out of the board_climb_stats scan with it: measured at
        // 1225ms / 288k shared buffers versus 823ms / 38k for this shape.
        expect(expectedShape).not.toContain('exists');
        expect(expectedShape).not.toContain(' or ');
        expect(expectedShape).not.toContain('select');
      });
    });
  }

  describe('the joined subquery', () => {
    const joinTarget = buildPersonalGradeJoinTarget(scope);
    // Interpolating the subquery renders it exactly as the join site does:
    // `(select distinct on … ) "my_grade"`.
    const built = dialect.sqlToQuery(sql`${joinTarget.subquery}`);
    const subquerySql = normalizeSql(built.sql);

    it('resolves the LATEST grade per climb, never the hardest', () => {
      // "Latest" is spelled DISTINCT ON + an ordering, not an aggregate: a
      // stiff grade from one bad day must not stick forever.
      expect(subquerySql).toContain('distinct on ("boardsesh_ticks"."climb_uuid")');
      expect(subquerySql).toContain('"boardsesh_ticks"."climbed_at" desc');
      expect(subquerySql).not.toMatch(/\bmax\s*\(\s*"?boardsesh_ticks"?\."?difficulty/);
    });

    it('tie-breaks on uuid, not the bigserial id', () => {
      // Only `uuid` reaches the client, and pickLatestGradedTick orders by it.
      // Ordering on `id` here would let the two disagree whenever two ticks
      // share a climbed_at.
      expect(subquerySql).toContain('"boardsesh_ticks"."uuid" desc');
      expect(subquerySql).not.toContain('"boardsesh_ticks"."id" desc');
    });

    it('orders with bare DESC so the covering index needs no Sort', () => {
      // boardsesh_ticks_user_grade_latest_idx declares DESC NULLS FIRST, which
      // is what a bare DESC means. `desc nulls last` here would not match those
      // pathkeys and Postgres would stack an Incremental Sort on the scan.
      expect(subquerySql).not.toContain('desc nulls last');
    });

    it('tests difficulty against NULL, never for falsiness (0 is a real id)', () => {
      expect(subquerySql).toContain('"boardsesh_ticks"."difficulty" is not null');
    });

    it('clamps the personal grade to the scale', () => {
      expect(subquerySql).toContain('least(greatest("boardsesh_ticks"."difficulty", $?), $?)');
      expect(built.params).toContain(PERSONAL_GRADE_MIN_ID);
      expect(built.params).toContain(PERSONAL_GRADE_MAX_ID);
    });

    it('is joined on the climb uuid, under the alias the predicate reads', () => {
      expect(normalized(joinTarget.on)).toBe('"my_grade"."climb_uuid" = "board_climbs"."uuid"');
      expect(normalized(personalGradeColumnSql())).toBe(`"${PERSONAL_GRADE_ALIAS}"."difficulty"`);
    });
  });

  // The WHERE names an alias no other join introduces, so a query that spreads
  // getClimbWhereConditions() without joining this would not even parse. Ship
  // the two together or not at all.
  it('offers the join exactly when the predicate needs it', () => {
    const on = createClimbFilters(boardParams, search({ useMyGrades: true, minGrade: 22 }), USER_ID);
    expect(on.getPersonalGradeJoin()).not.toBeNull();
    expect(normalizeSql(renderedWhere(search({ useMyGrades: true, minGrade: 22 }), USER_ID))).toContain('"my_grade"');

    const off = createClimbFilters(boardParams, search({ minGrade: 22 }), USER_ID);
    expect(off.getPersonalGradeJoin()).toBeNull();
    expect(normalizeSql(renderedWhere(search({ minGrade: 22 }), USER_ID))).not.toContain('"my_grade"');
  });

  // The sort and the projection read the alias even with no grade bounds set,
  // so the join has to outlive the filter.
  it('still offers the join when no grade bounds are set', () => {
    const filters = createClimbFilters(boardParams, search({ useMyGrades: true }), USER_ID);
    expect(filters.getPersonalGradeJoin()).not.toBeNull();
    expect(filters.personalGradeConditions).toEqual([]);
  });

  it('takes the personal-grade bounds OUT of the crowd stats conditions', () => {
    // Both applying would AND two different grades together and hide exactly the
    // climbs whose grades disagree — the set the feature exists for.
    const withPersonal = createClimbFilters(boardParams, search({ useMyGrades: true, minGrade: 22 }), USER_ID);
    expect(withPersonal.getClimbStatsConditions()).toEqual([]);

    const withoutPersonal = createClimbFilters(boardParams, search({ minGrade: 22 }), USER_ID);
    expect(withoutPersonal.getClimbStatsConditions()).toHaveLength(1);
  });

  // Putting the predicate in climbStatsConditions would flip searchClimbs onto
  // the stats-driven INNER JOIN and drop every personally-graded climb with no
  // stats row at this angle — from the list AND the count.
  it('keeps the predicate out of the stats-driven routing signal', () => {
    const filters = createClimbFilters(boardParams, search({ useMyGrades: true, minGrade: 22, maxGrade: 28 }), USER_ID);
    expect(filters.getClimbStatsConditions()).toEqual([]);
    expect(filters.personalGradeConditions).toHaveLength(1);
  });

  it('is inert without a userId, so an anonymous search keeps the crowd filter', () => {
    const anonymous = createClimbFilters(boardParams, search({ useMyGrades: true, minGrade: 22 }), undefined);
    expect(anonymous.getPersonalGradeScope()).toBeNull();
    expect(anonymous.getPersonalGradeJoin()).toBeNull();
    expect(anonymous.personalGradeConditions).toEqual([]);
    expect(normalized(and(...anonymous.getClimbStatsConditions())!)).toContain(normalized(crowdGradeSql()));
  });

  it('is inert on a drafts query, which skips the whole grade filter anyway', () => {
    const drafts = createClimbFilters(
      boardParams,
      search({ useMyGrades: true, minGrade: 22, onlyDrafts: true }),
      USER_ID,
    );
    expect(drafts.isOnlyDrafts).toBe(true);
    expect(drafts.getPersonalGradeScope()).toBeNull();
    expect(drafts.getPersonalGradeJoin()).toBeNull();
    expect(drafts.personalGradeConditions).toEqual([]);
  });

  it('emits nothing when neither bound is set', () => {
    expect(personalGradeRangeCondition(undefined, undefined)).toBeNull();
    expect(createClimbFilters(boardParams, search({ useMyGrades: true }), USER_ID).personalGradeConditions).toEqual([]);
  });

  // Derived, not hardcoded: extending BOULDER_GRADES has to move the clamp.
  it('derives the clamp bounds from BOULDER_GRADES', () => {
    expect(PERSONAL_GRADE_MIN_ID).toBe(BOULDER_GRADES[0].difficulty_id);
    expect(PERSONAL_GRADE_MAX_ID).toBe(BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id);
    const clamped = clampToBoulderScaleSql(crowdGradeSql());
    expect(normalized(clamped)).toContain('least(greatest(round(');
    expect(dialect.sqlToQuery(clamped).params).toEqual([PERSONAL_GRADE_MIN_ID, PERSONAL_GRADE_MAX_ID]);
  });
});
