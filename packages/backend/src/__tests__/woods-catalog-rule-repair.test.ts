import { test, expect } from 'vite-plus/test';
import { sql, eq } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { db } from '../db/client';
import { mergeCatalogCharacteristicsSql, applyWoodsRuleUpdates, type WoodsRuleUpdate } from '@boardsesh/db/queries';

const temporaryClimbs = pgTable('board_climbs', {
  uuid: text().primaryKey(),
  boardType: text('board_type'),
  userId: text('user_id'),
  frames: text(),
  characteristics: text().array(),
});

test('catalog SQL preserves app rules while refreshing upstream flags', async () => {
  const array = (tokens: string[] | null) =>
    tokens === null
      ? sql`NULL::text[]`
      : sql`ARRAY[${sql.join(
          tokens.map((token) => sql`${token}`),
          sql`, `,
        )}]::text[]`;
  await db.transaction(
    async (transaction) => {
      const cases = [
        {
          before: ['no_match', 'any_feet', 'no_kickboard'],
          incoming: null,
          managed: ['no_match'],
          keepEmpty: false,
          expected: ['any_feet', 'no_kickboard'],
        },
        {
          before: ['campus'],
          incoming: ['no_match'],
          managed: ['no_match'],
          keepEmpty: false,
          expected: ['campus', 'no_match'],
        },
        { before: ['no_match'], incoming: null, managed: ['no_match'], keepEmpty: false, expected: null },
        { before: null, incoming: [], managed: ['no_match', 'any_feet'], keepEmpty: true, expected: [] },
        {
          before: ['no_match', 'any_feet', 'future_rule'],
          incoming: ['any_feet'],
          managed: ['no_match', 'any_feet'],
          keepEmpty: true,
          expected: ['future_rule', 'any_feet'],
        },
        {
          before: ['method_footless', 'no_kickboard'],
          incoming: ['method_no_kickboard'],
          managed: ['method_footless', 'method_footless_kickboard', 'method_no_kickboard'],
          keepEmpty: false,
          expected: ['no_kickboard', 'method_no_kickboard'],
        },
      ];
      for (const example of cases) {
        const expression = mergeCatalogCharacteristicsSql(
          array(example.before),
          array(example.incoming),
          example.managed,
          example.keepEmpty,
        );
        const [row] = await transaction.execute<{ characteristics: string[] | null }>(
          sql`SELECT ${expression} AS characteristics`,
        );
        expect(row.characteristics).toEqual(example.expected);
      }
    },
    { accessMode: 'read only' },
  );
});

test('repair batches roll back together and protect authored rows', async () => {
  await db.transaction(async (transaction) => {
    // The temporary table shadows the catalog only on this transaction's connection.
    await transaction.execute(sql`CREATE TEMP TABLE board_climbs (
      uuid text PRIMARY KEY, board_type text, user_id text, frames text, characteristics text[]
    ) ON COMMIT DROP`);
    const updates: WoodsRuleUpdate[] = Array.from({ length: 101 }, (_, index) => ({
      uuid: `woods-repair-${index}`,
      frames: 'p1r4p2r3',
      sizeId: 2,
      previousCharacteristics: null,
      characteristics: index % 2 ? ['any_feet'] : [],
    }));
    await transaction.insert(temporaryClimbs).values(
      updates.map((update) => ({
        uuid: update.uuid,
        boardType: 'woods',
        userId: null,
        frames: update.frames,
        characteristics: null,
      })),
    );
    const stale = updates.map((update, index) =>
      index === 100 ? { ...update, previousCharacteristics: ['no_match'] } : update,
    );
    await expect(transaction.transaction((savepoint) => applyWoodsRuleUpdates(savepoint, stale))).rejects.toThrow(
      'changed during repair',
    );
    const afterRollback = await transaction.select().from(temporaryClimbs);
    expect(afterRollback).toHaveLength(101);
    expect(afterRollback.every((climb) => climb.characteristics === null)).toBe(true);

    await applyWoodsRuleUpdates(transaction, updates);
    const repaired = await transaction.select().from(temporaryClimbs);
    const byUuid = new Map(repaired.map((climb) => [climb.uuid, climb]));
    for (const update of updates) {
      expect(byUuid.get(update.uuid)?.characteristics).toEqual(update.characteristics);
      expect(byUuid.get(update.uuid)?.frames).toBe(update.frames);
    }
    await transaction
      .update(temporaryClimbs)
      .set({ userId: 'author' })
      .where(eq(temporaryClimbs.uuid, updates[0].uuid));
    await expect(
      transaction.transaction((savepoint) =>
        applyWoodsRuleUpdates(savepoint, [
          {
            ...updates[0],
            previousCharacteristics: [],
            characteristics: ['no_match'],
          },
        ]),
      ),
    ).rejects.toThrow('changed during repair');
  });
});
