import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { boardClimbs } from '../../schema/boards/unified';
import {
  protectedClimbCandidateSql,
  publicReferenceClimbSql,
  REFERENCE_EXCLUDED_BOARD_TYPES,
  referenceBoardTypeSql,
} from '../privacy';

// The text predicates behind the sync audience split (#6306). They are
// interpolated raw into the snapshot exports and the sync resolvers, so the
// two things worth pinning without a database are that only a plain identifier
// can reach them and that the protected predicate is still the partial index's.

void describe('publicReferenceClimbSql', () => {
  void it('selects climbs with no owner, no author flag and no policy row', () => {
    assert.equal(
      publicReferenceClimbSql('bc'),
      "bc.user_id IS NULL AND NOT bc.is_boardsesh_authored AND NOT EXISTS (SELECT 1 FROM content_privacy reference_climb_privacy WHERE reference_climb_privacy.entity_type = 'climb' AND reference_climb_privacy.entity_id = bc.uuid)",
    );
  });

  void it('qualifies every column with the alias it is given', () => {
    const predicate = publicReferenceClimbSql('board_climbs');
    assert.match(predicate, /^board_climbs\.user_id IS NULL AND NOT board_climbs\.is_boardsesh_authored /);
    assert.match(predicate, /reference_climb_privacy\.entity_id = board_climbs\.uuid\)$/);
  });
});

void describe('protectedClimbCandidateSql', () => {
  void it('is the predicate of board_climbs_protected_sync_idx, so a query carrying it can use the index', () => {
    const protectedIndex = getTableConfig(boardClimbs).indexes.find(
      (index) => index.config.name === 'board_climbs_protected_sync_idx',
    );
    assert.ok(protectedIndex?.config.where, 'board_climbs_protected_sync_idx must be a partial index');

    const indexPredicate = new PgDialect().sqlToQuery(protectedIndex.config.where).sql.replaceAll('"', '');
    assert.equal(indexPredicate, protectedClimbCandidateSql('board_climbs'));
  });

  void it('is parenthesized, so it survives being ANDed into a longer scope', () => {
    assert.equal(protectedClimbCandidateSql('bc'), '(bc.user_id IS NOT NULL OR bc.is_boardsesh_authored)');
  });
});

void describe('referenceBoardTypeSql', () => {
  void it('excludes exactly the board types with no reference set', () => {
    assert.deepEqual([...REFERENCE_EXCLUDED_BOARD_TYPES], ['spray']);
    assert.equal(referenceBoardTypeSql('snapshot_climb'), "snapshot_climb.board_type NOT IN ('spray')");
  });
});

void describe('alias validation', () => {
  const builders = [publicReferenceClimbSql, protectedClimbCandidateSql, referenceBoardTypeSql];

  for (const unsafeAlias of ['', 'bc; DROP TABLE users', 'bc.uuid', '"bc"', 'bc -- ', 'BC', '1bc', 'bc )']) {
    void it(`refuses ${JSON.stringify(unsafeAlias)}`, () => {
      for (const build of builders) {
        assert.throws(() => build(unsafeAlias), /Refusing to build a climb audience predicate/);
      }
    });
  }

  void it('refuses the alias its own subquery uses, which would capture the outer reference', () => {
    assert.throws(() => publicReferenceClimbSql('reference_climb_privacy'), /Refusing to build/);
  });
});
