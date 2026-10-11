import { expect } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncAudience, SyncCursorInput, SyncResult } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { syncQueries } from '../../graphql/resolvers/sync/queries';

/**
 * A catalogue board and one spray wall holding a climb of every class the
 * publication rule has to place (#6306): a climb is in the REFERENCE stream
 * (published and listed, whoever set it), in its owner's PROTECTED stream (their
 * own draft or unlisted climb), or in neither (a draft or unlisted climb nobody
 * owns). Shared by the climb, stats, grades and plan tests so they all argue
 * about the same rows.
 */

/** A private account. Its published climbs are public all the same. */
export const AUDIENCE_OWNER = 'sync-audience-owner';
/** An accepted follower of the owner. Following grants nothing in the sync. */
export const AUDIENCE_FOLLOWER = 'sync-audience-follower';
/** Asked to follow the owner and has not been approved. */
export const AUDIENCE_PENDING_FOLLOWER = 'sync-audience-pending-follower';
/** No relationship to anybody, and no climbs. */
export const AUDIENCE_STRANGER = 'sync-audience-stranger';
/** A public account with a draft and an unlisted climb of its own. */
export const AUDIENCE_PUBLIC_AUTHOR = 'sync-audience-public-author';

export const AUDIENCE_VIEWERS = [
  AUDIENCE_OWNER,
  AUDIENCE_FOLLOWER,
  AUDIENCE_PENDING_FOLLOWER,
  AUDIENCE_STRANGER,
  AUDIENCE_PUBLIC_AUTHOR,
] as const;

const ALL_USERS: readonly string[] = AUDIENCE_VIEWERS;

export const AUDIENCE_BOARD_TYPE = 'kilter';
export const AUDIENCE_LAYOUT_ID = 1;
export const AUDIENCE_SIZE_ID = 5;
export const AUDIENCE_OTHER_SIZE_ID = 7;
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
  /** `null` is the column's third state. It is not a draft. */
  isDraft?: boolean | null;
  /** `null` is the column's third state. It is not listed. */
  isListed?: boolean | null;
  isHidden?: boolean;
  /**
   * An explicit policy row. `ownerless` is what account deletion leaves behind.
   * `consentRevision` is the account revision a Public choice was made at. None
   * of it decides anything in the sync: it is here to show that.
   */
  policy?: { audience: 'public' | 'followers' | 'only_me'; ownerless?: boolean; consentRevision?: number };
};

const FIXTURE_CLIMBS: FixtureClimb[] = [
  // Published and listed, so public, whatever else is true of the row.
  // Manufacturer climbs:
  { uuid: 'ref-a' },
  { uuid: 'ref-b' },
  { uuid: 'ref-size-7', sizeIds: [AUDIENCE_OTHER_SIZE_ID] },
  // Hidden by moderation is not unlisted: still public.
  { uuid: 'ref-hidden', isHidden: true },
  // A NULL draft flag is not a draft.
  { uuid: 'ref-null-draft-flag', isDraft: null },
  // A public account's climb, a private account's climbs, and that private
  // account's item choices: Only me, a current Public choice, a stale one.
  { uuid: 'pub-public-account', userId: AUDIENCE_PUBLIC_AUTHOR },
  { uuid: 'pub-private-account', userId: AUDIENCE_OWNER },
  { uuid: 'pub-private-account-size-7', userId: AUDIENCE_OWNER, sizeIds: [AUDIENCE_OTHER_SIZE_ID] },
  { uuid: 'pub-only-me', userId: AUDIENCE_OWNER, policy: { audience: 'only_me' } },
  {
    uuid: 'pub-public-consent',
    userId: AUDIENCE_OWNER,
    policy: { audience: 'public', consentRevision: OWNER_PRIVACY_REVISION },
  },
  {
    uuid: 'pub-stale-consent',
    userId: AUDIENCE_OWNER,
    policy: { audience: 'public', consentRevision: OWNER_PRIVACY_REVISION - 1 },
  },
  // A deleted account's climbs: the owner is gone and the author flag stays,
  // one of them with the ownerless policy row deletion leaves on a restricted
  // climb. And a policy row on a climb nobody ever owned.
  { uuid: 'pub-deleted-account', authored: true },
  { uuid: 'pub-deleted-account-restricted', authored: true, policy: { audience: 'only_me', ownerless: true } },
  { uuid: 'pub-orphan-policy', policy: { audience: 'only_me', ownerless: true } },

  // Not public: a draft or an unlisted climb. Its owner's alone.
  { uuid: 'draft-private-account', userId: AUDIENCE_OWNER, isDraft: true, isListed: false },
  { uuid: 'unlisted-private-account', userId: AUDIENCE_OWNER, isListed: false },
  { uuid: 'draft-private-account-size-7', userId: AUDIENCE_OWNER, isDraft: true, sizeIds: [AUDIENCE_OTHER_SIZE_ID] },
  // A public account's draft and unlisted climb are no more public than those.
  { uuid: 'draft-public-account', userId: AUDIENCE_PUBLIC_AUTHOR, isDraft: true, isListed: false },
  { uuid: 'unlisted-public-account', userId: AUDIENCE_PUBLIC_AUTHOR, isListed: false },
  // A listed flag does not publish a draft, and a NULL listed flag is not listed.
  { uuid: 'draft-listed-flag', userId: AUDIENCE_PUBLIC_AUTHOR, isDraft: true, isListed: true },
  { uuid: 'unlisted-null-flag', userId: AUDIENCE_PUBLIC_AUTHOR, isListed: null },
  // Nobody owns these, so nobody is sent them: a manufacturer draft imported
  // with no owner, an unlisted manufacturer climb, and a deleted account's draft.
  { uuid: 'draft-ownerless', isDraft: true, isListed: false },
  { uuid: 'unlisted-ownerless', isListed: false },
  { uuid: 'draft-deleted-account', authored: true, isDraft: true, isListed: false },

  // Another layout of the same board: never part of a layout-scoped pull.
  { uuid: 'other-layout-ref', layoutId: 2 },
  { uuid: 'other-layout-pub', layoutId: 2, userId: AUDIENCE_PUBLIC_AUTHOR },
  { uuid: 'other-layout-draft', layoutId: 2, userId: AUDIENCE_PUBLIC_AUTHOR, isDraft: true, isListed: false },

  // The spray wall, which only its owner may read. A published climb its owner
  // set, a legacy published row with no owner, the owner's draft, and a draft
  // somebody else set on the wall.
  { uuid: 'spray-pub-own', ...sprayClimb(), userId: AUDIENCE_OWNER },
  { uuid: 'spray-pub-ownerless', ...sprayClimb() },
  { uuid: 'spray-draft-own', ...sprayClimb(), userId: AUDIENCE_OWNER, isDraft: true, isListed: false },
  { uuid: 'spray-draft-visitor', ...sprayClimb(), userId: AUDIENCE_PUBLIC_AUTHOR, isDraft: true, isListed: false },
];

