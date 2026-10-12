import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { resetAllRateLimits } from '../utils/rate-limiter';

// The migration is read off disk and executed verbatim, so the assertions test
// the shipped file and not a copy of it.
const drizzleDir = fileURLToPath(new URL('../../../db/drizzle/', import.meta.url));
const BACKFILL = readFileSync(`${drizzleDir}0269_privacy_public_defaults_backfill.sql`, 'utf8');
const GUARD_TAG = 'privacy_public_defaults_backfill_b1';
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const owner = 'backfill-owner';
// Owns the rows that are themselves a privacy signal (a board made private
// before the cutoff, an edited policy), so they do not mark `owner` as
// privacy-minded and hide what the main case is testing.
const otherOwner = 'backfill-other-owner';
const ownerContext = { userId: owner, isAuthenticated: true, connectionId: 'backfill-owner' } as ConnectionContext;

async function runBackfill(): Promise<void> {
  for (const statement of BACKFILL.split('--> statement-breakpoint')) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
}

let boardCount = 0;
async function insertBoard(
  overrides: Partial<typeof schema.userBoards.$inferInsert> = {},
): Promise<typeof schema.userBoards.$inferSelect> {
  boardCount += 1;
  const uuid = `backfill-board-${boardCount}`;
  const [board] = await db
    .insert(schema.userBoards)
    .values({
      uuid,
      slug: uuid,
      ownerId: owner,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      name: uuid,
      isPublic: false,
      isUnlisted: false,
      hideLocation: true,
      ...overrides,
    })
    .returning();
  return board;
}

async function boardRow(uuid: string) {
  const [board] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.uuid, uuid));
  return board;
}

async function boardPolicy(uuid: string) {
  const [policy] = await db
    .select()
    .from(schema.resourcePrivacy)
    .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, uuid)));
  return policy;
}

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS _bs_migration_guards (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  await db.execute(sql`DELETE FROM _bs_migration_guards WHERE tag = ${GUARD_TAG}`);
  await db.execute(
    sql`TRUNCATE TABLE resource_grants, resource_privacy, content_privacy, user_boards, user_profiles CASCADE`,
  );
  await db
    .insert(schema.users)
    .values([
      { id: owner, email: `${owner}@test.com` },
      { id: otherOwner, email: `${otherOwner}@test.com` },
      { id: SYSTEM_OWNER, email: 'system@test.com' },
    ])
    .onConflictDoNothing();
});

