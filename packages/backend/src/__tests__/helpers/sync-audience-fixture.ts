import { expect } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncAudience, SyncCursorInput, SyncResult } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { syncQueries } from '../../graphql/resolvers/sync/queries';

/**
 * A catalogue board and one spray wall holding a climb of every class the sync
 * audience split (#6306) has to place: a row belongs to the REFERENCE stream,
 * to the PROTECTED stream of the viewers who may see it, or to neither. Shared
 * by the climb, stats and grades tests so all three argue about the same rows.
 */

/** A private account. Owns the restricted climbs. */
export const AUDIENCE_OWNER = 'sync-audience-owner';
/** An accepted follower of the owner. */
export const AUDIENCE_FOLLOWER = 'sync-audience-follower';
/** Asked to follow the owner and has not been approved. Sees what a stranger sees. */
export const AUDIENCE_PENDING_FOLLOWER = 'sync-audience-pending-follower';
/** No relationship to anybody. */
export const AUDIENCE_STRANGER = 'sync-audience-stranger';
/** A public account whose climbs every signed-in climber may see. */
export const AUDIENCE_PUBLIC_AUTHOR = 'sync-audience-public-author';

export const AUDIENCE_VIEWERS = [
  AUDIENCE_OWNER,
  AUDIENCE_FOLLOWER,
  AUDIENCE_PENDING_FOLLOWER,
  AUDIENCE_STRANGER,
] as const;

const ALL_USERS = [...AUDIENCE_VIEWERS, AUDIENCE_PUBLIC_AUTHOR];

export const AUDIENCE_BOARD_TYPE = 'kilter';
export const AUDIENCE_LAYOUT_ID = 1;
export const AUDIENCE_SIZE_ID = 5;
export const AUDIENCE_OTHER_SIZE_ID = 7;
/** Holds only the draft, unlisted and moderation-hidden climbs. See {@link STATE_CLIMBS}. */
export const AUDIENCE_STATE_LAYOUT_ID = 3;
/** A private spray wall owned by {@link AUDIENCE_OWNER}. */
export const AUDIENCE_SPRAY_LAYOUT_ID = 9001;

/** The owner's current privacy revision. An explicit Public choice holds only at this revision. */
const OWNER_PRIVACY_REVISION = 2;

type FixtureClimb = {
  uuid: string;
  boardType?: string;
  layoutId?: number;
  sizeIds?: number[];
  userId?: string;
  authored?: boolean;
  isDraft?: boolean;
  isListed?: boolean;
  isHidden?: boolean;
  /**
   * An explicit policy row. `ownerless` is what account deletion leaves behind.
   * `consentRevision` is the account revision a Public choice was made at.
   */
  policy?: { audience: 'public' | 'followers' | 'only_me'; ownerless?: boolean; consentRevision?: number };
};

/**
 * Climbs that are a draft, unlisted, or hidden by moderation: one with no owner
 * and one set by a public account, for each state. Neither the single stream
 * nor either audience filters on these flags today, and the tests pin that as
 * it stands. It is current behaviour, not a privacy guarantee.
 */
export const STATE_CLIMBS = {
  unowned: ['state-unowned-draft', 'state-unowned-hidden', 'state-unowned-unlisted'],
  owned: ['state-owned-draft', 'state-owned-hidden', 'state-owned-unlisted'],
};

