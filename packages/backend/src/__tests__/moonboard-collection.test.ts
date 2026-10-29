import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { asc, eq, inArray } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type {
  ConnectionContext,
  MoonBoardCollectionImportInput,
  MoonBoardCollectionPreviewInput,
} from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { importMoonBoardCollection, previewMoonBoardCollection } from '../services/moonboard-collection';
import {
  moonBoardCollectionMutations,
  moonBoardCollectionQueries,
} from '../graphql/resolvers/playlists/moonboard-collection';
import { MoonBoardCollectionPreviewInputSchema } from '../validation/schemas/moonboard-collection';

const fixtureSuffix = crypto.randomUUID();
const ownerId = `moon-collection-owner-${fixtureSuffix}`;
const otherUserId = `moon-collection-other-${fixtureSuffix}`;
const namedClimbs = {
  unique: `Moon collection unique ${fixtureSuffix}`,
  ambiguous: `Moon collection ambiguous ${fixtureSuffix}`,
  draft: `Moon collection draft ${fixtureSuffix}`,
  unlisted: `Moon collection unlisted ${fixtureSuffix}`,
  hidden: `Moon collection hidden ${fixtureSuffix}`,
  otherLayout: `Moon collection other layout ${fixtureSuffix}`,
  otherAngle: `Moon collection other angle ${fixtureSuffix}`,
  noStats: `Moon collection no stats ${fixtureSuffix}`,
  apostrophe: `Moon collection DON’T ${fixtureSuffix}`,
};
const fixtureUuids: string[] = [];
const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

function previewInput(names = [namedClimbs.unique]): MoonBoardCollectionPreviewInput {
  return { layoutId: 2, angle: 40, rows: names.map((name, index) => ({ lineNumber: index + 2, name, grade: '6A+' })) };
}

function importInput(names = [namedClimbs.unique]): MoonBoardCollectionImportInput {
  return { ...previewInput(names), playlistUuid: crypto.randomUUID(), playlistName: 'My MoonBoard climbs' };
}

async function seedClimb(
  name: string,
  overrides: Partial<typeof schema.boardClimbs.$inferInsert> = {},
  difficultyId = 17,
) {
  const uuid = crypto.randomUUID();
  fixtureUuids.push(uuid);
  await db.insert(schema.boardClimbs).values({
    uuid,
    boardType: 'moonboard',
    layoutId: 2,
    angle: null,
    name,
    setterUsername: 'Export fixture setter',
    isListed: true,
    isDraft: false,
    ...overrides,
  });
  if (name !== namedClimbs.noStats) {
    await db.insert(schema.boardClimbStats).values({
      boardType: 'moonboard',
      climbUuid: uuid,
      angle: overrides.angle ?? 40,
      displayDifficulty: difficultyId,
    });
  }
  return uuid;
}

describe('MoonBoard collection validation', () => {
  it('accepts supported layout/angle pairs and rejects unsupported configurations', () => {
    expect(MoonBoardCollectionPreviewInputSchema.safeParse(previewInput()).success).toBe(true);
    expect(MoonBoardCollectionPreviewInputSchema.safeParse({ ...previewInput(), layoutId: 999 }).success).toBe(false);
    expect(MoonBoardCollectionPreviewInputSchema.safeParse({ ...previewInput(), angle: 35 }).success).toBe(false);
    expect(MoonBoardCollectionPreviewInputSchema.safeParse({ ...previewInput(), layoutId: 6, angle: 25 }).success).toBe(
      false,
    );
  });

  it('bounds source rows and rejects duplicate source numbers', () => {
    const sourceRow = previewInput().rows[0];
    expect(
      MoonBoardCollectionPreviewInputSchema.safeParse({ ...previewInput(), rows: [sourceRow, sourceRow] }).success,
    ).toBe(false);
    expect(
      MoonBoardCollectionPreviewInputSchema.safeParse({
        ...previewInput(),
        rows: Array.from({ length: 1001 }, (_, index) => ({ ...sourceRow, lineNumber: index + 1 })),
      }).success,
    ).toBe(false);
  });

  it('requires authentication before reading or writing the catalogue', async () => {
    const unauthenticated = { connectionId: 'anonymous', isAuthenticated: false } as ConnectionContext;
    await expect(
      moonBoardCollectionQueries.previewMoonBoardCollectionImport(null, { input: previewInput() }, unauthenticated),
    ).rejects.toThrow();
    await expect(
      moonBoardCollectionMutations.importMoonBoardCollection(null, { input: importInput() }, unauthenticated),
    ).rejects.toThrow();
  });
});

