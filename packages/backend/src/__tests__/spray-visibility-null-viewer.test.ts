/**
 * The spray-wall visibility rule's signed-out form leaves out every branch that
 * compares a row with the viewer (owner, grants, follows, gym membership), so a
 * reader with no viewer needs no privilege on those tables. This pins that the
 * shortcut changes nothing: for every wall shape, with and without the
 * unlisted capability, in the column form and the reference form (the one read
 * under a negation), the new SQL returns what the full rule returned, and
 * signed-in readers still take the full rule.
 */
import { like, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';
import {
  rowsOf,
  sprayClimbVisibilityCondition,
  sprayLayoutVisibilitySql,
  sprayReferenceVisibilityCondition,
} from '@boardsesh/db/queries';
import { db } from '../db/client';

const PREFIX = 'spray-null-viewer-';
const OWNER = `${PREFIX}owner`;
const FOLLOWER = `${PREFIX}follower`;
const GRANTEE = `${PREFIX}grantee`;
const MEMBER = `${PREFIX}member`;
const STRANGER = `${PREFIX}stranger`;
const FIRST_LAYOUT = 990_800;

/** `sprayResourceVisibility` exactly as it read before the signed-out shortcut. */
function fullRuleResourceVisibility(viewer: string | null, wallUuid: string | null): SQL {
  const capability = wallUuid == null ? sql`false` : sql`ub.uuid = ${wallUuid}::text`;
  return sql`(
    ub.owner_id = ${viewer}::text OR (
      NOT EXISTS (SELECT 1 FROM resource_grants revoked
        WHERE revoked.kind = 'board' AND revoked.resource_id = ub.uuid
          AND revoked.user_id = ${viewer}::text AND revoked.status = 'revoked')
      AND (
        EXISTS (SELECT 1 FROM resource_privacy privacy
          WHERE privacy.kind = 'board' AND privacy.resource_id = ub.uuid AND (
            privacy.audience = 'public'
            OR (privacy.audience = 'unlisted' AND ${capability})
            OR (privacy.audience <> 'only_me' AND (
              EXISTS (SELECT 1 FROM resource_grants granted
                WHERE granted.kind = 'board' AND granted.resource_id = ub.uuid
                  AND granted.user_id = ${viewer}::text AND granted.status = 'approved')
              OR ((privacy.audience = 'followers' OR privacy.inherit_followers)
                AND EXISTS (SELECT 1 FROM user_follows followed
                  WHERE followed.follower_id = ${viewer}::text AND followed.following_id = ub.owner_id))
            ))
          ))
        OR (NOT EXISTS (SELECT 1 FROM resource_privacy privacy
              WHERE privacy.kind = 'board' AND privacy.resource_id = ub.uuid)
          AND ((ub.is_public AND NOT ub.is_unlisted)
            OR (ub.is_unlisted AND ${capability})
            OR EXISTS (SELECT 1 FROM gym_members gm
              WHERE gm.gym_id = ub.gym_id AND gm.user_id = ${viewer}::text)))
      )
    )
  )`;
}

/** `sprayLayoutVisibilitySql` over the full rule. */
function fullRuleVisibilitySql(layoutId: number, viewer: string | null, wallUuid: string | null): SQL {
  return sql`SELECT EXISTS (
    SELECT 1
    FROM spray_walls sw
    JOIN user_boards ub ON ub.uuid = sw.board_uuid
    WHERE sw.layout_id = ${layoutId}
      AND sw.deleted_at IS NULL
      AND ub.deleted_at IS NULL
      AND (sw.hidden_at IS NULL OR (${viewer}::text IS NOT NULL AND ub.owner_id = ${viewer}::text))
      AND ${fullRuleResourceVisibility(viewer, wallUuid)}
  ) AS visible`;
}

/** `sprayReferenceVisibilityCondition` over the full rule. */
function fullRuleReferenceSql(climbUuid: string, viewer: string | null): SQL {
  return sql`SELECT NOT EXISTS (
    SELECT 1
    FROM board_climbs ref_climb
    WHERE ref_climb.uuid = ${climbUuid}
      AND ref_climb.board_type = 'spray'
      AND NOT EXISTS (
        SELECT 1
        FROM spray_walls sw
        JOIN user_boards ub ON ub.uuid = sw.board_uuid
        WHERE sw.layout_id = ref_climb.layout_id
          AND sw.deleted_at IS NULL
          AND ub.deleted_at IS NULL
          AND (sw.hidden_at IS NULL OR (${viewer}::text IS NOT NULL AND ub.owner_id = ${viewer}::text))
          AND ${fullRuleResourceVisibility(viewer, null)}
      )
  ) AS visible`;
}

function referenceSql(climbUuid: string, viewer: string | null): SQL {
  return sql`SELECT ${sprayReferenceVisibilityCondition({ boardType: sql`'spray'`, climbUuid: sql`${climbUuid}::text` }, viewer)} AS visible`;
}

type WallShape = {
  name: string;
  audience?: 'public' | 'unlisted' | 'followers' | 'invite_only' | 'only_me';
  inheritFollowers?: boolean;
  isPublic?: boolean;
  isUnlisted?: boolean;
  inGym?: boolean;
  hidden?: boolean;
  /** The spray wall row soft-deleted, its board left alone. */
  wallDeleted?: boolean;
  grantFor?: { userId: string; status: 'approved' | 'revoked' };
};

const WALLS: WallShape[] = [
  { name: 'explicit-public', audience: 'public' },
  { name: 'explicit-unlisted', audience: 'unlisted' },
  { name: 'explicit-followers', audience: 'followers' },
  { name: 'explicit-invite-only', audience: 'invite_only', grantFor: { userId: GRANTEE, status: 'approved' } },
  { name: 'explicit-invite-only-inheriting', audience: 'invite_only', inheritFollowers: true },
  { name: 'explicit-only-me', audience: 'only_me', grantFor: { userId: GRANTEE, status: 'approved' } },
  { name: 'explicit-public-revoked', audience: 'public', grantFor: { userId: STRANGER, status: 'revoked' } },
  { name: 'legacy-public', isPublic: true },
  { name: 'legacy-private', isPublic: false },
  { name: 'legacy-unlisted', isPublic: true, isUnlisted: true },
  { name: 'legacy-private-gym', isPublic: false, inGym: true },
  { name: 'legacy-public-hidden', isPublic: true, hidden: true },
  { name: 'deleted-wall', isPublic: true, wallDeleted: true },
  { name: 'legacy-private-unlisted', isPublic: false, isUnlisted: true },
];

const VIEWERS = [null, OWNER, FOLLOWER, GRANTEE, MEMBER, STRANGER];

function climbOf(wallName: string): string {
  return `${PREFIX}climb-${wallName}`;
}

const wallUuids = new Map<string, string>();

async function clearFixtures(): Promise<void> {
  const boards = db
    .select({ uuid: dbSchema.userBoards.uuid })
    .from(dbSchema.userBoards)
    .where(like(dbSchema.userBoards.ownerId, `${PREFIX}%`));
  await db.delete(dbSchema.boardClimbs).where(like(dbSchema.boardClimbs.uuid, `${PREFIX}%`));
  await db.delete(dbSchema.resourceGrants).where(like(dbSchema.resourceGrants.resourceId, `${PREFIX}%`));
  await db.delete(dbSchema.resourcePrivacy).where(like(dbSchema.resourcePrivacy.resourceId, `${PREFIX}%`));
  await db.delete(dbSchema.sprayWalls).where(sql`${dbSchema.sprayWalls.boardUuid} IN ${boards}`);
  await db.delete(dbSchema.userBoards).where(like(dbSchema.userBoards.ownerId, `${PREFIX}%`));
  await db.delete(dbSchema.gyms).where(like(dbSchema.gyms.ownerId, `${PREFIX}%`));
  await db.delete(dbSchema.userFollows).where(like(dbSchema.userFollows.followerId, `${PREFIX}%`));
  await db.delete(dbSchema.users).where(like(dbSchema.users.id, `${PREFIX}%`));
}

beforeAll(async () => {
  await clearFixtures();
  await db
    .insert(dbSchema.users)
    .values(
      [OWNER, FOLLOWER, GRANTEE, MEMBER, STRANGER].map((id) => ({ id, email: `${id}@example.invalid`, name: id })),
    );
  await db.insert(dbSchema.userFollows).values({ followerId: FOLLOWER, followingId: OWNER });
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid: `${PREFIX}gym`, name: 'Null viewer gym', ownerId: OWNER, isPublic: false })
    .returning({ id: dbSchema.gyms.id });
  await db.insert(dbSchema.gymMembers).values({ gymId: gym.id, userId: MEMBER, role: 'member' });
  for (const [index, wall] of WALLS.entries()) {
    const uuid = `${PREFIX}${wall.name}`;
    const layoutId = FIRST_LAYOUT + index;
    wallUuids.set(wall.name, uuid);
    await db.insert(dbSchema.userBoards).values({
      uuid,
      slug: uuid,
      ownerId: OWNER,
      boardType: 'spray',
      layoutId,
      sizeId: layoutId,
      setIds: '1',
      name: wall.name,
      isPublic: wall.isPublic ?? true,
      isUnlisted: wall.isUnlisted ?? false,
      gymId: wall.inGym ? gym.id : null,
    });
    await db.insert(dbSchema.sprayWalls).values({
      boardUuid: uuid,
      layoutId,
      hiddenAt: wall.hidden ? new Date('2026-01-01T00:00:00.000Z') : null,
      deletedAt: wall.wallDeleted ? new Date('2026-01-01T00:00:00.000Z') : null,
    });
    await db.insert(dbSchema.boardClimbs).values({
      uuid: climbOf(wall.name),
      boardType: 'spray',
      layoutId,
      name: wall.name,
      isDraft: false,
      isListed: true,
    });
    if (wall.audience) {
      await db.insert(dbSchema.resourcePrivacy).values({
        kind: 'board',
        resourceId: uuid,
        ownerId: OWNER,
        audience: wall.audience,
        inheritFollowers: wall.inheritFollowers ?? false,
      });
    }
    if (wall.grantFor) {
      await db.insert(dbSchema.resourceGrants).values({ kind: 'board', resourceId: uuid, ...wall.grantFor });
    }
  }
});