const FIXTURE_CLIMBS: FixtureClimb[] = [
  // Reference climbs: no owner, no author flag, no policy row.
  { uuid: 'ref-a' },
  { uuid: 'ref-b' },
  { uuid: 'ref-size-7', sizeIds: [AUDIENCE_OTHER_SIZE_ID] },
  // A public account's climb: every viewer may see it, and it is still protected.
  { uuid: 'own-public', userId: AUDIENCE_PUBLIC_AUTHOR },
  // A private account's climbs: the owner and accepted followers only.
  { uuid: 'own-private', userId: AUDIENCE_OWNER },
  { uuid: 'own-private-size-7', userId: AUDIENCE_OWNER, sizeIds: [AUDIENCE_OTHER_SIZE_ID] },
  { uuid: 'own-only-me', userId: AUDIENCE_OWNER, policy: { audience: 'only_me' } },
  // The private account's explicit Public choices. One was made at the
  // account's current revision and opens the climb to everyone. The other
  // predates a later privacy change, so it no longer counts and the climb is
  // back to the owner and accepted followers.
  {
    uuid: 'own-public-consent',
    userId: AUDIENCE_OWNER,
    policy: { audience: 'public', consentRevision: OWNER_PRIVACY_REVISION },
  },
  {
    uuid: 'own-stale-consent',
    userId: AUDIENCE_OWNER,
    policy: { audience: 'public', consentRevision: OWNER_PRIVACY_REVISION - 1 },
  },
  // A deleted account's climbs. The owner is gone and the author flag stays. A
  // climb that was public is retained; a restricted one keeps an ownerless
  // policy row that no viewer satisfies.
  { uuid: 'deleted-public', authored: true },
  { uuid: 'deleted-private', authored: true, policy: { audience: 'only_me', ownerless: true } },
  // A policy row on a climb nobody owns and nobody authored. Unreachable through
  // the API (a policy needs an owner), and it must still land in neither stream.
  { uuid: 'orphan-policy', policy: { audience: 'only_me', ownerless: true } },
  // Another layout of the same board: never part of a layout-scoped pull.
  { uuid: 'other-layout-ref', layoutId: 2 },
  { uuid: 'other-layout-own', layoutId: 2, userId: AUDIENCE_PUBLIC_AUTHOR },
  // A layout of their own for the draft, unlisted and hidden climbs.
  { uuid: 'state-unowned-draft', layoutId: AUDIENCE_STATE_LAYOUT_ID, isDraft: true },
  { uuid: 'state-unowned-unlisted', layoutId: AUDIENCE_STATE_LAYOUT_ID, isListed: false },
  { uuid: 'state-unowned-hidden', layoutId: AUDIENCE_STATE_LAYOUT_ID, isHidden: true },
  { uuid: 'state-owned-draft', layoutId: AUDIENCE_STATE_LAYOUT_ID, userId: AUDIENCE_PUBLIC_AUTHOR, isDraft: true },
  { uuid: 'state-owned-unlisted', layoutId: AUDIENCE_STATE_LAYOUT_ID, userId: AUDIENCE_PUBLIC_AUTHOR, isListed: false },
  { uuid: 'state-owned-hidden', layoutId: AUDIENCE_STATE_LAYOUT_ID, userId: AUDIENCE_PUBLIC_AUTHOR, isHidden: true },
  // The spray wall. One climb its owner set, and one legacy row with no owner,
  // no author flag and no policy: by the row predicate alone it would be a
  // reference climb, which is why spray is excluded by board TYPE.
  {
    uuid: 'spray-own',
    boardType: 'spray',
    layoutId: AUDIENCE_SPRAY_LAYOUT_ID,
    sizeIds: [AUDIENCE_SPRAY_LAYOUT_ID],
    userId: AUDIENCE_OWNER,
  },
  { uuid: 'spray-orphan', boardType: 'spray', layoutId: AUDIENCE_SPRAY_LAYOUT_ID, sizeIds: [AUDIENCE_SPRAY_LAYOUT_ID] },
];

/** Climbs that get a second stats row, so a stream carries more rows than climbs. */
const SECOND_ANGLE_CLIMBS = new Set(['ref-a', 'own-private']);

/**
 * The public author's send of their own climb. It gives the single-stream pull
 * a first-ascent name to project, so the tests can show that PROTECTED ships
 * none even where the viewer was allowed to see one.
 */
const FIRST_ASCENT_TICK_UUID = 'sync-audience-first-ascent';
export const FIRST_ASCENT_CLIMB_UUID = 'own-public';

