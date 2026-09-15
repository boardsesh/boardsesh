import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import type {
  GraphQLArgument,
  GraphQLField,
  GraphQLInputField,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLType,
} from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * A schema-wide sweep: every climb reader in the SDL, run against ONE private
 * spray wall, for an anonymous caller, a stranger and the owner.
 *
 * ## Why this file exists
 *
 * PR #5462 gated around thirty readers, and it found them by reading code — three
 * review rounds and a self-audit, each of which turned up call sites the previous
 * one missed. That is not a process anybody should have to repeat every time a
 * resolver is added, and it is not one that holds: a spray climb is an ordinary
 * `board_climbs` row with `is_listed = true`, so the DEFAULT behaviour of any new
 * query is to leak a photograph of somebody's garage.
 *
 * So the field list is generated from the schema rather than written down. A new
 * `Query` or `Subscription` field that takes a climb uuid, a session id, a
 * playlist id, a gym uuid, a user id, a board id or a board+layout pair is swept
 * the moment it lands, and the author has to either make it reach the seeded wall
 * (proving the gate) or name it in {@link NOT_APPLICABLE} with a reason.
 *
 * ## What is asserted
 *
 * - **anonymous and stranger**: not one sentinel anywhere in the response. The
 *   sentinels are seeded INTO the data — an unmistakable climb name, description,
 *   frames string, hold ids, wall name, wall uuid, photo id and layout id — so the
 *   scan is a recursive walk for known strings and numbers rather than a guess at
 *   which field might have carried them.
 * - **owner**: at least one sentinel comes back, for every field not allow-listed.
 *   That half is what keeps the negative half honest: without it a gate that
 *   returned empty to EVERYONE would pass the sweep.
 *
 * ## The one thing to know before editing
 *
 * An argument echoed back is not a leak. `bulkClimbCommunityStatus(climbUuids:)`
 * answers one row per uuid the caller supplied, including for uuids that do not
 * exist — so the uuid in that response came from the caller, not from the
 * database. {@link scannableSentinels} therefore drops, per call, the sentinels
 * that appear in that call's own arguments. The secrets — name, description,
 * frames, photo id, wall name — are never arguments, so they are always scanned.
 */

// ---------------------------------------------------------------------------
// Module mocks. Storage has no R2 in CI; the rate limiters and the event fan-out
// would otherwise reach Redis. Everything else is real rows in the worker DB.
// ---------------------------------------------------------------------------

const { storedPhotoMetadata } = vi.hoisted(() => ({
  storedPhotoMetadata: new Map<string, { width: string; height: string }>(),
}));

vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  presignGetObject: vi.fn(async (_bucket: string, key: string) => ({
    url: `https://private.example/${key}?X-Amz-Signature=stub`,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  })),
  getS3ObjectMetadata: vi.fn(async (_bucket: string, key: string) => {
    const metadata = storedPhotoMetadata.get(key);
    return metadata ? { contentType: 'image/jpeg', contentLength: 1024, lastModified: new Date(), metadata } : null;
  }),
  uploadToS3: vi.fn(async (_bucket: string, _body: Buffer, key: string) => ({ key })),
}));