describeWithDatabase('MoonBoard collection recovery', () => {
  let uniqueUuid: string;
  let apostropheUuid: string;

  beforeAll(async () => {
    await db.insert(schema.users).values([
      { id: ownerId, email: `${ownerId}@test.invalid`, name: 'Collection owner' },
      { id: otherUserId, email: `${otherUserId}@test.invalid`, name: 'Other owner' },
    ]);
    uniqueUuid = await seedClimb(namedClimbs.unique);
    apostropheUuid = await seedClimb(namedClimbs.apostrophe);
    await seedClimb(namedClimbs.ambiguous);
    await seedClimb(namedClimbs.ambiguous);
    await seedClimb(namedClimbs.draft, { isDraft: true, userId: otherUserId });
    await seedClimb(namedClimbs.unlisted, { isListed: false });
    await seedClimb(namedClimbs.hidden, { isHidden: true });
    await seedClimb(namedClimbs.otherLayout, { layoutId: 3 });
    await seedClimb(namedClimbs.otherAngle, { angle: 25 });
    await seedClimb(namedClimbs.noStats);
  });

  afterAll(async () => {
    const ownedPlaylists = await db
      .select({ playlistId: schema.playlistOwnership.playlistId })
      .from(schema.playlistOwnership)
      .where(inArray(schema.playlistOwnership.userId, [ownerId, otherUserId]));
    if (ownedPlaylists.length > 0) {
      await db.delete(schema.playlists).where(
        inArray(
          schema.playlists.id,
          ownedPlaylists.map((row) => row.playlistId),
        ),
      );
    }
    await db.delete(schema.boardClimbs).where(inArray(schema.boardClimbs.uuid, fixtureUuids));
    await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, otherUserId]));
  });

  it('previews unique, missing, ambiguous and duplicate rows without writes', async () => {
    const input = previewInput([
      namedClimbs.unique,
      'Not in the current catalogue',
      namedClimbs.ambiguous,
      namedClimbs.unique,
    ]);
    const before = await db.select().from(schema.playlistOwnership).where(eq(schema.playlistOwnership.userId, ownerId));
    const preview = await previewMoonBoardCollection(db, input);
    expect(preview).toMatchObject({ matched: 1, missing: 1, ambiguous: 1, duplicates: 1 });
    expect(preview.rows.map((row) => row.status)).toEqual(['matched', 'missing', 'ambiguous', 'duplicate']);
    expect(preview.rows[0].climbUuid).toBe(uniqueUuid);
    expect(
      await db.select().from(schema.playlistOwnership).where(eq(schema.playlistOwnership.userId, ownerId)),
    ).toEqual(before);
  });

  it('does not reveal private drafts, unlisted/hidden rows, wrong layouts or unsupported angles', async () => {
    const preview = await previewMoonBoardCollection(
      db,
      previewInput([
        namedClimbs.draft,
        namedClimbs.unlisted,
        namedClimbs.hidden,
        namedClimbs.otherLayout,
        namedClimbs.otherAngle,
        namedClimbs.noStats,
      ]),
    );
    expect(preview.matched).toBe(0);
    expect(preview.missing).toBe(6);
    expect(preview.rows.every((row) => row.climbUuid === null)).toBe(true);
  });

  it('shares case, whitespace, apostrophe and grade-drift matching with logbook imports', async () => {
    const input = previewInput([namedClimbs.apostrophe.toUpperCase().replace('DON’T', "DON'T")]);
    input.rows[0].name = `  ${input.rows[0].name}  `;
    input.rows[0].grade = '6B';
    expect((await previewMoonBoardCollection(db, input)).rows[0]).toMatchObject({
      status: 'matched',
      climbUuid: apostropheUuid,
    });
  });

  it('deduplicates alias names onto the canonical climb and checks canonical visibility', async () => {
    const aliasName = `Moon collection alias ${fixtureSuffix}`;
    const aliasUuid = await seedClimb(aliasName);
    await db.insert(schema.boardClimbAliases).values({
      boardType: 'moonboard',
      aliasUuid,
      canonicalUuid: uniqueUuid,
      source: 'collection-test',
    });
    const preview = await previewMoonBoardCollection(db, previewInput([namedClimbs.unique, aliasName]));
    expect(preview).toMatchObject({ matched: 1, duplicates: 1 });
    expect(preview.rows[1].climbUuid).toBe(uniqueUuid);

    const hiddenName = `Moon collection hidden canonical ${fixtureSuffix}`;
    const hiddenUuid = await seedClimb(hiddenName, { isListed: false });
    const hiddenAliasName = `Moon collection public alias of hidden ${fixtureSuffix}`;
    const hiddenAliasUuid = await seedClimb(hiddenAliasName);
    await db.insert(schema.boardClimbAliases).values({
      boardType: 'moonboard',
      aliasUuid: hiddenAliasUuid,
      canonicalUuid: hiddenUuid,
      source: 'collection-test',
    });
    expect((await previewMoonBoardCollection(db, previewInput([hiddenAliasName]))).rows[0]).toMatchObject({
      status: 'missing',
      climbUuid: null,
    });
  });

  it('creates a private playlist, preserves source order and makes retries a no-op', async () => {
    const input = importInput([namedClimbs.apostrophe, namedClimbs.unique, namedClimbs.unique]);
    const first = await importMoonBoardCollection(db, ownerId, input);
    expect(first).toMatchObject({ imported: 2, skipped: 1, playlistUuid: input.playlistUuid });
    const second = await importMoonBoardCollection(db, ownerId, input);
    expect(second).toMatchObject({ imported: 0, skipped: 3, playlistId: first.playlistId });
    const [playlist] = await db.select().from(schema.playlists).where(eq(schema.playlists.uuid, input.playlistUuid));
    expect(playlist.isPublic).toBe(false);
    const memberships = await db
      .select()
      .from(schema.playlistClimbs)
      .where(eq(schema.playlistClimbs.playlistId, playlist.id))
      .orderBy(asc(schema.playlistClimbs.position));
    expect(memberships.map((row) => [row.climbUuid, row.position, row.angle])).toEqual([
      [apostropheUuid, 0, 40],
      [uniqueUuid, 1, 40],
    ]);
    expect(
      await db.select().from(schema.userBoardMappings).where(eq(schema.userBoardMappings.userId, ownerId)),
    ).toEqual([]);
    expect(await db.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.userId, ownerId))).toEqual([]);
    const [climb] = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, uniqueUuid));
    expect(climb.userId).toBeNull();
    expect(climb.setterUsername).toBe('Export fixture setter');
  });

  it('allows partial recovery while reporting missing/ambiguous names', async () => {
    const result = await importMoonBoardCollection(
      db,
      ownerId,
      importInput([namedClimbs.unique, namedClimbs.ambiguous, 'A newly published climb absent from this catalogue']),
    );
    expect(result.imported).toBe(1);
    expect(result.preview).toMatchObject({ matched: 1, ambiguous: 1, missing: 1 });
  });

  it('appends to an existing private target without renaming it or moving existing climbs', async () => {
    const original = importInput([namedClimbs.apostrophe, namedClimbs.unique]);
    const target = await importMoonBoardCollection(db, ownerId, original);
    const addedName = `Moon collection existing target addition ${fixtureSuffix}`;
    const addedUuid = await seedClimb(addedName);
    const appended = await importMoonBoardCollection(db, ownerId, {
      ...importInput([addedName, namedClimbs.unique]),
      playlistUuid: original.playlistUuid,
      playlistId: target.playlistId,
      playlistName: 'Do not rename the selected destination',
    });
    expect(appended).toMatchObject({ imported: 1, skipped: 1, playlistId: target.playlistId });
    const [playlist] = await db.select().from(schema.playlists).where(eq(schema.playlists.uuid, original.playlistUuid));
    expect(playlist.name).toBe(original.playlistName);
    const memberships = await db
      .select()
      .from(schema.playlistClimbs)
      .where(eq(schema.playlistClimbs.playlistId, playlist.id))
      .orderBy(asc(schema.playlistClimbs.position));
    expect(memberships.map((row) => [row.climbUuid, row.position])).toEqual([
      [apostropheUuid, 0],
      [uniqueUuid, 1],
      [addedUuid, 2],
    ]);
  });

  it('rejects mismatched ID/UUID, board and layout destinations', async () => {
    const firstInput = importInput();
    const first = await importMoonBoardCollection(db, ownerId, firstInput);
    const secondInput = importInput();
    const second = await importMoonBoardCollection(db, ownerId, secondInput);
    await expect(
      importMoonBoardCollection(db, ownerId, {
        ...secondInput,
        playlistId: first.playlistId,
      }),
    ).rejects.toThrow('owned private MoonBoard');
    await db
      .update(schema.playlists)
      .set({ boardType: 'kilter' })
      .where(eq(schema.playlists.uuid, second.playlistUuid));
    await expect(
      importMoonBoardCollection(db, ownerId, {
        ...secondInput,
        playlistId: second.playlistId,
      }),
    ).rejects.toThrow('owned private MoonBoard');
    await db
      .update(schema.playlists)
      .set({ boardType: 'moonboard', layoutId: 3 })
      .where(eq(schema.playlists.uuid, second.playlistUuid));
    await expect(
      importMoonBoardCollection(db, ownerId, {
        ...secondInput,
        playlistId: second.playlistId,
      }),
    ).rejects.toThrow('owned private MoonBoard');
  });

  it('rejects another account and a public destination, including UUID-conflict retries', async () => {
    const input = importInput();
    const created = await importMoonBoardCollection(db, otherUserId, input);
    await expect(importMoonBoardCollection(db, ownerId, input)).rejects.toThrow('owned private MoonBoard');
    await expect(importMoonBoardCollection(db, ownerId, { ...input, playlistId: created.playlistId })).rejects.toThrow(
      'owned private MoonBoard',
    );
    await db.update(schema.playlists).set({ isPublic: true }).where(eq(schema.playlists.uuid, input.playlistUuid));
    await expect(
      importMoonBoardCollection(db, otherUserId, { ...input, playlistId: created.playlistId }),
    ).rejects.toThrow('owned private MoonBoard');
  });

  it('rechecks catalogue visibility before importing and rolls back empty destinations', async () => {
    const name = `Moon collection visibility changes ${fixtureSuffix}`;
    const uuid = await seedClimb(name);
    const input = importInput([name]);
    expect((await previewMoonBoardCollection(db, input)).matched).toBe(1);
    await db.update(schema.boardClimbs).set({ isListed: false }).where(eq(schema.boardClimbs.uuid, uuid));
    await expect(importMoonBoardCollection(db, ownerId, input)).rejects.toThrow('No catalogue climbs matched');
    expect(await db.select().from(schema.playlists).where(eq(schema.playlists.uuid, input.playlistUuid))).toEqual([]);
  });

  it('serializes concurrent retries of the same collection without duplicate memberships', async () => {
    const input = importInput([namedClimbs.apostrophe, namedClimbs.unique]);
    const results = await Promise.all([
      importMoonBoardCollection(db, ownerId, input),
      importMoonBoardCollection(db, ownerId, input),
    ]);
    expect(results.map((result) => result.imported).sort((first, second) => first - second)).toEqual([0, 2]);
    expect(results[0].playlistId).toBe(results[1].playlistId);
  });

  it('appends distinct concurrent imports in ordered batches with unique positions', async () => {
    const original = importInput();
    const target = await importMoonBoardCollection(db, ownerId, original);
    const names = Array.from({ length: 4 }, (_, index) => `Moon collection concurrent ${index} ${fixtureSuffix}`);
    const uuids: string[] = [];
    for (const name of names) uuids.push(await seedClimb(name));
    await Promise.all([
      importMoonBoardCollection(db, ownerId, {
        ...importInput(names.slice(0, 2)),
        playlistUuid: target.playlistUuid,
        playlistId: target.playlistId,
      }),
      importMoonBoardCollection(db, ownerId, {
        ...importInput(names.slice(2)),
        playlistUuid: target.playlistUuid,
        playlistId: target.playlistId,
      }),
    ]);
    const memberships = await db
      .select()
      .from(schema.playlistClimbs)
      .where(eq(schema.playlistClimbs.playlistId, BigInt(target.playlistId)))
      .orderBy(asc(schema.playlistClimbs.position));
    expect(memberships.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    const importedOrder = memberships.slice(1).map((row) => row.climbUuid);
    expect([uuids, [...uuids.slice(2), ...uuids.slice(0, 2)]]).toContainEqual(importedOrder);
  });
});
