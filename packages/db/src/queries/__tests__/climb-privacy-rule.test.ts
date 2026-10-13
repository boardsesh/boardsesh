import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { boardClimbs, boardClimbStats } from '../../schema/boards/unified';
import {
  climbDraftVisibilityCondition,
  climbReferenceReadableCondition,
  ownedOrPublicClimbCondition,
  privateSafeFirstAscentName,
  privateSafeFirstAscentAt,
  publicClimbCondition,
} from '../privacy';

// The climb rule (#6355): a published climb is public to everyone, a draft
// goes to its owner alone, and a list shows published, listed climbs plus the
// viewer's own. None of these predicates reads account privacy or an item
// audience, so the things worth pinning without a database are the exact rule
// and that no privacy table appears in it.

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

  void it('is the whole rule for a read by reference: no account privacy or item audience', () => {
    const rendered = dialect.sqlToQuery(climbDraftVisibilityCondition(climb, 'viewer-1')).sql;
    assert.doesNotMatch(rendered, /content_privacy|user_profiles|user_follows|is_listed/);
  });
});

void describe('climbReferenceReadableCondition', () => {
  const dialect = new PgDialect();

  void it('applies the draft rule, and nothing else, to a row keyed by a climb reference', () => {
    const rendered = dialect.sqlToQuery(
      climbReferenceReadableCondition(
        { boardType: boardClimbStats.boardType, climbUuid: boardClimbStats.climbUuid },
        'viewer-1',
      ),
    ).sql;
    assert.match(rendered, /^EXISTS \(SELECT 1 FROM board_climbs privacy_reference_climb/);
    assert.match(
      rendered,
      /privacy_reference_climb\.is_draft IS NOT TRUE OR COALESCE\(privacy_reference_climb\.user_id = \$1, false\)/,
    );
    assert.doesNotMatch(rendered, /content_privacy|user_profiles|user_follows/);
  });
});

void describe('publicClimbCondition', () => {
  const dialect = new PgDialect();

  void it('is published and listed, as two two-valued tests with no owner or viewer in them', () => {
    const rendered = dialect.sqlToQuery(
      publicClimbCondition({ isDraft: boardClimbs.isDraft, isListed: boardClimbs.isListed }),
    );
    assert.equal(rendered.sql, '("board_climbs"."is_draft" IS NOT TRUE AND "board_climbs"."is_listed" IS TRUE)');
    assert.deepEqual(rendered.params, []);
  });
});

void describe('ownedOrPublicClimbCondition', () => {
  const dialect = new PgDialect();
  const climb = { isDraft: boardClimbs.isDraft, isListed: boardClimbs.isListed, userId: boardClimbs.userId };

  void it('is the public set plus the viewer’s own drafts and unlisted climbs', () => {
    const rendered = dialect.sqlToQuery(ownedOrPublicClimbCondition(climb, 'viewer-1'));
    assert.equal(
      rendered.sql,
      '(("board_climbs"."is_draft" IS NOT TRUE AND "board_climbs"."is_listed" IS TRUE) OR COALESCE("board_climbs"."user_id" = $1, false))',
    );
    assert.deepEqual(rendered.params, ['viewer-1']);
  });

  void it('is the public set alone for an anonymous viewer, and reads no privacy table', () => {
    const rendered = dialect.sqlToQuery(ownedOrPublicClimbCondition(climb, null));
    assert.deepEqual(rendered.params, [null]);
    assert.doesNotMatch(rendered.sql, /content_privacy|user_profiles|user_follows/);
  });
});

void describe('privateSafeFirstAscentName', () => {
  const dialect = new PgDialect();

  void it('picks the earliest send this viewer may read, rather than blanking a hidden first send', () => {
    const rendered = dialect.sqlToQuery(
      privateSafeFirstAscentName(
        {
          boardType: boardClimbStats.boardType,
          climbUuid: boardClimbStats.climbUuid,
          angle: boardClimbStats.angle,
          username: boardClimbStats.faUsername,
        },
        'viewer-1',
      ),
    ).sql;
    // The tick's visibility is a WHERE filter ahead of ORDER BY … LIMIT 1, not a
    // CASE over the single earliest row.
    const sendQuery = rendered.slice(rendered.indexOf('FROM boardsesh_ticks privacy_fa_tick'));
    assert.ok(sendQuery.indexOf('content_privacy') < sendQuery.indexOf('ORDER BY privacy_fa_tick.climbed_at ASC'));
    assert.doesNotMatch(rendered, /THEN COALESCE\(privacy_fa_profile\.display_name, privacy_fa_user\.name\) ELSE NULL/);
    // The stored credit is still distrusted for a climb that has, or once had, a Boardsesh author.
    assert.match(rendered, /privacy_fa_owned\.user_id IS NOT NULL OR privacy_fa_owned\.is_boardsesh_authored/);
  });

  void it('dates the same send it names: the twin subqueries pick one tick', () => {
    const stats = {
      boardType: boardClimbStats.boardType,
      climbUuid: boardClimbStats.climbUuid,
      angle: boardClimbStats.angle,
    };
    const name = dialect.sqlToQuery(
      privateSafeFirstAscentName({ ...stats, username: boardClimbStats.faUsername }, 'viewer-1'),
    );
    const at = dialect.sqlToQuery(privateSafeFirstAscentAt({ ...stats, at: boardClimbStats.faAt }, 'viewer-1'));
    // Same tick filter, order and limit; only the picked column and the stored
    // fallback differ, so the date is never the stored date of a hidden send.
    const fromTicks = (rendered: string) => rendered.slice(rendered.indexOf('FROM boardsesh_ticks privacy_fa_tick'));
    assert.equal(fromTicks(at.sql), fromTicks(name.sql).replace('"fa_username"', '"fa_at"'));
    assert.deepEqual(at.params, name.params);
    assert.match(at.sql, /SELECT privacy_fa_tick\.climbed_at\s+FROM boardsesh_ticks privacy_fa_tick/);
    assert.match(at.sql, /ELSE "board_climb_stats"\."fa_at" END$/);
  });
});
