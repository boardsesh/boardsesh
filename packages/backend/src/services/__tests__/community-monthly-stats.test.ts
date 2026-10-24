/**
 * The monthly community recap's numbers, against the worker database: which
 * lighting, gyms, sends and climbers count, how each list ranks and breaks
 * ties, the UTC month edges, and the naming rule. The events built from these
 * numbers are tested in services/analytics/__tests__/community-monthly-events.test.ts.
 *
 * "Now" sits in March 2025, well before any row another test writes with the
 * real clock, so the per-month counts here see only this file's fixtures.
 */
import { randomUUID } from 'node:crypto';
import { inArray, like } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';
import { RECOMMENDATIONS_USER_ID } from '@boardsesh/db/queries';
import { db } from '../../db/client';
import { buildCommunityMonthlyEvents } from '../analytics/community-monthly-events';
import {
  communityMonthWindow,
  computeCommunityMonthlyStats,
  publishableClimberName,
  type CommunityMonthlyStats,
} from '../community-monthly-stats';

const NOW = new Date('2025-03-15T12:00:00.000Z');
const PREFIX = 'recap-';
const OWNER = `${PREFIX}owner`;
const LISTED_CLIMB = `${PREFIX}climb-listed`;
const UNLISTED_CLIMB = `${PREFIX}climb-unlisted`;
const DRAFT_CLIMB = `${PREFIX}climb-draft`;
const SPRAY_LAYOUT_PRIVATE = 990_901;
const SPRAY_LAYOUT_HIDDEN = 990_902;
const SPRAY_LAYOUT_VISIBLE = 990_903;
const PRIVATE_WALL_CLIMB = `${PREFIX}climb-private-wall`;
const HIDDEN_WALL_CLIMB = `${PREFIX}climb-hidden-wall`;

let nextSeq = 1;

async function createUser(
  id: string,
  options: {
    name?: string;
    displayName?: string;
    isPrivate?: boolean;
    anonymousOnForeignBoards?: boolean;
    createdAt?: Date;
  } = {},
): Promise<string> {
  await db.insert(dbSchema.users).values({
    id,
    email: `${id}@example.invalid`,
    name: options.name ?? null,
    // Old enough to fall outside every window here unless a test says otherwise.
    createdAt: options.createdAt ?? new Date('2020-01-01T00:00:00.000Z'),
  });
  if (
    options.displayName !== undefined ||
    options.isPrivate !== undefined ||
    options.anonymousOnForeignBoards !== undefined
  ) {
    await db.insert(dbSchema.userProfiles).values({
      userId: id,
      displayName: options.displayName ?? null,
      isPrivate: options.isPrivate ?? false,
      anonymousOnForeignBoards: options.anonymousOnForeignBoards ?? false,
    });
  }
  return id;
}

async function createGym(
  name: string,
  options: { slug?: string | null; isPublic?: boolean; deleted?: boolean } = {},
): Promise<number> {
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({
      uuid: randomUUID(),
      name,
      slug: options.slug === undefined ? `${PREFIX}${randomUUID()}` : options.slug,
      ownerId: OWNER,
      isPublic: options.isPublic ?? true,
      deletedAt: options.deleted ? new Date('2025-01-01T00:00:00.000Z') : null,
    })
    .returning({ id: dbSchema.gyms.id });
  return gym.id;
}

async function createBoard(
  options: {
    gymId?: number | null;
    isPublic?: boolean;
    isUnlisted?: boolean;
    deleted?: boolean;
    /** A spray wall on this layout, hidden by an admin or deleted on its own if asked. */
    sprayWall?: { layoutId: number; hidden?: boolean; deleted?: boolean };
  } = {},
): Promise<number> {
  const uuid = randomUUID();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: `${PREFIX}${uuid}`,
      ownerId: OWNER,
      boardType: options.sprayWall ? 'spray' : 'kilter',
      layoutId: options.sprayWall?.layoutId ?? 1,
      sizeId: 10,
      setIds: '1',
      name: 'Recap wall',
      gymId: options.gymId ?? null,
      isPublic: options.isPublic ?? true,
      isUnlisted: options.isUnlisted ?? false,
      deletedAt: options.deleted ? new Date('2025-01-01T00:00:00.000Z') : null,
    })
    .returning({ id: dbSchema.userBoards.id });
  if (options.sprayWall) {
    await db.insert(dbSchema.sprayWalls).values({
      boardUuid: uuid,
      layoutId: options.sprayWall.layoutId,
      hiddenAt: options.sprayWall.hidden ? new Date('2025-01-01T00:00:00.000Z') : null,
      deletedAt: options.sprayWall.deleted ? new Date('2025-01-01T00:00:00.000Z') : null,
    });
  }
  return board.id;
}

