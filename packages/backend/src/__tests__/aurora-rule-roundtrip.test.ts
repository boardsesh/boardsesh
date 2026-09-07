import { test, expect } from 'vite-plus/test';
import { sql, eq } from 'drizzle-orm';
import { pgTable, text, boolean } from 'drizzle-orm/pg-core';
import { climbCharacteristicsConflictSql } from '@boardsesh/aurora-sync/sync';
import { isNoMatchClimb, withNoMatch } from '@boardsesh/shared-schema';
import { db } from '../db/client';

const temporaryClimbs = pgTable('board_climbs', {
  uuid: text().primaryKey(),
  userId: text('user_id'),
  description: text(),
  characteristics: text().array(),
  isDraft: boolean('is_draft'),
});

test('Aurora round trips preserve explicit false without freezing upstream rule changes', async () => {
  const prose = 'No matching hands';
  // #5127: the form setters actually use — the declaration appended after their
  // own prose. isNoMatchClimb now reads it, so the sync derives no_match from it
  // and the explicit-false sentinel has to hold against that.
  const trailing = 'Kick board is off. No matching.';
  const cases = [
    { before: [], description: prose, incoming: withNoMatch(prose, false), expected: [], authored: true },
    {
      before: ['any_feet', 'no_kickboard'],
      description: prose,
      incoming: prose,
      expected: ['any_feet', 'no_kickboard'],
      authored: true,
    },
    { before: [], description: prose, incoming: `No match\n${prose}`, expected: ['no_match'], authored: true },
    { before: ['no_match'], description: 'Beta', incoming: 'Beta', expected: null, authored: true },
    {
      before: ['no_match', 'no_kickboard'],
      description: 'No match\nBeta',
      incoming: 'Beta',
      expected: ['no_kickboard'],
      authored: true,
    },
    { before: [], description: 'Beta', incoming: prose, expected: ['no_match'], authored: true },
    { before: null, description: prose, incoming: prose, expected: ['no_match'], authored: true },
    { before: [], description: prose, incoming: prose, expected: ['no_match'], authored: false },
    // Published Aurora climbs are immutable: first sync may add the wire
    // prefix, but the explicit Boardsesh rules must remain authoritative.
    { before: [], description: prose, incoming: prose, expected: [], authored: true, published: true },
    {
      before: ['no_match', 'any_feet'],
      description: prose,
      incoming: `No match\n${prose}`,
      expected: ['no_match', 'any_feet'],
      authored: true,
      published: true,
    },
    {
      before: ['no_match'],
      description: 'Beta',
      incoming: 'Beta',
      expected: ['no_match'],
      authored: true,
      published: true,
    },
    { before: null, description: prose, incoming: prose, expected: ['no_match'], authored: true, published: true },
    { before: [], description: prose, incoming: prose, expected: ['no_match'], authored: false, published: true },
    // Trailing-declaration twins. The first two are the regression #5127 could
    // have introduced: a user turns the toggle off on a climb whose prose still
    // declares no-match, and the next sync must not put it back.
    { before: [], description: trailing, incoming: trailing, expected: [], authored: true },
    { before: [], description: trailing, incoming: trailing, expected: [], authored: true, published: true },
    { before: null, description: trailing, incoming: trailing, expected: ['no_match'], authored: true },
    { before: [], description: trailing, incoming: trailing, expected: ['no_match'], authored: false },
    // Prose that merely ends with the phrase is not a declaration, so nothing
    // is derived from it either way.
    { before: null, description: 'Campus, no match', incoming: 'Campus, no match', expected: null, authored: true },
  ];
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE board_climbs (
      uuid text PRIMARY KEY, user_id text, description text, characteristics text[], is_draft boolean
    ) ON COMMIT DROP`);

    for (const [index, example] of cases.entries()) {
      const uuid = `aurora-rules-${index}`;
      await transaction.insert(temporaryClimbs).values({
        uuid,
        userId: example.authored ? 'author' : null,
        description: example.description,
        characteristics: example.before,
        isDraft: !example.published,
      });
      // Repeating the actual conflict expression catches [] becoming NULL on
      // the first echo, then being reinterpreted as no_match on the second.
      for (let pass = 0; pass < 2; pass++) {
        await transaction
          .insert(temporaryClimbs)
          .values({
            uuid,
            description: example.incoming,
            characteristics: isNoMatchClimb(example.incoming) ? ['no_match'] : null,
          })
          .onConflictDoUpdate({
            target: temporaryClimbs.uuid,
            set: {
              description: sql`excluded.description`,
              characteristics: climbCharacteristicsConflictSql(),
            },
          });
        const [saved] = await transaction.select().from(temporaryClimbs).where(eq(temporaryClimbs.uuid, uuid));
        expect(saved.characteristics, `case ${index}, sync ${pass}`).toEqual(example.expected);
        expect(saved.description).toBe(example.incoming);
      }
    }
  });
});