vi.mock('../lib/web-revalidate', () => ({
  notifyClimbRevalidated: vi.fn(async () => undefined),
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
  resetAllRateLimits: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

/**
 * `graphql` resolves to two module instances under the test transform: the ESM
 * copy a static `import` in this file would get, and the CJS copy
 * `@graphql-tools/schema` loaded when the backend built its schema. Executing a
 * schema built by one against the `execute` of the other fails the
 * `instanceof GraphQLSchema` check with the famously unhelpful "Cannot use
 * GraphQLSchema from another module". `createRequire` reaches the same copy the
 * backend used. Types come from the static `import type`, which is erased.
 */
const requireFromHere = createRequire(import.meta.url);
const graphql = requireFromHere('graphql') as typeof GraphQLModule;
const {
  execute,
  parse,
  subscribe,
  isEnumType,
  isInputObjectType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
} = graphql;

const { db } = await import('../db/client');
const { schema } = await import('../graphql/index');
const { sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { sprayWallQueries: sprayWallQueriesProbe } = await import('../graphql/resolvers/board/spray-walls');

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/**
 * Values seeded into the private wall's data that must never reach a stranger.
 *
 * Two classes, and the difference matters:
 *
 * - **secret** — never appears in any argument this sweep sends, so finding one
 *   anywhere in a response means the database handed it over;
 * - **identifier** — may legitimately be echoed back by a resolver that took it
 *   as an argument, so it is scanned only on calls that did NOT pass it.
 */
type SentinelClass = 'secret' | 'identifier';

type Sentinel = { name: string; value: string | number; kind: SentinelClass };

/** The climb name. Unmistakable on purpose: no substring of it occurs in the schema. */
const CLIMB_NAME = 'Zqx Sentinel Climb Name Zqx';
const CLIMB_DESCRIPTION = 'Zqx Sentinel Climb Description Zqx';
const WALL_NAME = 'Zqx Sentinel Wall Name Zqx';
const COMMENT_BODY = 'Zqx Sentinel Comment Body Zqx';
const PROPOSAL_REASON = 'Zqx Sentinel Proposal Reason Zqx';
const TICK_COMMENT = 'Zqx Sentinel Tick Comment Zqx';
// Deliberately NOT an Instagram or TikTok URL: those two enrich through a live
// outbound fetch that has nothing to answer it in CI, and the row is dropped.
const BETA_LINK = 'https://beta.example/ZqxSentinelBetaZqx';

/**
 * The spray catalogue sequences are restarted to these before seeding, so the
 * wall's layout id and its hold ids are values nothing else in the database can
 * collide with. A layout id of `1` would match a `1` in any response; `987654`
 * matches only this wall.
 */
const LAYOUT_ID_SEED = 987654;
const HOLD_ID_SEED = 876543;

const ANCHORS: [number, number][] = [
  [100, 80],
  [900, 120],
  [880, 700],
  [120, 660],
];

const OWNER = 'sweep-owner';
const STRANGER = 'sweep-stranger';
const ANGLE = 40;

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

type ViewerName = 'anonymous' | 'stranger' | 'owner';

const ctxFor = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `conn-${userId ?? 'anon'}`,
    isAuthenticated: userId != null,
    userId: userId ?? null,
  }) as unknown as ConnectionContext;

const VIEWERS: Array<{ name: ViewerName; ctx: ConnectionContext }> = [
  { name: 'anonymous', ctx: ctxFor(null) },
  { name: 'stranger', ctx: ctxFor(STRANGER) },
  { name: 'owner', ctx: ctxFor(OWNER) },
];

// ---------------------------------------------------------------------------
// Seeded world
// ---------------------------------------------------------------------------

type SeededWorld = {
  climbUuid: string;
  frames: string;
  holdIds: number[];
  wallUuid: string;
  wallSlug: string | null;
  boardId: number;
  layoutId: number;
  sizeId: number;
  setIds: string;
  photoId: string;
  gymUuid: string;
  gymSlug: string;
  playlistId: string;
  sessionId: string;
  serialNumber: string | null;
  username: string;
};

let world: SeededWorld;
let sentinels: Sentinel[] = [];

// ---------------------------------------------------------------------------
// The detection rule — ONE place
// ---------------------------------------------------------------------------

/**
 * What an argument (or an input-object field) NAMES.
 *
 * This is the whole detection rule. A new resolver is swept because its argument
 * names match one of these rows; if a new resolver names the same thing
 * differently, add the spelling HERE rather than writing a bespoke case.
 */
type SeedKind =
  | 'climbUuid'
  | 'climbUuids'
  | 'sessionId'
  | 'playlistId'
  | 'gymUuid'
  | 'gymSlug'
  | 'userId'
  | 'boardId'
  | 'boardUuid'
  | 'boardSlug'
  | 'boardType'
  | 'layoutId'
  | 'sizeId'
  | 'setIds'
  | 'angle'
  | 'serialNumbers'
  | 'entityType'
  | 'entityId'
  | 'username';

type ArgumentSite = { fieldName: string; argName: string; typeName: string };

const ARGUMENT_KINDS: Array<{ kind: SeedKind; when: (site: ArgumentSite) => boolean }> = [
  { kind: 'climbUuids', when: ({ argName }) => argName === 'climbUuids' },
  { kind: 'climbUuid', when: ({ argName }) => argName === 'climbUuid' },
  { kind: 'sessionId', when: ({ argName }) => argName === 'sessionId' },
  { kind: 'playlistId', when: ({ argName }) => argName === 'playlistId' },
  { kind: 'gymUuid', when: ({ argName }) => argName === 'gymUuid' || argName === 'gymId' },
  {
    kind: 'gymSlug',
    when: ({ fieldName, argName }) => argName === 'gymSlug' || (argName === 'slug' && /[Gg]ym/.test(fieldName)),
  },
  { kind: 'userId', when: ({ argName }) => argName === 'userId' || argName === 'setterUserId' },
  { kind: 'username', when: ({ argName }) => argName === 'username' },
  { kind: 'boardId', when: ({ argName, typeName }) => argName === 'boardId' && typeName === 'Int' },
  // A spray wall IS a `user_boards` row, so `boardUuid` and the spray queries'
  // bare `uuid` are the same key.
  {
    kind: 'boardUuid',
    when: ({ fieldName, argName }) => argName === 'boardUuid' || (argName === 'uuid' && /[Ss]prayWall/.test(fieldName)),
  },
  { kind: 'boardSlug', when: ({ fieldName, argName }) => argName === 'slug' && /[Bb]oard/.test(fieldName) },
  { kind: 'boardType', when: ({ argName }) => argName === 'boardType' || argName === 'boardName' },
  { kind: 'layoutId', when: ({ argName }) => argName === 'layoutId' },
  { kind: 'sizeId', when: ({ argName }) => argName === 'sizeId' },
  { kind: 'setIds', when: ({ argName }) => argName === 'setIds' },
  { kind: 'angle', when: ({ argName }) => argName === 'angle' },
  { kind: 'serialNumbers', when: ({ argName }) => argName === 'serialNumbers' },
  { kind: 'entityType', when: ({ argName }) => argName === 'entityType' },
  { kind: 'entityId', when: ({ argName }) => argName === 'entityId' },
];

/**
 * A field is swept when its arguments name one of the objects on the private
 * wall. The board+layout PAIR is deliberately a pair: `grades(boardName:)` alone
 * scopes nothing to a wall.
 */
function isRelevant(kinds: Set<SeedKind>): boolean {
  if (
    kinds.has('climbUuid') ||
    kinds.has('climbUuids') ||
    kinds.has('sessionId') ||
    kinds.has('playlistId') ||
    kinds.has('gymUuid') ||
    kinds.has('gymSlug') ||
    kinds.has('userId') ||
    kinds.has('boardId') ||
    kinds.has('boardUuid') ||
    kinds.has('boardSlug') ||
    kinds.has('entityId') ||
    kinds.has('username')
  ) {
    return true;
  }
  return kinds.has('boardType') && kinds.has('layoutId');
}

/** The value each kind resolves to, once the world is seeded. */
function seedValue(kind: SeedKind): unknown {
  switch (kind) {
    case 'climbUuid':
      return world.climbUuid;
    case 'climbUuids':
      return [world.climbUuid];
    case 'sessionId':
      return world.sessionId;
    case 'playlistId':
      return world.playlistId;
    case 'gymUuid':
      return world.gymUuid;
    case 'gymSlug':
      return world.gymSlug;
    case 'userId':
      return OWNER;
    case 'username':
      return world.username;
    case 'boardId':
      return world.boardId;
    case 'boardUuid':
      return world.wallUuid;
    case 'boardSlug':
      return world.wallSlug;
    case 'boardType':
      return 'spray';
    case 'layoutId':
      return world.layoutId;
    case 'sizeId':
      return world.sizeId;
    case 'setIds':
      return world.setIds;
    case 'angle':
      return ANGLE;
    case 'serialNumbers':
      return world.serialNumber == null ? [] : [world.serialNumber];
    case 'entityType':
      return 'climb';
    case 'entityId':
      return world.climbUuid;
  }
}

function kindFor(site: ArgumentSite): SeedKind | null {
  return ARGUMENT_KINDS.find((row) => row.when(site))?.kind ?? null;
}

/**
 * Values for arguments the rule does not recognise but the schema demands.
 *
 * A required argument with no sensible default makes the call error, the owner
 * find no sentinel, and the field land in {@link NOT_APPLICABLE} with an honest
 * reason — which is the correct outcome, not a gap.
 */
function fallbackValue(argName: string, type: GraphQLType): unknown {
  if (argName === 'limit' || argName === 'pageSize' || argName === 'first') return 20;
  if (argName === 'page') return 1;
  if (argName === 'offset' || argName === 'sinceSequence') return 0;
  const named = namedType(type);
  if (isEnumType(named)) return named.getValues()[0]?.name ?? null;
  switch (named.name) {
    case 'Int':
      return 0;
    case 'Float':
      return 0;
    case 'Boolean':
      return false;
    case 'String':
    case 'ID':
      return '';
    default:
      return null;
  }
}

function namedType(type: GraphQLType): GraphQLNamedType {
  let current: GraphQLType = type;
  while (isNonNullType(current) || isListType(current)) current = current.ofType;
  return current as GraphQLNamedType;
}

/**
 * Build the variable map for one field: every argument the rule recognises gets
 * the seeded value, every other REQUIRED argument gets a fallback, and optional
 * arguments are left out. Input objects recurse, so `searchClimbs(input:)` is
 * filled exactly as `climb(layoutId:, sizeId:, …)` is.
 */
function buildArguments(
  fieldName: string,
  args: ReadonlyArray<GraphQLArgument | GraphQLInputField>,
  kindsSeen: Set<SeedKind>,
  depth = 0,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const arg of args) {
    const named = namedType(arg.type);
    const kind = kindFor({ fieldName, argName: arg.name, typeName: named.name });
    if (kind) {
      kindsSeen.add(kind);
      const value = seedValue(kind);
      values[arg.name] = isListType(stripNonNull(arg.type)) && !Array.isArray(value) ? [value] : value;
      continue;
    }
    if (isInputObjectType(named) && depth < 3) {
      const nestedKinds = new Set<SeedKind>();
      const nested = buildArguments(fieldName, Object.values(named.getFields()), nestedKinds, depth + 1);
      // An OPTIONAL input object is sent only when it carries something this
      // sweep actually seeded. Sending it filled with type defaults turns a
      // filter nobody asked for into a query the resolver rejects —
      // `ClimbSearchInput.zoneBox` with four zeroes is "a non-empty box"
      // validation error rather than a search of the wall.
      if (isNonNullType(arg.type) || nestedKinds.size > 0) {
        values[arg.name] = nested;
        for (const nestedKind of nestedKinds) kindsSeen.add(nestedKind);
      }
      continue;
    }
    if (isNonNullType(arg.type)) values[arg.name] = fallbackValue(arg.name, arg.type);
  }
  return values;
}

function stripNonNull(type: GraphQLType): GraphQLType {
  return isNonNullType(type) ? type.ofType : type;
}

// ---------------------------------------------------------------------------
// Selection sets: every scalar leaf reachable within depth 2
// ---------------------------------------------------------------------------

/**
 * A generic selection set for a field's return type, generated from the schema.
 *
 * Depth 2 means: the returned type's own leaves, plus the leaves of the objects
 * it points at. Deeper than that the shape stops being a climb reader and starts
 * being a graph walk. Fields that need arguments of their own are skipped — a
 * field resolver with a required argument is a different reader, and it gets its
 * own sweep row if it is a root field.
 */
function selectionSetFor(type: GraphQLNamedType, depth: number, visiting: Set<string>): string | null {
  if (isLeafType(type)) return null;
  if (depth <= 0 || visiting.has(type.name)) return ' { __typename }';

  const possible = isObjectType(type) ? [type] : schemaPossibleTypes(type);
  if (possible.length === 0) return ' { __typename }';

  const nextVisiting = new Set(visiting).add(type.name);
  const parts: string[] = ['__typename'];

  for (const objectType of possible) {
    const body = objectBody(objectType, depth, nextVisiting);
    if (possible.length === 1 && isObjectType(type)) {
      parts.push(...body);
    } else if (body.length > 0) {
      parts.push(`... on ${objectType.name} { ${body.join(' ')} }`);
    }
  }
  return ` { ${parts.join(' ')} }`;
}

function objectBody(objectType: GraphQLObjectType, depth: number, visiting: Set<string>): string[] {
  const body: string[] = [];
  for (const field of Object.values(objectType.getFields()) as GraphQLField<unknown, unknown>[]) {
    if (field.args.some((arg) => isNonNullType(arg.type))) continue;
    const fieldNamed = namedType(field.type);
    if (isLeafType(fieldNamed)) {
      body.push(field.name);
      continue;
    }
    if (depth <= 1) continue;
    const nested = selectionSetFor(fieldNamed, depth - 1, visiting);
    if (nested) body.push(`${field.name}${nested}`);
  }
  return body;
}

function schemaPossibleTypes(type: GraphQLNamedType): GraphQLObjectType[] {
  try {
    return [...sweepSchema.getPossibleTypes(type as never)];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The recursive sentinel scan
// ---------------------------------------------------------------------------

/**
 * Every sentinel occurrence in an arbitrary GraphQL response.
 *
 * Deliberately untyped input: the whole point is that it does not know the shape
 * of what came back, so a leak through a field nobody thought about is still
 * caught. Strings are matched by substring (the frames string is embedded inside
 * longer payloads), numbers by equality.
 */
function findSentinels(value: unknown, scanFor: Sentinel[], path = '', found: string[] = []): string[] {
  if (value == null) return found;
  if (typeof value === 'string') {
    for (const sentinel of scanFor) {
      if (typeof sentinel.value === 'string' && value.includes(sentinel.value)) {
        found.push(`${sentinel.name} at ${path || '<root>'}`);
      } else if (typeof sentinel.value === 'number' && value === String(sentinel.value)) {
        found.push(`${sentinel.name} at ${path || '<root>'}`);
      }
    }
    return found;
  }
  if (typeof value === 'number') {
    for (const sentinel of scanFor) {
      if (sentinel.value === value) found.push(`${sentinel.name} at ${path || '<root>'}`);
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findSentinels(entry, scanFor, `${path}[${index}]`, found));
    return found;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      findSentinels(entry, scanFor, path ? `${path}.${key}` : key, found);
    }
  }
  return found;
}

/**
 * The sentinels worth scanning for on ONE call: every secret, plus the
 * identifiers this call did not hand the resolver itself. See the file docblock.
 */
function scannableSentinels(argumentValues: Record<string, unknown>): Sentinel[] {
  const echoed = new Set(findSentinels(argumentValues, sentinels).map((entry) => entry.split(' at ')[0]));
  return sentinels.filter((sentinel) => sentinel.kind === 'secret' || !echoed.has(sentinel.name));
}

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

/**
 * Fields that are swept but cannot show the owner a sentinel, each with the
 * reason. Adding a row is a claim that the field returns nothing that names a
 * climb — check it before you write one, because the NEGATIVE half of the sweep
 * still runs against every row here.
 */
const NOT_APPLICABLE: Record<string, string> = {
  // --- stats and grades: numbers keyed on a uuid the caller already holds -----
  'Query.angles': 'the static angle catalogue for a board type; the layout id is not read',
  'Query.climbStatsHistory': 'ascent/quality/grade numbers only, and the seed logs no history rows',
  'Query.climbStatsForAngles': 'counts and grades per angle, never a name or a frame',
  'Query.climbStatsForClimbs': 'counts and grades per uuid, echoing only the uuids the caller sent',
  'Query.boardseshGrade': 'the Boardsesh grade model writes no spray rows, so there is nothing to answer with',
  'Query.boardseshGradesForAngles': 'same: no spray rows in board_climb_grades',
  'Query.climbCommunityStatus': 'a hidden/classic flag and vote counts for the uuid the caller sent',
  'Query.bulkClimbCommunityStatus': 'same, one row per uuid the caller sent — including uuids that do not exist',
  'Query.climbClassicStatus': 'a classic flag for the uuid the caller sent',
  'Query.voteSummary': 'vote counts for an entity id the caller sent',
  'Query.setterStats': 'a setter name and a climb COUNT for the board config; no climb is named',
  'Query.syncClimbGrades': 'the offline grade pull; no spray rows exist in board_climb_grades to pull',

  // --- user-shaped reads: aggregates and follow graphs ------------------------
  'Query.favorites': 'answers which of the uuids the CALLER sent they have favourited; nothing else',
  'Query.userTickCountsByBoard': "one count per board type, and the count is the climber's own",
  'Query.userClimbPercentile': 'a percentile over one climber; no climb is named',
  'Query.userAscentCaptionMatches': "matches a caption against the climber's own ascents, and the sweep sends none",
  'Query.followers': 'the follow graph, users only',
  'Query.following': 'the follow graph, users only',
  'Query.isFollowing': 'one boolean about two users',
  'Query.publicProfile': 'profile fields; the climb lists are their own resolvers, swept separately',
  'Query.setterProfile': "a setter's name and totals; `setterClimbs` is the reader that names climbs",
  'Query.notificationActors': 'the users behind a notification',

  // --- playlist METADATA, as opposed to playlist CLIMBS -----------------------
  'Query.playlist': 'one playlist row — name, board type, counts. `playlistClimbs` is the reader that names climbs',
  'Query.userPlaylists': 'playlist rows, no climbs',
  'Query.allUserPlaylists': 'playlist rows, no climbs',
  'Query.myPinnedPlaylists': 'playlist rows, no climbs, and the seed pins none',
  'Query.discoverPlaylists': 'playlist rows, no climbs',
  'Query.playlistCreators': 'the users who made playlists on a board config',
  'Query.playlistsForClimb': 'playlist ids for the climb uuid the caller sent',
  'Query.playlistsForClimbs': 'playlist ids per uuid the caller sent',
  'Query.smartPlaylist':
    'the seeded tick is a send with no quality rating, so no smart list selects it; the visibility of its refs is pinned by spray-wall-api.test.ts',

  // --- materialised feeds: a private wall is never fanned out -----------------
  // `saveClimb` and `saveTick` announce only for a PUBLIC wall, so `feed_items`
  // has nothing for a private one to leak. The retraction path — a wall that
  // goes private or is deleted AFTER the fan-out — is what matters here, and
  // spray-wall-api.test.ts drives it directly.
  'Query.activityFeed': 'reads materialised feed_items, which a private wall never writes',
  'Query.trendingFeed': 'reads materialised feed_items, which a private wall never writes',
  'Query.sessionGroupedFeed': 'reads materialised feed_items, which a private wall never writes',
  'Query.followingClimbAscents': 'ascents by people the viewer follows, and the sweep seeds no follows',

  // --- session readers --------------------------------------------------------
  'Query.session': 'live room state held in Redis, not a climb read; membership-gated',
  'Query.eventsReplay': 'the event buffer requires Redis, which the sweep does not run',
  'Query.sessionStatus': 'one enum: whether the session is active',
  'Query.sessionSummary':
    'session totals; the hardest-send NAME comes through fetchHardestSendsBatch, which renders an invisible wall as "Unknown Climb" by design (JOIN ON, not WHERE)',

  // --- board presence: Redis queue state, not board_climbs --------------------
  'Query.boardRecentClimbs': 'presence history is driven by live queue events, and the sweep publishes none',
  'Query.boardHistory': 'same: live queue events only',
  'Query.boardClimbRecentSenders': 'same: live queue events only',
  'Query.boardPresenceStats': 'counts over presence events, which the sweep publishes none of',
  'Query.boardConnection': 'who holds the board connection right now; Redis state',
  'Query.boardQueuePreview': 'the live queue preview; Redis state',
  'Query.boardLeaderboard': 'senders and counts for the board uuid the caller sent; no climb is named',

  // --- gym surfaces -----------------------------------------------------------
  'Query.gym': 'the gym row. A gym is public by design; the wall it holds is reached through gymBoards, which IS swept',
  'Query.gymBySlug': 'the same gym row by slug',
  'Query.gymMembers': 'the gym roster',
  'Query.strayBoardsForGym': 'boards NEAR a gym and not linked to it; the seeded wall is linked',
  'Query.gymStats':
    'gym-edit-gated aggregates; the one query that returns a climb NAME carries the predicate (see #5462)',
  'Query.gymKiosk': 'kiosk configuration, and the seed creates none',
  'Query.gymKiosks': 'kiosk configuration, and the seed creates none',
  'Query.holdOutlines': 'community-admin only, and it reads the hold catalogue rather than climbs',

  // --- beta links -------------------------------------------------------------
  // The seeded link is not an Instagram or TikTok URL, because those enrich
  // through a live outbound fetch that CI cannot answer; the unknown-platform
  // path serves only an already-cached thumbnail, so the row is dropped before
  // it is returned. The gates themselves are pinned by spray-wall-api.test.ts.
  'Query.betaLinks': 'the seeded link has no cached thumbnail, so enrichment drops it before the resolver returns',
  'Query.recentBetaLinks': 'same — and the home slider reads only enriched rows',
  'Query.userBetaLinks': 'same',

  // --- subscriptions the sweep cannot separate --------------------------------
  // A subscription is "exercised" when the owner's stream stays open and both
  // other viewers' close. These four do not gate at subscribe time at all — they
  // gate on the payload, or on state the sweep does not create.
  'Subscription.sessionUpdates':
    'gated on session membership, which is checked as events arrive; the sweep publishes none',
  'Subscription.queueUpdates': 'same: a queue stream gated per event',
  'Subscription.commentUpdates': 'comment events for an entity id; gated at the write, and the sweep publishes none',
  'Subscription.boardQueuePreview': 'the queue preview stream; Redis state the sweep does not create',
  'Subscription.controllerEvents': 'controller events for a session; the sweep publishes none',
};

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

type SweepRow = {
  key: string;
  rootName: 'Query' | 'Subscription';
  fieldName: string;
  document: string;
  variables: Record<string, unknown>;
  kinds: SeedKind[];
};

let sweepSchema: GraphQLSchema;
let rows: SweepRow[] = [];

function enumerateRows(): SweepRow[] {
  const enumerated: SweepRow[] = [];
  for (const rootName of ['Query', 'Subscription'] as const) {
    const root = rootName === 'Query' ? sweepSchema.getQueryType() : sweepSchema.getSubscriptionType();
    if (!root) continue;
    for (const field of Object.values(root.getFields()) as GraphQLField<unknown, unknown>[]) {
      const kindsSeen = new Set<SeedKind>();
      const variables = buildArguments(field.name, field.args, kindsSeen);
      if (!isRelevant(kindsSeen)) continue;

      const argumentList = field.args
        .filter((arg) => arg.name in variables)
        .map((arg) => `${arg.name}: $${arg.name}`)
        .join(', ');
      const variableList = field.args
        .filter((arg) => arg.name in variables)
        .map((arg) => `$${arg.name}: ${String(arg.type)}`)
        .join(', ');
      const selection = selectionSetFor(namedType(field.type), 2, new Set());
      const operation = rootName === 'Query' ? 'query' : 'subscription';
      const document = `${operation} Sweep${variableList ? `(${variableList})` : ''} { ${field.name}${
        argumentList ? `(${argumentList})` : ''
      }${selection ?? ''} }`;

      enumerated.push({
        key: `${rootName}.${field.name}`,
        rootName,
        fieldName: field.name,
        document,
        variables,
        kinds: [...kindsSeen].sort(),
      });
    }
  }
  return enumerated;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Outcome = { data: unknown; errorMessages: string[]; subscribed: boolean };

/**
 * How long to wait for a subscription to close itself. A gate that refuses
 * returns from its generator before it ever reaches the pubsub, so this only has
 * to outlast a few awaits — it is not a race against a network.
 */
const SUBSCRIPTION_SETTLE_MS = 150;

async function runRow(row: SweepRow, ctx: ConnectionContext): Promise<Outcome> {
  const document = parse(row.document);
  const shared = { schema: sweepSchema, document, variableValues: row.variables, contextValue: ctx };
  try {
    if (row.rootName === 'Subscription') {
      const result = await subscribe(shared);
      if (Symbol.asyncIterator in result) {
        // Every spray subscription gate ENDS THE STREAM rather than throwing —
        // that is the "empty page" of a subscription, so an error would confirm
        // the wall exists. `subscribe()` therefore hands back an iterator either
        // way, and the only observable difference is whether the stream is still
        // open a moment later. Nothing is published during the sweep, so a stream
        // that stays open is one the gate let through.
        const iterator = result as AsyncIterableIterator<unknown>;
        const first = await Promise.race([
          iterator.next().then((step) => (step.done === true ? 'closed' : 'event')),
          new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), SUBSCRIPTION_SETTLE_MS)),
        ]);
        await iterator.return?.(undefined);
        return { data: null, errorMessages: [], subscribed: first !== 'closed' };
      }
      return {
        data: result.data ?? null,
        errorMessages: (result.errors ?? []).map((error) => error.message),
        subscribed: false,
      };
    }
    const result = await execute(shared);
    return {
      data: result.data ?? null,
      errorMessages: (result.errors ?? []).map((error) => error.message),
      subscribed: false,
    };
  } catch (error) {
    return { data: null, errorMessages: [error instanceof Error ? error.message : String(error)], subscribed: false };
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

async function seedWorld(): Promise<SeededWorld> {
  await db.execute(sql`
    TRUNCATE TABLE "spray_walls", "user_boards", "gym_members", "gyms",
                   "board_climbs", "board_climb_holds", "board_climb_stats",
                   "board_layouts", "board_product_sizes", "board_product_sizes_layouts_sets",
                   "board_holes", "board_placements", "board_difficulty_grades",
                   "boardsesh_ticks", "user_follows", "user_favorites", "playlists",
                   "playlist_climbs", "playlist_ownership", "climb_proposals", "proposal_votes",
                   "board_beta_links", "comments", "feed_items",
                   "board_climb_stats_history", "board_sessions"
    RESTART IDENTITY CASCADE
  `);
  // Standalone sequences: `TRUNCATE … RESTART IDENTITY` does not touch them, and
  // this sweep's whole sentinel strategy rests on the layout id and the hold ids
  // being values nothing else can be.
  await db.execute(sql`ALTER SEQUENCE spray_wall_catalog_id_seq RESTART WITH ${sql.raw(String(LAYOUT_ID_SEED))}`);
  await db.execute(sql`ALTER SEQUENCE spray_hold_catalog_id_seq RESTART WITH ${sql.raw(String(HOLD_ID_SEED))}`);

  await insertUser(OWNER);
  await insertUser(STRANGER);

  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
    VALUES ('spray', 10, '4a/V0', '5b/5.9', true),
           ('spray', 18, '6b/V4', '7a/5.11d', true)
    ON CONFLICT (board_type, difficulty) DO NOTHING
  `);

  const wall = (await sprayWallMutations.createSprayWall(
    {},
    { input: { name: WALL_NAME, angle: ANGLE } },
    ctxFor(OWNER),
  )) as { uuid: string; layoutId: number; sizeId: number };

  const photoId = uuidv4();
  storedPhotoMetadata.set(sprayWallPhotoKey(wall.uuid, photoId), { width: '1200', height: '900' });

  const version = (await sprayWallMutations.createSprayWallVersion(
    {},
    { input: { wallUuid: wall.uuid, photoId, anchors: ANCHORS } },
    ctxFor(OWNER),
  )) as { id: string };

  const holds = (await sprayWallMutations.upsertSprayWallHolds(
    {},
    {
      input: {
        wallUuid: wall.uuid,
        versionId: version.id,
        holds: [
          { cx: 100, cy: 120, r: 24 },
          { cx: 300, cy: 400, r: 30 },
          { cx: 520, cy: 560, r: 18 },
        ],
      },
    },
    ctxFor(OWNER),
  )) as Array<{ id: number }>;

  await sprayWallMutations.publishSprayWallVersion({}, { input: { versionId: version.id } }, ctxFor(OWNER));

  const holdIds = holds.map((hold) => hold.id);
  const frames = holdIds.map((holdId, index) => `p${holdId}r${[1, 2, 3][index] ?? 2}`).join('');

  const savedClimb = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: CLIMB_NAME,
        description: CLIMB_DESCRIPTION,
        isDraft: false,
        frames,
        angle: ANGLE,
        userGrade: '6b/V4',
      },
    },
    ctxFor(OWNER),
  )) as { uuid: string };

  // A SECOND climb on the same wall, sharing two holds, so `similarClimbs` — the
  // reader that takes a bare hold set and so needed the gate most — has
  // something to find.
  await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: `${CLIMB_NAME} II`,
        isDraft: false,
        frames: holdIds
          .slice(0, 2)
          .map((holdId, index) => `p${holdId}r${[1, 3][index]}`)
          .join(''),
        angle: ANGLE,
        userGrade: '4a/V0',
      },
    },
    ctxFor(OWNER),
  );

  const [boardRow] = (await db.execute(sql`
    SELECT id, slug, set_ids, serial_number FROM user_boards WHERE uuid = ${wall.uuid}
  `)) as unknown as Array<{ id: number; slug: string | null; set_ids: string; serial_number: string | null }>;
  const boardId = Number(boardRow?.id);

  const [userRow] = (await db.execute(sql`SELECT name FROM users WHERE id = ${OWNER}`)) as unknown as Array<{
    name: string;
  }>;

  // ---- everything that REFERENCES the climb ------------------------------
  //
  // Each of these is a persisted reference that survives the wall going
  // private: PR #5462's whole second half. They are seeded with raw SQL rather
  // than through the mutations because the mutations reach outward (the beta
  // link fetches Instagram metadata) or refuse a spray board on purpose, and
  // what the sweep is testing is the READ side.

  const gymUuid = uuidv4();
  const [gymRow] = (await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${gymUuid}, 'Sweep Gym', 'sweep-gym', ${OWNER}, true, now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: number }>;
  await db.execute(sql`UPDATE user_boards SET gym_id = ${Number(gymRow.id)} WHERE id = ${boardId}`);

  const sessionId = uuidv4();
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, created_by_user_id, name, board_id, status, started_at, created_at, last_activity)
    VALUES (${sessionId}, ${`spray/${wall.layoutId}/${wall.sizeId}/1/${ANGLE}`}, ${OWNER}, 'Sweep session',
            ${boardId}, 'active', now() - interval '1 hour', now(), now())
  `);
  await db.execute(sql`
    INSERT INTO board_session_participants (session_id, user_id, joined_at) VALUES (${sessionId}, ${OWNER}, now())
  `);

  const tickUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, difficulty, quality,
                                 attempt_count, is_mirror, is_benchmark, session_id, board_id,
                                 comment, climbed_at, created_at, updated_at)
    VALUES (${tickUuid}, ${OWNER}, ${savedClimb.uuid}, 'spray', ${ANGLE}, 'send', 18, 3,
            1, false, false, ${sessionId}, ${boardId}, ${TICK_COMMENT}, now(), now(), now())
  `);

  await db.execute(sql`
    INSERT INTO user_favorites (user_id, climb_uuid, board_name, created_at)
    VALUES (${OWNER}, ${savedClimb.uuid}, 'spray', now())
  `);

  // PUBLIC playlist, private climb: the case the wall's visibility must survive.
  // A public playlist must not become a way to substitute its own visibility for
  // the wall's.
  const playlistUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO playlists (uuid, name, board_type, is_public, created_at, updated_at)
    VALUES (${playlistUuid}, 'Sweep playlist', 'spray', true, now(), now())
  `);
  const [playlistRow] = (await db.execute(
    sql`SELECT id FROM playlists WHERE uuid = ${playlistUuid}`,
  )) as unknown as Array<{ id: string }>;
  await db.execute(sql`
    INSERT INTO playlist_ownership (playlist_id, user_id, role, created_at)
    VALUES (${playlistRow.id}, ${OWNER}, 'owner', now())
  `);
  await db.execute(sql`
    INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position, added_at, updated_at)
    VALUES (${playlistRow.id}, ${savedClimb.uuid}, ${ANGLE}, 1, now(), now())
  `);

  await db.execute(sql`
    INSERT INTO climb_proposals (uuid, climb_uuid, board_type, angle, proposer_id, type, proposed_value, current_value, reason, status, created_at)
    VALUES (${uuidv4()}, ${savedClimb.uuid}, 'spray', ${ANGLE}, ${OWNER}, 'grade', '20', '18', ${PROPOSAL_REASON}, 'open', now())
  `);

  await db.execute(sql`
    INSERT INTO board_beta_links (board_type, climb_uuid, link, foreign_username, angle, is_listed, created_by_user_id, tick_uuid)
    VALUES ('spray', ${savedClimb.uuid}, ${BETA_LINK}, 'someone', ${ANGLE}, true, ${OWNER}, ${tickUuid})
  `);

  await db.execute(sql`
    INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
    VALUES (${uuidv4()}, 'climb', ${savedClimb.uuid}, ${OWNER}, ${COMMENT_BODY}, now(), now())
  `);

  return {
    climbUuid: savedClimb.uuid,
    frames,
    holdIds,
    wallUuid: wall.uuid,
    wallSlug: boardRow?.slug ?? null,
    boardId,
    layoutId: wall.layoutId,
    sizeId: wall.sizeId,
    setIds: String(boardRow?.set_ids ?? '1'),
    photoId,
    gymUuid,
    gymSlug: 'sweep-gym',
    playlistId: playlistUuid,
    sessionId,
    serialNumber: boardRow?.serial_number ?? null,
    username: String(userRow?.name ?? OWNER),
  };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const outcomes = new Map<string, Record<ViewerName, Outcome>>();