async function lightClimb(
  boardId: number,
  userId: string | null,
  confirmedAt: string,
  source: string = 'boardsesh',
): Promise<void> {
  await db.insert(dbSchema.boardClimbEvents).values({
    boardId,
    boardType: 'kilter',
    source,
    externalOccurrenceKey: source === 'boardsesh' ? null : randomUUID(),
    climbUuid: LISTED_CLIMB,
    angle: 40,
    userId,
    seq: nextSeq++,
    confirmedAt,
  });
}

async function logTick(
  userId: string,
  climbedAt: string,
  options: {
    status?: 'flash' | 'send' | 'attempt';
    origin?: 'native' | 'aurora_pull';
    climbUuid?: string;
    boardType?: 'kilter' | 'spray';
    audience?: 'public' | 'followers' | 'only_me';
    /** The privacy revision a public audience was chosen under; a private account's must match its profile. */
    publicConsentRevision?: number;
  } = {},
): Promise<void> {
  const uuid = randomUUID();
  await db.insert(dbSchema.boardseshTicks).values({
    uuid,
    userId,
    boardType: options.boardType ?? 'kilter',
    climbUuid: options.climbUuid ?? LISTED_CLIMB,
    angle: 40,
    status: options.status ?? 'send',
    origin: options.origin ?? 'native',
    climbedAt,
  });
  if (options.audience) {
    await db.insert(dbSchema.contentPrivacy).values({
      entityType: 'tick',
      entityId: uuid,
      ownerId: userId,
      audience: options.audience,
      publicConsentRevision: options.publicConsentRevision ?? null,
    });
  }
}

/** A send per day for `days` days from `firstDay` (a March 2025 date). */
async function logSends(
  userId: string,
  count: number,
  options: { flashes?: number; days?: number; audience?: 'public'; publicConsentRevision?: number } = {},
) {
  const days = options.days ?? 1;
  for (let index = 0; index < count; index += 1) {
    const day = String(3 + (index % days)).padStart(2, '0');
    await logTick(userId, `2025-03-${day}T10:00:00.000Z`, {
      status: index < (options.flashes ?? 0) ? 'flash' : 'send',
      audience: options.audience,
      publicConsentRevision: options.publicConsentRevision,
    });
  }
}

function compute(months = 2): Promise<CommunityMonthlyStats> {
  return computeCommunityMonthlyStats({ database: db, now: NOW, months });
}

beforeEach(async () => {
  // Explicit deletes, child first: the test schema does not cascade every
  // foreign key the production schema does.
  const fixtureBoards = db
    .select({ id: dbSchema.userBoards.id })
    .from(dbSchema.userBoards)
    .where(like(dbSchema.userBoards.ownerId, `${PREFIX}%`));
  await db.delete(dbSchema.contentPrivacy).where(like(dbSchema.contentPrivacy.ownerId, `${PREFIX}%`));
  await db.delete(dbSchema.boardseshTicks).where(like(dbSchema.boardseshTicks.userId, `${PREFIX}%`));
  await db.delete(dbSchema.boardClimbEvents).where(inArray(dbSchema.boardClimbEvents.boardId, fixtureBoards));
  await db
    .delete(dbSchema.sprayWalls)
    .where(inArray(dbSchema.sprayWalls.layoutId, [SPRAY_LAYOUT_PRIVATE, SPRAY_LAYOUT_HIDDEN, SPRAY_LAYOUT_VISIBLE]));
  await db.delete(dbSchema.userBoards).where(like(dbSchema.userBoards.ownerId, `${PREFIX}%`));
  await db.delete(dbSchema.gyms).where(like(dbSchema.gyms.ownerId, `${PREFIX}%`));
  await db.delete(dbSchema.userProfiles).where(like(dbSchema.userProfiles.userId, `${PREFIX}%`));
  await db.delete(dbSchema.users).where(like(dbSchema.users.id, `${PREFIX}%`));
  await db.delete(dbSchema.users).where(like(dbSchema.users.id, 'system-%'));
  await db.delete(dbSchema.boardClimbs).where(like(dbSchema.boardClimbs.uuid, `${PREFIX}%`));
  await createUser(OWNER);
  await db.insert(dbSchema.boardClimbs).values([
    { uuid: LISTED_CLIMB, boardType: 'kilter', layoutId: 1, name: 'Listed', isDraft: false, isListed: true },
    { uuid: UNLISTED_CLIMB, boardType: 'kilter', layoutId: 1, name: 'Unlisted', isDraft: false, isListed: false },
    { uuid: DRAFT_CLIMB, boardType: 'kilter', layoutId: 1, name: 'Draft', isDraft: true, isListed: true },
    {
      uuid: PRIVATE_WALL_CLIMB,
      boardType: 'spray',
      layoutId: SPRAY_LAYOUT_PRIVATE,
      name: 'Private wall climb',
      isDraft: false,
      isListed: true,
    },
    {
      uuid: HIDDEN_WALL_CLIMB,
      boardType: 'spray',
      layoutId: SPRAY_LAYOUT_HIDDEN,
      name: 'Hidden wall climb',
      isDraft: false,
      isListed: true,
    },
  ]);
});

