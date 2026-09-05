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