/**
 * Whether this field actually reached the private wall for its OWNER — the half
 * that keeps the negative half honest.
 *
 * A **query** is exercised when a sentinel comes back. A **subscription** cannot
 * be: `subscribe()` hands back an async iterator that stays silent until a live
 * event, and this sweep publishes none. What IS observable at subscribe time is
 * the gate itself, which is where every spray subscription gate lives — so a
 * subscription is exercised when the owner gets an iterator and neither the
 * stranger nor the anonymous caller does.
 */
function isExercised(row: SweepRow): boolean {
  const perViewer = outcomes.get(row.key)!;
  if (row.rootName === 'Subscription') {
    return perViewer.owner.subscribed && !perViewer.stranger.subscribed && !perViewer.anonymous.subscribed;
  }
  return findSentinels(perViewer.owner.data, scannableSentinels(row.variables)).length > 0;
}
let seedTimeCounts: unknown = null;

/**
 * Seed, retrying a couple of times.
 *
 * The worker database is keyed on `VITEST_POOL_ID`, so two test RUNS on one
 * machine — a developer's suite alongside an agent's single file — share
 * `boardsesh_backend_test_w1`, and a neighbouring file's `TRUNCATE … CASCADE`
 * lands in the middle of this seed. That is a dev-box artefact: CI runs the
 * suite alone. Retrying is cheaper than a flake, and the message says which it
 * was when it runs out of attempts.
 */