describe('privacy public-defaults backfill', () => {
  it('makes untouched default-private boards public and leaves every deliberate choice alone', async () => {
    const legacyDefault = await insertBoard();
    const beforeCutoff = await insertBoard({
      ownerId: otherOwner,
      createdAt: new Date('2026-10-08T21:27:50Z'),
      updatedAt: new Date('2026-10-08T21:27:50Z'),
    });
    // Private with the location shown was never the #6254 default: a deliberate choice.
    const locationShown = await insertBoard({ hideLocation: false });
    // Default-shaped, but edited after creation (for example switched private
    // through the legacy updateBoard, which has no policy row to write).
    const editedLater = await insertBoard();
    await db.execute(
      sql`UPDATE user_boards SET updated_at = created_at + interval '1 minute' WHERE uuid = ${editedLater.uuid}`,
    );
    const sprayWall = await insertBoard({ boardType: 'spray' });
    const deleted = await insertBoard({ deletedAt: new Date() });
    const systemOwned = await insertBoard({ ownerId: SYSTEM_OWNER });
    const unlisted = await insertBoard({ isUnlisted: true });
    const withGrant = await insertBoard();
    await db
      .insert(schema.resourceGrants)
      .values({ kind: 'board', resourceId: withGrant.uuid, userId: SYSTEM_OWNER, status: 'approved' });
    const inviteOnly = await insertBoard();
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'board', resourceId: inviteOnly.uuid, ownerId: owner, audience: 'invite_only' });
    const untouchedOnlyMe = await insertBoard();
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'board', resourceId: untouchedOnlyMe.uuid, ownerId: owner, audience: 'only_me' });
    const editedOnlyMe = await insertBoard({ ownerId: otherOwner });
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'board', resourceId: editedOnlyMe.uuid, ownerId: otherOwner, audience: 'only_me', revision: 1 });
    // A create that chose a location audience alongside isPublic: false.
    const onlyMeSharedLocation = await insertBoard();
    await db.insert(schema.resourcePrivacy).values({
      kind: 'board',
      resourceId: onlyMeSharedLocation.uuid,
      ownerId: owner,
      audience: 'only_me',
      locationAudience: 'members',
    });

    await runBackfill();

    expect(await boardRow(legacyDefault.uuid)).toMatchObject({ isPublic: true, isUnlisted: false, hideLocation: true });
    expect(await boardPolicy(legacyDefault.uuid)).toBeUndefined();
    expect(await boardRow(untouchedOnlyMe.uuid)).toMatchObject({ isPublic: true, hideLocation: true });
    expect(await boardPolicy(untouchedOnlyMe.uuid)).toMatchObject({ audience: 'public', revision: 0 });

    for (const kept of [
      beforeCutoff,
      locationShown,
      editedLater,
      sprayWall,
      deleted,
      systemOwned,
      unlisted,
      withGrant,
      inviteOnly,
      editedOnlyMe,
      onlyMeSharedLocation,
    ]) {
      expect((await boardRow(kept.uuid)).isPublic, kept.uuid).toBe(false);
    }
    expect(await boardPolicy(inviteOnly.uuid)).toMatchObject({ audience: 'invite_only' });
    expect(await boardPolicy(editedOnlyMe.uuid)).toMatchObject({ audience: 'only_me' });
    expect(await boardPolicy(onlyMeSharedLocation.uuid)).toMatchObject({
      audience: 'only_me',
      locationAudience: 'members',
    });
    expect(await boardRow(locationShown.uuid)).toMatchObject({ hideLocation: false });
  });

  it('keeps default-shaped boards private for an owner who chose privacy anywhere else', async () => {
    const signals: Array<[string, (ownerId: string) => Promise<unknown>]> = [
      [
        'private board before the cutoff',
        (ownerId) =>
          insertBoard({
            ownerId,
            createdAt: new Date('2026-10-01T00:00:00Z'),
            updatedAt: new Date('2026-10-01T00:00:00Z'),
          }),
      ],
      [
        'edited board policy',
        async (ownerId) => {
          const board = await insertBoard({ ownerId, isPublic: true });
          await db
            .insert(schema.resourcePrivacy)
            .values({ kind: 'board', resourceId: board.uuid, ownerId, audience: 'public', revision: 1 });
        },
      ],
      [
        'Only me session',
        (ownerId) =>
          db
            .insert(schema.resourcePrivacy)
            .values({ kind: 'session', resourceId: `session-${ownerId}`, ownerId, audience: 'only_me' }),
      ],
      [
        'Only me item',
        (ownerId) =>
          db
            .insert(schema.contentPrivacy)
            .values({ entityType: 'tick', entityId: `tick-${ownerId}`, ownerId, audience: 'only_me' }),
      ],
      [
        'deliberately private account',
        (ownerId) => db.insert(schema.userProfiles).values({ userId: ownerId, isPrivate: true, privacyRevision: 1 }),
      ],
    ];
    const defaults: Array<[string, string]> = [];
    for (const [index, [label, addSignal]] of signals.entries()) {
      const signalOwner = `backfill-minded-${index}`;
      await db.insert(schema.users).values({ id: signalOwner, email: `${signalOwner}@test.com` });
      await addSignal(signalOwner);
      const candidate = await insertBoard({ ownerId: signalOwner });
      const policyCandidate = await insertBoard({ ownerId: signalOwner });
      await db
        .insert(schema.resourcePrivacy)
        .values({ kind: 'board', resourceId: policyCandidate.uuid, ownerId: signalOwner, audience: 'only_me' });
      defaults.push([label, candidate.uuid], [label, policyCandidate.uuid]);
    }
    // The same shape with no signal anywhere still goes public.
    const control = await insertBoard();

    await runBackfill();

    for (const [label, uuid] of defaults) {
      expect((await boardRow(uuid)).isPublic, label).toBe(false);
    }
    expect((await boardRow(control.uuid)).isPublic).toBe(true);
  });

  it('makes untouched flag-private accounts public and keeps every account that chose', async () => {
    const accounts = ['flag-default', 'chose-private', 'finished-setup', 'old-account', 'only-me-default', 'edited'];
    await db.insert(schema.users).values(accounts.map((id) => ({ id, email: `${id}@test.com` })));
    await db.insert(schema.userProfiles).values([
      { userId: 'flag-default', isPrivate: true, defaultSessionAudience: 'followers' },
      { userId: 'chose-private', isPrivate: true, defaultSessionAudience: 'followers', privacyRevision: 1 },
      { userId: 'finished-setup', isPrivate: true, defaultSessionAudience: 'followers', privacyOnboardingVersion: 1 },
      {
        userId: 'old-account',
        isPrivate: true,
        defaultSessionAudience: 'followers',
        createdAt: new Date('2026-10-08T21:27:50Z'),
        updatedAt: new Date('2026-10-08T21:27:50Z'),
      },
      { userId: 'only-me-default', isPrivate: true, defaultSessionAudience: 'only_me' },
    ]);
    // Saved again in settings (still private, so the revision did not move).
    await db
      .insert(schema.userProfiles)
      .values({ userId: 'edited', isPrivate: true, defaultSessionAudience: 'followers' });
    await db.execute(
      sql`UPDATE user_profiles SET updated_at = created_at + interval '1 minute' WHERE user_id = 'edited'`,
    );

    await runBackfill();

    const profiles = new Map(
      (await db.select().from(schema.userProfiles)).map((profile) => [profile.userId, profile] as const),
    );
    expect(profiles.get('flag-default')).toMatchObject({ isPrivate: false, defaultSessionAudience: null });
    for (const kept of ['chose-private', 'finished-setup', 'old-account', 'only-me-default', 'edited']) {
      expect(profiles.get(kept)?.isPrivate, kept).toBe(true);
    }
  });

  it('keeps a board created public and switched private through the legacy updateBoard', async () => {
    const created = await socialBoardMutations.createBoard(
      null,
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          sizeId: 1,
          setIds: '5,6,7,8,9,10',
          name: 'Switched private',
          allowDuplicateConfig: true,
        },
      },
      ownerContext,
    );
    await socialBoardMutations.updateBoard(null, { input: { boardUuid: created.uuid, isPublic: false } }, ownerContext);
    expect(await boardRow(created.uuid)).toMatchObject({ isPublic: false, hideLocation: true });
    expect(await boardPolicy(created.uuid)).toBeUndefined();

    await runBackfill();

    expect((await boardRow(created.uuid)).isPublic).toBe(false);
  });

  it('narrows every followers location to invited people, whatever its date', async () => {
    const old = await insertBoard({
      isPublic: true,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
    await db.insert(schema.resourcePrivacy).values({
      kind: 'board',
      resourceId: old.uuid,
      ownerId: owner,
      audience: 'public',
      locationAudience: 'followers',
      revision: 2,
    });

    await runBackfill();

    expect(await boardPolicy(old.uuid)).toMatchObject({ audience: 'public', locationAudience: 'members', revision: 2 });
    expect(await boardRow(old.uuid)).toMatchObject({ isPublic: true, hideLocation: true });
  });

  it("never touches a board's hidden location, in a public gym or not", async () => {
    const [gym] = await db
      .insert(schema.gyms)
      .values({
        uuid: 'backfill-public-gym',
        slug: 'backfill-public-gym',
        ownerId: SYSTEM_OWNER,
        name: 'Boulder Central',
        isPublic: true,
        latitude: 47,
        longitude: 8,
      })
      .returning({ id: schema.gyms.id });
    // A viewer it is hidden from sees the gym's place at read time; the row keeps its owner's choice.
    const atGym = await insertBoard({ gymId: gym.id, latitude: 47, longitude: 8, locationName: 'Boulder Central' });
    const home = await insertBoard({ latitude: 47.3, longitude: 8.4, locationName: '12 Elm Street' });

    await runBackfill();

    for (const board of [atGym, home]) {
      expect(await boardRow(board.uuid), board.uuid).toMatchObject({ isPublic: true, hideLocation: true });
    }
  });

  it('runs once: a board made private after the backfill stays private on a second run', async () => {
    const board = await insertBoard();
    await runBackfill();
    expect((await boardRow(board.uuid)).isPublic).toBe(true);

    // The owner flips it back with an old client's legacy switch.
    await db.update(schema.userBoards).set({ isPublic: false }).where(eq(schema.userBoards.uuid, board.uuid));
    await runBackfill();
    expect((await boardRow(board.uuid)).isPublic).toBe(false);
  });
});
