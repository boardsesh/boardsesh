import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boardseshAuthoredClimbSql, boardseshSetClimbSql, manufacturerClimbSql } from '../climb-provenance';

// Where a climb came from, read from its provenance columns and never from its
// owner alone. The predicates are interpolated raw, so the exact text, that it
// is two-valued, and that only a plain identifier reaches it are what is worth
// pinning without a database. The real-Postgres behaviour is in the backend's
// manufacturer-climb-provenance.test.ts.

void describe('manufacturerClimbSql', () => {
  void it('needs both an import and a manufacturer setter', () => {
    assert.equal(manufacturerClimbSql('bc'), '(bc.synced AND bc.setter_id IS NOT NULL)');
  });

  void it('does not read the owner', () => {
    assert.doesNotMatch(manufacturerClimbSql('bc'), /user_id/);
  });
});

void describe('boardseshSetClimbSql', () => {
  void it('is an owner on a climb that is not a manufacturer climb', () => {
    assert.equal(
      boardseshSetClimbSql('bc'),
      '(bc.user_id IS NOT NULL AND NOT (bc.synced AND bc.setter_id IS NOT NULL))',
    );
  });
});

void describe('boardseshAuthoredClimbSql', () => {
  void it('also covers a climb whose Boardsesh author deleted their account', () => {
    assert.equal(
      boardseshAuthoredClimbSql('bc'),
      '(bc.is_boardsesh_authored OR (bc.user_id IS NOT NULL AND NOT (bc.synced AND bc.setter_id IS NOT NULL)))',
    );
  });
});

void describe('every predicate', () => {
  const builders = [manufacturerClimbSql, boardseshSetClimbSql, boardseshAuthoredClimbSql];

  // `synced` and `is_boardsesh_authored` are NOT NULL; `user_id` and
  // `setter_id` are only ever tested with IS [NOT] NULL. So no predicate can be
  // NULL, and NOT of one is its exact complement.
  void it('compares the nullable columns only with IS NULL tests', () => {
    for (const build of builders) {
      const predicate = build('bc');
      assert.doesNotMatch(predicate, /user_id\s*(=|<>)|setter_id\s*(=|<>)/);
    }
  });

  void it('is one parenthesized expression, so a NOT in front applies to all of it', () => {
    for (const build of builders) {
      const predicate = build('bc');
      let depth = 0;
      for (let position = 0; position < predicate.length; position += 1) {
        if (predicate[position] === '(') depth += 1;
        if (predicate[position] === ')') depth -= 1;
        assert.equal(depth === 0, position === predicate.length - 1);
      }
    }
  });

  for (const unsafeAlias of ['', 'bc; DROP TABLE users', 'bc.uuid', '"bc"', 'bc -- ', 'BC', '1bc', 'bc )']) {
    void it(`refuses the alias ${JSON.stringify(unsafeAlias)}`, () => {
      for (const build of builders) {
        assert.throws(() => build(unsafeAlias), /Refusing to build a climb provenance predicate/);
      }
    });
  }
});