async function seedWorldWithRetries(attempts = 3): Promise<SeededWorld> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await seedWorld();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Could not seed the private wall in ${attempts} attempts. If the cause is a missing user or board that this ` +
      `file had just written, another test run is sharing this worker database — rerun when it is idle. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

beforeAll(async () => {
  sweepSchema = schema;
  world = await seedWorldWithRetries();
  sentinels = [
    { name: 'climb name', value: CLIMB_NAME, kind: 'secret' },
    { name: 'climb description', value: CLIMB_DESCRIPTION, kind: 'secret' },
    { name: 'wall name', value: WALL_NAME, kind: 'secret' },
    { name: 'comment body', value: COMMENT_BODY, kind: 'secret' },
    { name: 'proposal reason', value: PROPOSAL_REASON, kind: 'secret' },
    { name: 'tick comment', value: TICK_COMMENT, kind: 'secret' },
    { name: 'beta link', value: BETA_LINK, kind: 'secret' },
    { name: 'photo id', value: world.photoId, kind: 'secret' },
    { name: 'climb frames', value: world.frames, kind: 'secret' },
    ...world.holdIds.map((holdId) => ({ name: `hold id ${holdId}`, value: holdId, kind: 'secret' as const })),
    { name: 'climb uuid', value: world.climbUuid, kind: 'identifier' },
    { name: 'wall uuid', value: world.wallUuid, kind: 'identifier' },
    { name: 'layout id', value: world.layoutId, kind: 'identifier' },
  ];
  rows = enumerateRows();
  seedTimeCounts = JSON.parse(
    JSON.stringify(
      await db.execute(
        sql`SELECT (SELECT count(*) FROM board_climbs) AS climbs, (SELECT count(*) FROM user_boards) AS boards, current_database() AS dbname, pg_backend_pid() AS pid`,
      ),
    ),
  );

  for (const row of rows) {
    const perViewer = {} as Record<ViewerName, Outcome>;
    for (const viewer of VIEWERS) {
      perViewer[viewer.name] = await runRow(row, viewer.ctx);
    }
    outcomes.set(row.key, perViewer);
  }
}, 600_000);