describe('communityMonthWindow', () => {
  it('covers the current UTC month and the months before it, oldest first', () => {
    expect(communityMonthWindow(new Date('2026-01-15T00:00:00.000Z'), 2)).toEqual({
      months: ['2025-12', '2026-01'],
      start: new Date('2025-12-01T00:00:00.000Z'),
      end: new Date('2026-02-01T00:00:00.000Z'),
    });
    const yearly = communityMonthWindow(new Date('2026-10-31T23:59:59.999Z'), 13);
    expect(yearly.months).toHaveLength(13);
    expect(yearly.months[0]).toBe('2025-10');
    expect(yearly.months.at(-1)).toBe('2026-10');
    expect(yearly.end).toEqual(new Date('2026-11-01T00:00:00.000Z'));
  });

  it('refuses a window outside 1 to 13 months', () => {
    expect(() => communityMonthWindow(NOW, 0)).toThrow(RangeError);
    expect(() => communityMonthWindow(NOW, 14)).toThrow(RangeError);
    expect(() => communityMonthWindow(NOW, 1.5)).toThrow(RangeError);
  });
});

describe('computeCommunityMonthlyStats', () => {
  it('splits every count on the UTC month edge and skips a month nobody lit a climb in', async () => {
    const board = await createBoard();
    const alice = await createUser(`${PREFIX}alice`, { name: 'alice', createdAt: new Date('2025-02-10T08:00:00Z') });
    const bob = await createUser(`${PREFIX}bob`, { name: 'bob', createdAt: new Date('2025-03-01T00:00:00Z') });
    await createUser(RECOMMENDATIONS_USER_ID, { createdAt: new Date('2025-03-02T00:00:00Z') });
    // January: a send but nothing lit, so no cohort.
    await logTick(alice, '2025-01-20T10:00:00.000Z');
    // The last second of February and the first of March.
    await lightClimb(board, alice, '2025-02-28T23:59:59.000Z');
    await lightClimb(board, bob, '2025-03-01T00:00:00.000Z');
    await lightClimb(board, bob, '2025-03-01T00:00:01.000Z');
    await lightClimb(board, null, '2025-03-02T00:00:00.000Z');
    // Kilter's own display history is not Boardsesh lighting.
    await lightClimb(board, alice, '2025-03-05T00:00:00.000Z', 'kilter');
    await logTick(alice, '2025-02-28T23:59:59.000Z', { status: 'flash' });
    await logTick(bob, '2025-03-01T00:00:00.000Z');
    // Neither an attempt nor an imported logbook entry is a send logged here.
    await logTick(bob, '2025-03-01T10:00:00.000Z', { status: 'attempt' });
    await logTick(alice, '2025-03-02T10:00:00.000Z', { origin: 'aurora_pull' });

    const stats = await compute(3);

    expect(stats.skippedMonths).toEqual([{ month: '2025-01', complete: true }]);
    expect(stats.months.map(({ month, complete, summary }) => ({ month, complete, summary }))).toEqual([
      {
        month: '2025-02',
        complete: true,
        summary: {
          climbersWhoLit: 1,
          climbsLit: 1,
          boardsLit: 1,
          gymsWithActivity: 0,
          sendsLogged: 1,
          climbersWhoLogged: 1,
          newAccounts: 1,
        },
      },
      {
        month: '2025-03',
        complete: false,
        summary: {
          // The lit climb whose climber deleted their account counts; its climber cannot.
          climbersWhoLit: 1,
          climbsLit: 3,
          boardsLit: 1,
          gymsWithActivity: 0,
          sendsLogged: 1,
          climbersWhoLogged: 1,
          // Bob; the reserved recommendations account is not a person.
          newAccounts: 1,
        },
      },
    ]);
  });

  it('ranks gyms on their public, listed, live boards, and only public gyms that still exist', async () => {
    const alpha = await createGym('Alpha Gym', { slug: 'alpha-gym' });
    const gone = await createGym('Gone Gym', { deleted: true });
    const hidden = await createGym('Hidden Gym', { isPublic: false });
    const alphaWall = await createBoard({ gymId: alpha });
    const alphaSecondWall = await createBoard({ gymId: alpha });
    const alphaPrivateWall = await createBoard({ gymId: alpha, isPublic: false });
    const alphaUnlistedWall = await createBoard({ gymId: alpha, isUnlisted: true });
    const alphaDeletedWall = await createBoard({ gymId: alpha, deleted: true });
    const goneWall = await createBoard({ gymId: gone });
    const hiddenWall = await createBoard({ gymId: hidden });
    const homeWall = await createBoard();
    const climbers = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((suffix) => createUser(`${PREFIX}gym-climber-${suffix}`)),
    );
    const [first, second, privateWallClimber, unlistedWallClimber, elsewhere] = climbers;
    await lightClimb(alphaWall, first, '2025-03-03T10:00:00.000Z');
    await lightClimb(alphaWall, second, '2025-03-03T10:05:00.000Z');
    await lightClimb(alphaSecondWall, first, '2025-03-04T10:00:00.000Z');
    await lightClimb(alphaPrivateWall, privateWallClimber, '2025-03-04T10:00:00.000Z');
    await lightClimb(alphaUnlistedWall, unlistedWallClimber, '2025-03-04T10:00:00.000Z');
    await lightClimb(alphaDeletedWall, elsewhere, '2025-03-04T10:00:00.000Z');
    await lightClimb(alphaWall, elsewhere, '2025-03-04T10:00:00.000Z', 'kilter');
    for (const climber of climbers) {
      await lightClimb(goneWall, climber, '2025-03-05T10:00:00.000Z');
      await lightClimb(hiddenWall, climber, '2025-03-05T10:00:00.000Z');
      await lightClimb(homeWall, climber, '2025-03-05T10:00:00.000Z');
    }

    const [march] = (await compute(1)).months;

    expect(march.topGyms).toEqual([
      { rank: 1, gymName: 'Alpha Gym', gymSlug: 'alpha-gym', climbers: 2, climbsLit: 3, boards: 2 },
    ]);
    expect(march.summary.gymsWithActivity).toBe(1);
    // Totals still count every Boardsesh lighting, whatever the board.
    expect(march.summary).toMatchObject({ climbersWhoLit: 5, climbsLit: 21, boardsLit: 8 });
  });

  it('leaves spray walls an admin hid or their owner deleted out of the gym ranking', async () => {
    const boulderGym = await createGym('Boulder Gym');
    const hiddenWallGym = await createGym('Hidden Wall Gym');
    const sprayGym = await createGym('Spray Gym');
    const climber = await createUser(`${PREFIX}spray-gym-climber`);
    await lightClimb(await createBoard({ gymId: boulderGym }), climber, '2025-03-03T10:00:00.000Z');
    const hiddenWall = await createBoard({
      gymId: hiddenWallGym,
      sprayWall: { layoutId: SPRAY_LAYOUT_HIDDEN, hidden: true },
    });
    await lightClimb(hiddenWall, climber, '2025-03-03T10:00:00.000Z');
    const deletedWall = await createBoard({
      gymId: boulderGym,
      sprayWall: { layoutId: SPRAY_LAYOUT_PRIVATE, deleted: true },
    });
    await lightClimb(deletedWall, climber, '2025-03-03T11:00:00.000Z');
    // A spray wall nobody hid ranks like any other wall.
    const sprayWall = await createBoard({ gymId: sprayGym, sprayWall: { layoutId: SPRAY_LAYOUT_VISIBLE } });
    await lightClimb(sprayWall, climber, '2025-03-03T12:00:00.000Z');

    const [march] = (await compute(1)).months;

    expect(march.topGyms.map(({ gymName, climbsLit, boards }) => ({ gymName, climbsLit, boards }))).toEqual([
      { gymName: 'Boulder Gym', climbsLit: 1, boards: 1 },
      { gymName: 'Spray Gym', climbsLit: 1, boards: 1 },
    ]);
    expect(march.summary).toMatchObject({ gymsWithActivity: 2, climbsLit: 4, boardsLit: 4 });
  });

  it('breaks a gym tie on climbs lit, then on the older gym', async () => {
    const older = await createGym('Older Gym', { slug: null });
    const busier = await createGym('Busier Gym');
    const newer = await createGym('Newer Gym');
    const climber = await createUser(`${PREFIX}tie-climber`);
    await lightClimb(await createBoard({ gymId: older }), climber, '2025-03-03T10:00:00.000Z');
    const busierWall = await createBoard({ gymId: busier });
    await lightClimb(busierWall, climber, '2025-03-03T10:00:00.000Z');
    await lightClimb(busierWall, climber, '2025-03-03T11:00:00.000Z');
    await lightClimb(await createBoard({ gymId: newer }), climber, '2025-03-03T10:00:00.000Z');

    const [march] = (await compute(1)).months;

    expect(march.topGyms.map(({ rank, gymName, gymSlug }) => ({ rank, gymName, gymSlug }))).toEqual([
      { rank: 1, gymName: 'Busier Gym', gymSlug: expect.any(String) },
      { rank: 2, gymName: 'Older Gym', gymSlug: null },
      { rank: 3, gymName: 'Newer Gym', gymSlug: expect.any(String) },
    ]);
  });

  it('ranks the sends a signed-out visitor may read, and names only public climbers by their display name', async () => {
    const board = await createBoard();
    await createBoard({ isPublic: false, sprayWall: { layoutId: SPRAY_LAYOUT_PRIVATE } });
    await createBoard({ sprayWall: { layoutId: SPRAY_LAYOUT_HIDDEN, hidden: true } });
    const privateClimber = await createUser(`${PREFIX}private`, {
      name: 'Private Pat',
      displayName: 'Private Pat',
      isPrivate: true,
    });
    const anonymous = await createUser(`${PREFIX}anonymous`, {
      name: 'Hidden Name',
      displayName: 'Hidden Display',
      anonymousOnForeignBoards: true,
    });
    const alice = await createUser(`${PREFIX}alice`, { name: 'alice', displayName: '  Alice D  ' });
    const bob = await createUser(`${PREFIX}bob`, { name: 'Bob Account', displayName: '   ' });
    const carol = await createUser(`${PREFIX}carol`, { name: 'Carol Account' });
    // The month must have lighting to report at all.
    await lightClimb(board, alice, '2025-03-02T10:00:00.000Z');
    // A private account's sends count only where it made them public under its
    // current privacy revision; then it ranks, unnamed.
    await logSends(privateClimber, 6, { audience: 'public', publicConsentRevision: 0 });
    await logSends(privateClimber, 5);
    await logTick(privateClimber, '2025-03-04T10:00:00.000Z', { audience: 'public', publicConsentRevision: 1 });
    await logSends(anonymous, 5);
    await logSends(alice, 4);
    await logSends(bob, 3);
    await logSends(carol, 2);
    // Not readable by a signed-out visitor, so not counted: an only-me send, a
    // followers-only send, and sends on an unlisted climb, a draft, and climbs
    // on a private and an admin-hidden spray wall.
    await logTick(bob, '2025-03-04T10:00:00.000Z', { audience: 'only_me' });
    await logTick(bob, '2025-03-04T11:00:00.000Z', { audience: 'followers' });
    await logTick(bob, '2025-03-04T12:00:00.000Z', { climbUuid: UNLISTED_CLIMB });
    await logTick(bob, '2025-03-04T13:00:00.000Z', { climbUuid: DRAFT_CLIMB });
    await logTick(bob, '2025-03-04T14:00:00.000Z', { climbUuid: PRIVATE_WALL_CLIMB, boardType: 'spray' });
    await logTick(bob, '2025-03-04T15:00:00.000Z', { climbUuid: HIDDEN_WALL_CLIMB, boardType: 'spray' });
    // An imported logbook does not rank anyone.
    for (let index = 0; index < 6; index += 1) {
      await logTick(alice, '2025-03-05T10:00:00.000Z', { origin: 'aurora_pull' });
    }

    const stats = await compute(1);
    const [march] = stats.months;

    expect(march.topClimbers).toEqual([
      // A private account: ranked on the sends it made public, never named.
      { rank: 1, climberName: null, sends: 6, flashes: 0, sendDays: 1 },
      // Anonymous on boards they don't own: ranked, never named.
      { rank: 2, climberName: null, sends: 5, flashes: 0, sendDays: 1 },
      // Named by the display name, trimmed.
      { rank: 3, climberName: 'Alice D', sends: 4, flashes: 0, sendDays: 1 },
      // A blank display name, or none, leaves a climber unnamed: the account
      // name is never a fallback.
      { rank: 4, climberName: null, sends: 3, flashes: 0, sendDays: 1 },
      { rank: 5, climberName: null, sends: 2, flashes: 0, sendDays: 1 },
    ]);
    const climberRows = buildCommunityMonthlyEvents(march).filter(
      (monthEvent) => monthEvent.properties.list === 'climbers' && monthEvent.properties.empty === false,
    );
    expect(climberRows.map((monthEvent) => monthEvent.properties.named)).toEqual([false, false, true, false, false]);
    // The totals are not privacy-filtered: every native send counts.
    expect(march.summary).toMatchObject({ sendsLogged: 32, climbersWhoLogged: 5 });
    const serialized = JSON.stringify(stats);
    for (const userId of [anonymous, alice, bob, carol, privateClimber]) expect(serialized).not.toContain(userId);
    for (const name of ['Hidden', 'Private Pat', 'Bob Account', 'Carol Account']) {
      expect(serialized).not.toContain(name);
    }
  });

  it('names no one whose display name has no letter or digit in it, in any script', async () => {
    const board = await createBoard();
    const displayNames = ['\t\t', '\u00a0\u00a0', '\u200b\u200d', 'Åsa', '李'];
    for (const [index, displayName] of displayNames.entries()) {
      const climber = await createUser(`${PREFIX}script-${index}`, { name: `Account ${index}`, displayName });
      if (index === 0) await lightClimb(board, climber, '2025-03-02T10:00:00.000Z');
      await logSends(climber, displayNames.length - index);
    }

    const [march] = (await compute(1)).months;

    expect(march.topClimbers.map(({ climberName }) => climberName)).toEqual([null, null, null, 'Åsa', '李']);
  });

  it('publishes a display name only when it has a letter or digit once trimmed', () => {
    expect(publishableClimberName('  Ægir\u00a0')).toBe('Ægir');
    expect(publishableClimberName('李')).toBe('李');
    expect(publishableClimberName('٣')).toBe('٣');
    for (const invisible of [null, '', '   ', '\t\n', '\u00a0', '\u200b', '\ufeff', '...', '—']) {
      expect(publishableClimberName(invisible)).toBeNull();
    }
  });

  it('breaks a climber tie on flashes, then send days, then a stable order it does not report', async () => {
    const board = await createBoard();
    const flasher = await createUser(`${PREFIX}c1`, { displayName: 'Flasher' });
    const regular = await createUser(`${PREFIX}c2`, { displayName: 'Regular' });
    const tiedFirst = await createUser(`${PREFIX}c3`, { displayName: 'Tied First' });
    const tiedSecond = await createUser(`${PREFIX}c4`, { displayName: 'Tied Second' });
    await lightClimb(board, flasher, '2025-03-02T10:00:00.000Z');
    await logSends(tiedSecond, 2);
    await logSends(regular, 2, { days: 2 });
    await logSends(tiedFirst, 2);
    await logSends(flasher, 2, { flashes: 1 });

    const [march] = (await compute(1)).months;

    expect(march.topClimbers).toEqual([
      { rank: 1, climberName: 'Flasher', sends: 2, flashes: 1, sendDays: 1 },
      { rank: 2, climberName: 'Regular', sends: 2, flashes: 0, sendDays: 2 },
      { rank: 3, climberName: 'Tied First', sends: 2, flashes: 0, sendDays: 1 },
      { rank: 4, climberName: 'Tied Second', sends: 2, flashes: 0, sendDays: 1 },
    ]);
  });

  it('keeps ten of each list and counts every active gym', async () => {
    for (let index = 0; index < 11; index += 1) {
      const climber = await createUser(`${PREFIX}many-${String(index).padStart(2, '0')}`, {
        displayName: `Climber ${index}`,
      });
      const gym = await createGym(`Gym ${index}`);
      await lightClimb(await createBoard({ gymId: gym }), climber, '2025-03-03T10:00:00.000Z');
      await logSends(climber, 1);
    }

    const [march] = (await compute(1)).months;

    expect(march.topGyms).toHaveLength(10);
    expect(march.topGyms.map((gym) => gym.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(march.topClimbers).toHaveLength(10);
    expect(march.summary.gymsWithActivity).toBe(11);
  });

  it('retires the names of the month behind a full window and keeps its counts and ranks', async () => {
    const gym = await createGym('Alpha Gym', { slug: 'alpha-gym' });
    const board = await createBoard({ gymId: gym });
    const alice = await createUser(`${PREFIX}alice`, { name: 'alice', displayName: 'Alice D' });
    const bob = await createUser(`${PREFIX}bob`, { name: 'Bob' });
    // February 2024 is the 14th month back from March 2025: just behind the window.
    await lightClimb(board, alice, '2024-02-10T10:00:00.000Z');
    await logTick(alice, '2024-02-10T10:00:00.000Z', { status: 'flash' });
    await logTick(alice, '2024-02-11T10:00:00.000Z');
    await logTick(bob, '2024-02-12T10:00:00.000Z');
    await lightClimb(board, alice, '2025-03-03T10:00:00.000Z');
    await logSends(alice, 1);

    const stats = await computeCommunityMonthlyStats({ database: db, now: NOW, months: 13, retireMonths: 1 });

    expect(stats.months.map(({ month, namesRetired }) => ({ month, namesRetired }))).toEqual([
      { month: '2024-02', namesRetired: true },
      { month: '2025-03', namesRetired: false },
    ]);
    const [retired, current] = stats.months;
    expect(retired).toMatchObject({
      complete: true,
      summary: { climbersWhoLit: 1, climbsLit: 1, sendsLogged: 3, climbersWhoLogged: 2, gymsWithActivity: 1 },
      // Gyms are not people: their rows are re-sent as they are.
      topGyms: [{ rank: 1, gymName: 'Alpha Gym', gymSlug: 'alpha-gym', climbers: 1, climbsLit: 1, boards: 1 }],
    });
    expect(retired.topClimbers).toEqual([
      { rank: 1, climberName: null, sends: 2, flashes: 1, sendDays: 2 },
      { rank: 2, climberName: null, sends: 1, flashes: 0, sendDays: 1 },
    ]);
    expect(current.topClimbers).toEqual([{ rank: 1, climberName: 'Alice D', sends: 1, flashes: 0, sendDays: 1 }]);
    // The twelve months between had no lighting.
    expect(stats.skippedMonths).toHaveLength(12);
    expect(JSON.stringify(stats)).not.toContain('Bob');
  });

  it('skips a month behind the window that nobody lit a climb in, like any other', async () => {
    const board = await createBoard();
    const alice = await createUser(`${PREFIX}alice`, { name: 'alice' });
    await logTick(alice, '2024-02-10T10:00:00.000Z');
    await lightClimb(board, alice, '2025-03-03T10:00:00.000Z');

    const stats = await computeCommunityMonthlyStats({ database: db, now: NOW, months: 13, retireMonths: 1 });

    expect(stats.months.map((communityMonth) => communityMonth.month)).toEqual(['2025-03']);
    expect(stats.skippedMonths[0]).toEqual({ month: '2024-02', complete: true });
    expect(stats.skippedMonths).toHaveLength(13);
  });

  it('reports a current month nobody has lit a climb in yet as empty and partial', async () => {
    const alice = await createUser(`${PREFIX}alice`);
    await lightClimb(await createBoard(), alice, '2025-02-20T10:00:00.000Z');

    const stats = await compute(2);

    expect(stats.months.map(({ month }) => month)).toEqual(['2025-02']);
    expect(stats.skippedMonths).toEqual([{ month: '2025-03', complete: false }]);
  });

  it('retires months only behind the full window', async () => {
    await expect(computeCommunityMonthlyStats({ database: db, now: NOW, months: 2, retireMonths: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      computeCommunityMonthlyStats({ database: db, now: NOW, months: 13, retireMonths: 13 }),
    ).rejects.toThrow(RangeError);
  });
});