function sprayClimb(): Pick<FixtureClimb, 'boardType' | 'layoutId' | 'sizeIds'> {
  return { boardType: 'spray', layoutId: AUDIENCE_SPRAY_LAYOUT_ID, sizeIds: [AUDIENCE_SPRAY_LAYOUT_ID] };
}

// An omitted flag is the fixture's default (published, listed). An explicit NULL
// is the column's third state: not a draft, and not listed.
const isPublic = (climb: FixtureClimb) =>
  climb.isDraft !== true && (climb.isListed === undefined || climb.isListed === true);
const onLayout = (layoutId: number) => (climb: FixtureClimb) =>
  (climb.boardType ?? AUDIENCE_BOARD_TYPE) === AUDIENCE_BOARD_TYPE &&
  (climb.layoutId ?? AUDIENCE_LAYOUT_ID) === layoutId;
const uuidsOf = (climbs: FixtureClimb[]) => climbs.map((climb) => climb.uuid).sort();

/**
 * What the rule says each stream holds on the main layout, derived from the
 * fixture's own flags and owners and from nothing the resolvers compute.
 */
export const EXPECTED_ON_LAYOUT = {
  /** Published and listed: the same for every viewer. */
  reference: uuidsOf(FIXTURE_CLIMBS.filter(onLayout(AUDIENCE_LAYOUT_ID)).filter(isPublic)),
  /** The viewer's own drafts and unlisted climbs. */
  protectedFor: (viewerId: string) =>
    uuidsOf(
      FIXTURE_CLIMBS.filter(onLayout(AUDIENCE_LAYOUT_ID)).filter(
        (climb) => !isPublic(climb) && climb.userId === viewerId,
      ),
    ),
  /** Every draft and unlisted climb on the layout, whoever owns it. */
  notPublic: uuidsOf(FIXTURE_CLIMBS.filter(onLayout(AUDIENCE_LAYOUT_ID)).filter((climb) => !isPublic(climb))),
};

/** Climbs that get a second stats row, so a stream carries more rows than climbs. */
const SECOND_ANGLE_CLIMBS = new Set(['ref-a', 'pub-private-account', 'draft-private-account']);

/**
 * The public author's send of their own climb. Before the publication rule the
 * single-stream pull projected a first-ascent name from it; no stream does now.
 */
const FIRST_ASCENT_TICK_UUID = 'sync-audience-first-ascent';
export const FIRST_ASCENT_CLIMB_UUID = 'pub-public-account';

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
  await db.execute(sql`DELETE FROM sync_deletions WHERE table_name IN ('board_climbs', 'board_climb_stats')`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid = ${FIRST_ASCENT_TICK_UUID}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join([...ALL_USERS], sql`, `)})`);

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
         ${climb.isListed === undefined ? true : climb.isListed}, ${climb.isDraft === undefined ? false : climb.isDraft},
         ${climb.isHidden ?? false}, ${sizeIds}::int[],
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
 * The one difference is on a spray wall, where PROTECTED is the whole union and
 * still ships no first-ascent name or date on a stats row.
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