afterAll(async () => {
  await clearFixtures();
});

async function visible(query: SQL): Promise<boolean> {
  const [row] = rowsOf<{ visible: boolean }>(await db.execute(query));
  return row?.visible === true;
}

describe('spray-wall visibility for a signed-out reader', () => {
  it('returns what the full rule returned, for every wall, viewer and capability', async () => {
    const mismatches: string[] = [];
    for (const [index, wall] of WALLS.entries()) {
      const layoutId = FIRST_LAYOUT + index;
      for (const viewer of VIEWERS) {
        for (const capability of [null, wallUuids.get(wall.name) ?? null]) {
          const current = await visible(sprayLayoutVisibilitySql(layoutId, viewer, capability));
          const full = await visible(fullRuleVisibilitySql(layoutId, viewer, capability));
          if (current !== full) mismatches.push(`${wall.name} viewer=${viewer} capability=${capability !== null}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('shows a signed-out reader public walls only, and unlisted ones only through their link', async () => {
    const seen = async (capability: boolean) => {
      const names: string[] = [];
      for (const [index, wall] of WALLS.entries()) {
        const link = capability ? (wallUuids.get(wall.name) ?? null) : null;
        if (await visible(sprayLayoutVisibilitySql(FIRST_LAYOUT + index, null, link))) names.push(wall.name);
      }
      return names;
    };
    expect(await seen(false)).toEqual(['explicit-public', 'explicit-public-revoked', 'legacy-public']);
    expect(await seen(true)).toEqual([
      'explicit-public',
      'explicit-unlisted',
      'explicit-public-revoked',
      'legacy-public',
      'legacy-unlisted',
      'legacy-private-unlisted',
    ]);
  });

  it('keeps the reference form, read under a negation, equal to the full rule', async () => {
    const mismatches: string[] = [];
    // A reference whose climb row is gone stays readable, as it always was.
    for (const climbUuid of [...WALLS.map((wall) => climbOf(wall.name)), `${PREFIX}climb-missing`]) {
      for (const viewer of VIEWERS) {
        const current = await visible(referenceSql(climbUuid, viewer));
        const full = await visible(fullRuleReferenceSql(climbUuid, viewer));
        if (current !== full) mismatches.push(`${climbUuid} viewer=${viewer}`);
      }
    }
    expect(mismatches).toEqual([]);
    const readable: string[] = [];
    for (const wall of WALLS) {
      if (await visible(referenceSql(climbOf(wall.name), null))) readable.push(wall.name);
    }
    expect(readable).toEqual(['explicit-public', 'explicit-public-revoked', 'legacy-public']);
  });

  it('names no follow, grant or membership table for a signed-out reader, and keeps them for a viewer', () => {
    const dialect = new PgDialect();
    const render = (viewer: string | null) =>
      dialect.sqlToQuery(
        sprayClimbVisibilityCondition({ boardType: sql`c.board_type`, layoutId: sql`c.layout_id` }, viewer),
      ).sql;
    const signedOut = render(null);
    for (const table of ['user_follows', 'resource_grants', 'gym_members']) {
      expect(signedOut).not.toContain(table);
      expect(render(STRANGER)).toContain(table);
    }
    expect(signedOut).toContain('resource_privacy');
  });
});
