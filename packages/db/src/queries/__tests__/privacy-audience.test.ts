import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { boardClimbs } from '../../schema/boards/unified';
import {
  climbDraftVisibilityCondition,
  climbVisibilityCondition,
  publicReferenceClimbSql,
  REFERENCE_EXCLUDED_BOARD_TYPES,
  referenceBoardTypeSql,
  referenceFirstAscentSql,
} from '../privacy';

// The text predicates behind the sync audience split (#6306). They are
// interpolated raw into the snapshot exports and the sync resolvers, so the
// things worth pinning without a database are the exact rule, that it is never
// NULL, and that only a plain identifier can reach it.

void describe('publicReferenceClimbSql', () => {
  void it('is the publication rule and nothing else: published and listed', () => {
    assert.equal(publicReferenceClimbSql('bc'), '(bc.is_draft IS NOT TRUE AND bc.is_listed IS TRUE)');
  });

  void it('has no owner, no viewer and no privacy lookup in it', () => {
    const predicate = publicReferenceClimbSql('bc');
    assert.doesNotMatch(predicate, /user_id|is_boardsesh_authored|content_privacy|\$\d/);
  });

  void it('is two-valued, so NOT of it is its exact complement', () => {
    // Both flags are nullable. `NOT bc.is_draft` or `bc.is_listed` on their own
    // are NULL for a NULL flag, and a row would then be in neither stream.
    const predicate = publicReferenceClimbSql('bc');
    assert.match(predicate, /bc\.is_draft IS NOT TRUE/);
    assert.match(predicate, /bc\.is_listed IS TRUE/);
    assert.doesNotMatch(predicate, /NOT bc\.is_draft|bc\.is_draft =|bc\.is_listed =|AND bc\.is_listed\)/);
  });

  void it('qualifies every column with the alias it is given', () => {
    assert.equal(
      publicReferenceClimbSql('board_climbs'),
      '(board_climbs.is_draft IS NOT TRUE AND board_climbs.is_listed IS TRUE)',
    );
  });

  void it('is one parenthesized expression, so NOT and AND apply to all of it', () => {
    // `NOT a AND b` negates only `a`. The PROTECTED stream writes `NOT <this>`,
    // so the outer parentheses are what make the two streams disjoint.
    const predicate = publicReferenceClimbSql('bc');
    let depth = 0;
    for (let position = 0; position < predicate.length; position += 1) {
      if (predicate[position] === '(') depth += 1;
      if (predicate[position] === ')') depth -= 1;
      // The opening parenthesis closes on the last character and not before.
      assert.equal(depth === 0, position === predicate.length - 1);
    }
  });
});

void describe('referenceFirstAscentSql', () => {
  void it('ships the stored credit of a manufacturer climb and NULL for a Boardsesh one', () => {
    assert.equal(
      referenceFirstAscentSql('board_climb_stats', 'fa_username'),
      '(SELECT board_climb_stats.fa_username FROM board_climbs fa_reference_climb WHERE fa_reference_climb.uuid = board_climb_stats.climb_uuid AND fa_reference_climb.board_type = board_climb_stats.board_type AND fa_reference_climb.user_id IS NULL AND NOT fa_reference_climb.is_boardsesh_authored) AS fa_username',
    );
  });

  void it('applies the same test to the date, and has no viewer in it', () => {
    const date = referenceFirstAscentSql('board_climb_stats', 'fa_at');
    assert.match(date, /^\(SELECT board_climb_stats\.fa_at FROM board_climbs /);
    assert.match(date, /\) AS fa_at$/);
    assert.doesNotMatch(date, /\$\d|privacy/);
  });

  // An EXISTS in a select list can be planned as a hash over every qualifying
  // climb; a scalar subquery is always one probe per row.
  void it('is a scalar subquery, never an EXISTS', () => {
    for (const column of ['fa_username', 'fa_at'] as const) {
      assert.doesNotMatch(referenceFirstAscentSql('board_climb_stats', column), /EXISTS/i);
    }
  });
});

void describe('climbDraftVisibilityCondition', () => {
  const dialect = new PgDialect();
  const climb = { uuid: boardClimbs.uuid, userId: boardClimbs.userId, isDraft: boardClimbs.isDraft };

  void it('lets a draft through for its owner only, NULL-safely on both columns', () => {
    const rendered = dialect.sqlToQuery(climbDraftVisibilityCondition(climb, 'viewer-1'));
    assert.equal(
      rendered.sql,
      '("board_climbs"."is_draft" IS NOT TRUE OR COALESCE("board_climbs"."user_id" = $1, false))',
    );
    assert.deepEqual(rendered.params, ['viewer-1']);
  });

  void it('compares with NULL for an anonymous viewer, which no owner equals: no draft at all', () => {
    for (const anonymous of [null, undefined]) {
      const rendered = dialect.sqlToQuery(climbDraftVisibilityCondition(climb, anonymous));
      assert.match(rendered.sql, /COALESCE\("board_climbs"\."user_id" = \$1, false\)/);
      assert.deepEqual(rendered.params, [null]);
    }
  });

  void it('is ANDed onto the audience condition by climbVisibilityCondition, never in place of it', () => {
    const rendered = dialect.sqlToQuery(climbVisibilityCondition(climb, 'viewer-1')).sql;
    // The audience condition first (it reads content_privacy), then the draft rule.
    assert.match(rendered, /^\(COALESCE\(.*content_privacy.*\) AND \("board_climbs"\."is_draft" IS NOT TRUE OR /s);
  });
});

void describe('referenceBoardTypeSql', () => {
  void it('excludes exactly the board types with no reference set', () => {
    assert.deepEqual([...REFERENCE_EXCLUDED_BOARD_TYPES], ['spray']);
    assert.equal(referenceBoardTypeSql('snapshot_climb'), "snapshot_climb.board_type NOT IN ('spray')");
  });
});

void describe('alias validation', () => {
  const builders = [
    publicReferenceClimbSql,
    referenceBoardTypeSql,
    (alias: string) => referenceFirstAscentSql(alias, 'fa_username'),
  ];

  for (const unsafeAlias of ['', 'bc; DROP TABLE users', 'bc.uuid', '"bc"', 'bc -- ', 'BC', '1bc', 'bc )']) {
    void it(`refuses ${JSON.stringify(unsafeAlias)}`, () => {
      for (const build of builders) {
        assert.throws(() => build(unsafeAlias), /Refusing to build a climb audience predicate/);
      }
    });
  }

  void it('refuses the alias its own subquery uses, which would capture the outer reference', () => {
    assert.throws(() => referenceFirstAscentSql('fa_reference_climb', 'fa_username'), /Refusing to build/);
  });
});
