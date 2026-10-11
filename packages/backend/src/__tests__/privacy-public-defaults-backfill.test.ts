import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';

// The migration is read off disk and executed verbatim, so the assertions test
// the shipped file and not a copy of it.
const drizzleDir = fileURLToPath(new URL('../../../db/drizzle/', import.meta.url));
const BACKFILL = readFileSync(`${drizzleDir}0265_privacy_public_defaults_backfill.sql`, 'utf8');
const GUARD_TAG = 'privacy_public_defaults_backfill_b1';
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const owner = 'backfill-owner';

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
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS _bs_migration_guards (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  await db.execute(sql`DELETE FROM _bs_migration_guards WHERE tag = ${GUARD_TAG}`);
  await db.execute(sql`TRUNCATE TABLE resource_grants, resource_privacy, user_boards, user_profiles CASCADE`);
  await db
    .insert(schema.users)
    .values([
      { id: owner, email: `${owner}@test.com` },
      { id: SYSTEM_OWNER, email: 'system@test.com' },
    ])
    .onConflictDoNothing();
});

describe('0265 privacy public-defaults backfill', () => {
  it('makes untouched default-private boards public and leaves every deliberate choice alone', async () => {
    const legacyDefault = await insertBoard();
    const beforeCutoff = await insertBoard({ createdAt: new Date('2026-10-01T00:00:00Z') });
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
    const editedOnlyMe = await insertBoard();
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'board', resourceId: editedOnlyMe.uuid, ownerId: owner, audience: 'only_me', revision: 1 });

    await runBackfill();

    expect(await boardRow(legacyDefault.uuid)).toMatchObject({ isPublic: true, isUnlisted: false, hideLocation: true });
    expect(await boardPolicy(legacyDefault.uuid)).toBeUndefined();
    expect(await boardRow(untouchedOnlyMe.uuid)).toMatchObject({ isPublic: true, hideLocation: true });
    expect(await boardPolicy(untouchedOnlyMe.uuid)).toMatchObject({ audience: 'public', revision: 0 });

    for (const kept of [beforeCutoff, sprayWall, deleted, systemOwned, unlisted, withGrant, inviteOnly, editedOnlyMe]) {
      expect((await boardRow(kept.uuid)).isPublic, kept.uuid).toBe(false);
    }
    expect(await boardPolicy(inviteOnly.uuid)).toMatchObject({ audience: 'invite_only' });
    expect(await boardPolicy(editedOnlyMe.uuid)).toMatchObject({ audience: 'only_me' });
  });

  it('makes untouched flag-private accounts public and keeps every account that chose', async () => {
    const accounts = ['flag-default', 'chose-private', 'finished-setup', 'old-account', 'only-me-default'];
    await db.insert(schema.users).values(accounts.map((id) => ({ id, email: `${id}@test.com` })));
    await db.insert(schema.userProfiles).values([
      { userId: 'flag-default', isPrivate: true, defaultSessionAudience: 'followers' },
      { userId: 'chose-private', isPrivate: true, defaultSessionAudience: 'followers', privacyRevision: 1 },
      { userId: 'finished-setup', isPrivate: true, defaultSessionAudience: 'followers', privacyOnboardingVersion: 1 },
      {
        userId: 'old-account',
        isPrivate: true,
        defaultSessionAudience: 'followers',
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
      { userId: 'only-me-default', isPrivate: true, defaultSessionAudience: 'only_me' },
    ]);

    await runBackfill();

    const profiles = new Map(
      (await db.select().from(schema.userProfiles)).map((profile) => [profile.userId, profile] as const),
    );
    expect(profiles.get('flag-default')).toMatchObject({ isPrivate: false, defaultSessionAudience: null });
    for (const kept of ['chose-private', 'finished-setup', 'old-account', 'only-me-default']) {
      expect(profiles.get(kept)?.isPrivate, kept).toBe(true);
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