afterAll(() => {
  vi.clearAllMocks();
});

describe('the spray-wall visibility sweep', () => {
  it('enumerates the climb readers from the schema', () => {
    expect(rows.length).toBeGreaterThan(30);
  });

  it('DEBUG probe', async () => {
    const counts = await db.execute(
      sql`SELECT (SELECT count(*) FROM board_climbs) AS climbs, (SELECT count(*) FROM spray_walls) AS walls, (SELECT count(*) FROM user_boards) AS boards, (SELECT count(*) FROM users) AS users, current_database() AS dbname, pg_backend_pid() AS pid`,
    );
    const direct = await sprayWallQueriesProbe.sprayWall({}, { uuid: world.wallUuid }, ctxFor(OWNER));
    const viaGraphql = await runRow(
      rows.find((r) => r.key === 'Query.sprayWall')!,
      ctxFor(OWNER),
    );
    requireFromHere('node:fs').writeFileSync(
      '/home/developer/.cache/claude-tmp/sweep-probe.json',
      JSON.stringify(
        { seedTimeCounts, counts: JSON.parse(JSON.stringify(counts)), world, direct, viaGraphql },
        null,
        2,
      ),
    );
    expect(1).toBe(1);
  });

  it('DEBUG dump', () => {
    const report = rows.map((row) => {
      const perViewer = outcomes.get(row.key)!;
      const scanFor = scannableSentinels(row.variables);
      return {
        key: row.key,
        kinds: row.kinds,
        vars: row.variables,
        ownerFound: findSentinels(perViewer.owner.data, scanFor),
        ownerErrors: perViewer.owner.errorMessages.slice(0, 3),
        ownerData: JSON.stringify(perViewer.owner.data)?.slice(0, 600),
        ownerSubscribed: perViewer.owner.subscribed,
        strangerSubscribed: perViewer.stranger.subscribed,
        anonSubscribed: perViewer.anonymous.subscribed,
        strangerFound: findSentinels(perViewer.stranger.data, scanFor),
        anonFound: findSentinels(perViewer.anonymous.data, scanFor),
        doc: row.document.slice(0, 200),
      };
    });
    requireFromHere('node:fs').writeFileSync(
      '/home/developer/.cache/claude-tmp/sweep-report.json',
      JSON.stringify(report, null, 2),
    );
    expect(report.length).toBeGreaterThan(0);
  });

  it('covers every enumerated field — exercised, or allow-listed with a reason', () => {
    const unexplained: string[] = [];
    for (const row of rows) {
      const explained = row.key in NOT_APPLICABLE;
      if (isExercised(row)) {
        if (explained) {
          unexplained.push(
            `${row.key} is in NOT_APPLICABLE ("${NOT_APPLICABLE[row.key]}") but the owner DID see the private ` +
              `wall through it. The reason is stale — delete the row.`,
          );
        }
        continue;
      }
      if (!explained) {
        unexplained.push(
          `${row.key} is swept (its arguments name ${row.kinds.join(', ')}) but the OWNER saw nothing of the ` +
            `private wall through it, so the negative half proves nothing. Either seed what it reads in ` +
            `seedWorld(), or add a NOT_APPLICABLE['${row.key}'] entry saying why it can never name a climb.`,
        );
      }
    }
    expect(unexplained).toEqual([]);
  });

  it('keeps no stale allow-list rows', () => {
    const swept = new Set(rows.map((row) => row.key));
    expect(Object.keys(NOT_APPLICABLE).filter((key) => !swept.has(key))).toEqual([]);
  });

  it('never hands a sentinel to an anonymous caller or a stranger', () => {
    const leaks: string[] = [];
    for (const row of rows) {
      const scanFor = scannableSentinels(row.variables);
      for (const viewer of ['anonymous', 'stranger'] as const) {
        const outcome = outcomes.get(row.key)![viewer];
        const inData = findSentinels(outcome.data, scanFor);
        const inErrors = findSentinels(
          outcome.errorMessages,
          scanFor.filter((sentinel) => sentinel.kind === 'secret'),
        );
        for (const hit of [...inData, ...inErrors]) leaks.push(`${row.key} → ${viewer}: ${hit}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