export function audienceContext(userId: string): ConnectionContext {
  return {
    connectionId: `sync-audience-${userId}`,
    isAuthenticated: true,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

/**
 * Replace the board tables with the fixture. Rows carry explicit, shared
 * timestamps so every stream has to break ties on `sync_seq`, and every column
 * a stream reads is set at INSERT: an UPDATE would fire the sync-field trigger
 * and move the row's cursor position.
 */
export async function seedSyncAudienceFixture(): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades, spray_walls, user_boards
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`DELETE FROM content_privacy WHERE entity_type = 'climb'`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid = ${FIRST_ASCENT_TICK_UUID}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(ALL_USERS, sql`, `)})`);

  for (const userId of ALL_USERS) {
    await db.execute(
      sql`INSERT INTO users (id, name, email) VALUES (${userId}, ${userId}, ${`${userId}@example.test`})`,
    );
  }
  await db.execute(sql`
    INSERT INTO user_profiles (user_id, is_private, privacy_revision)
    VALUES (${AUDIENCE_OWNER}, true, ${OWNER_PRIVACY_REVISION})
  `);
  await db.execute(sql`
    INSERT INTO user_follows (follower_id, following_id) VALUES (${AUDIENCE_FOLLOWER}, ${AUDIENCE_OWNER})
  `);
  await db.execute(sql`
    INSERT INTO user_follow_requests (requester_id, recipient_id)
    VALUES (${AUDIENCE_PENDING_FOLLOWER}, ${AUDIENCE_OWNER})
  `);

  const wallBoardUuid = 'sync-audience-wall';
  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, is_unlisted)
    VALUES (${wallBoardUuid}, ${wallBoardUuid}, ${AUDIENCE_OWNER}, 'spray', ${AUDIENCE_SPRAY_LAYOUT_ID},
            ${AUDIENCE_SPRAY_LAYOUT_ID}, '', 'Private wall', false, false)
  `);
  await db.execute(sql`
    INSERT INTO spray_walls (board_uuid, layout_id, reference_width, reference_height, hold_count)
    VALUES (${wallBoardUuid}, ${AUDIENCE_SPRAY_LAYOUT_ID}, 800, 620, 0)
  `);

  for (const climb of FIXTURE_CLIMBS) {
    const boardType = climb.boardType ?? AUDIENCE_BOARD_TYPE;
    const sizeIds = `{${(climb.sizeIds ?? [AUDIENCE_SIZE_ID]).join(',')}}`;
    await db.execute(sql`
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, compatible_size_ids, user_id,
         is_boardsesh_authored, updated_at)
      VALUES
        (${climb.uuid}, ${boardType}, ${climb.layoutId ?? AUDIENCE_LAYOUT_ID}, ${`Climb ${climb.uuid}`},
         ${climb.isListed ?? true}, ${climb.isDraft ?? false}, ${climb.isHidden ?? false}, ${sizeIds}::int[],
         ${climb.userId ?? null}, ${climb.authored ?? false}, '2026-05-01T00:00:00Z'::timestamp)
    `);
    if (climb.policy) {
      await db.execute(sql`
        INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience, public_consent_revision)
        VALUES ('climb', ${climb.uuid}, ${climb.policy.ownerless ? null : (climb.userId ?? null)},
                ${climb.policy.audience}, ${climb.policy.consentRevision ?? null})
      `);
    }
    const angles = SECOND_ANGLE_CLIMBS.has(climb.uuid) ? [40, 45] : [40];
    for (const angle of angles) {
      await db.execute(sql`
        INSERT INTO board_climb_stats
          (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, fa_username, fa_at, updated_at)
        VALUES
          (${boardType}, ${climb.uuid}, ${angle}, 20, 3, ${`Stored FA ${climb.uuid}`},
           '2020-01-02T03:04:05Z'::timestamp, '2026-05-02T00:00:00Z'::timestamp)
      `);
      await db.execute(sql`
        INSERT INTO board_climb_grades
          (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence,
           ascensionist_count, model_version, coeff_version, computed_at)
        VALUES
          (${boardType}, ${climb.uuid}, ${angle}, 20, 21, 19, 23, 'confirmed', 3, 'audience-model', 'audience-coeff',
           '2026-05-03T00:00:00Z'::timestamp)
      `);
    }
  }

  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
    VALUES (${FIRST_ASCENT_TICK_UUID}, ${AUDIENCE_PUBLIC_AUTHOR}, ${AUDIENCE_BOARD_TYPE}, ${FIRST_ASCENT_CLIMB_UUID},
            40, 'send', '2026-04-01T00:00:00Z'::timestamp)
  `);
}

export type AudienceResolver = 'syncClimbs' | 'syncClimbStats' | 'syncClimbGrades';

export type AudienceScope = { boardType: string; layoutId?: number | null; sizeId?: number | null };

/** `undefined` is the request a client older than the split sends: no `audience` key at all. */
export type RequestedAudience = SyncAudience | null | undefined;

export type SyncDocument = Record<string, unknown>;

export function pullAudiencePage(params: {
  resolver: AudienceResolver;
  scope: AudienceScope;
  viewerId: string;
  audience: RequestedAudience;
  cursor?: SyncCursorInput | null;
  limit?: number;
}): Promise<SyncResult> {
  const { resolver, scope, viewerId, audience, cursor = null, limit = 500 } = params;
  const pageArgs = { layoutId: null, sizeId: null, ...scope, cursor, limit };
  return syncQueries[resolver](
    undefined,
    audience === undefined ? pageArgs : { ...pageArgs, audience },
    audienceContext(viewerId),
  );
}

/** The row identity a stream is compared on: a climb, or a climb at an angle. */
export function documentKey(resolver: AudienceResolver, document: SyncDocument): string {
  return resolver === 'syncClimbs' ? String(document.uuid) : `${String(document.climb_uuid)}@${String(document.angle)}`;
}

/**
 * Page one stream to its tail. Throws on a row delivered twice, so a paging bug
 * cannot hide behind a later set comparison.
 */
export async function pullAllDocuments(params: {
  resolver: AudienceResolver;
  scope: AudienceScope;
  viewerId: string;
  audience: RequestedAudience;
  pageSize?: number;
}): Promise<SyncDocument[]> {
  const documents: SyncDocument[] = [];
  const seenKeys = new Set<string>();
  let cursor: SyncCursorInput | null = null;
  for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
    const page: SyncResult = await pullAudiencePage({ ...params, cursor, limit: params.pageSize ?? 500 });
    for (const document of page.documents as SyncDocument[]) {
      const key = documentKey(params.resolver, document);
      if (seenKeys.has(key)) throw new Error(`${params.resolver} delivered ${key} twice`);
      seenKeys.add(key);
      documents.push(document);
    }
    cursor = page.cursor;
    if (!page.hasMore) return documents;
  }
  throw new Error(`${params.resolver} never reached its tail`);
}

export function keysOf(resolver: AudienceResolver, documents: SyncDocument[]): string[] {
  return documents.map((document) => documentKey(resolver, document)).sort();
}

export type AudienceStreams = {
  /** What a request with no audience returns: every row this viewer may see. */
  union: SyncDocument[];
  reference: SyncDocument[];
  protectedStream: SyncDocument[];
};

export async function pullAudienceStreams(params: {
  resolver: AudienceResolver;
  scope: AudienceScope;
  viewerId: string;
  pageSize?: number;
}): Promise<AudienceStreams> {
  const [union, reference, protectedStream] = await Promise.all([
    pullAllDocuments({ ...params, audience: undefined }),
    pullAllDocuments({ ...params, audience: 'REFERENCE' }),
    pullAllDocuments({ ...params, audience: 'PROTECTED' }),
  ]);
  return { union, reference, protectedStream };
}

/**
 * The contract of the split: no row is in both streams, the two together are
 * exactly the single-stream pull, and each row is the same document it is there.
 * The one difference is deliberate — a PROTECTED stats row carries no
 * first-ascent name or date.
 */
export function expectStreamsPartitionUnion(resolver: AudienceResolver, streams: AudienceStreams): void {
  const unionKeys = keysOf(resolver, streams.union);
  const referenceKeys = keysOf(resolver, streams.reference);
  const protectedKeys = keysOf(resolver, streams.protectedStream);

  expect(referenceKeys.filter((key) => protectedKeys.includes(key))).toEqual([]);
  expect([...referenceKeys, ...protectedKeys].sort()).toEqual(unionKeys);

  const unionByKey = new Map(streams.union.map((document) => [documentKey(resolver, document), document]));
  for (const document of streams.reference) {
    expect(document).toEqual(unionByKey.get(documentKey(resolver, document)));
  }
  for (const document of streams.protectedStream) {
    const unionDocument = unionByKey.get(documentKey(resolver, document));
    expect(document).toEqual(
      resolver === 'syncClimbStats' ? { ...unionDocument, fa_username: null, fa_at: null } : unionDocument,
    );
  }
}
