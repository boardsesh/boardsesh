import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { boardClimbEvents, sprayWallVersions, sprayWalls, userBoards } from '@boardsesh/db/schema';
import { ART_RECIPE } from '@boardsesh/spray-wall-geometry';
import * as dbSchema from '@boardsesh/db/schema';
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
import type { ConnectionContext, SocialEntityType } from '@boardsesh/shared-schema';

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
const { pubsub } = await import('../pubsub');
const { schema } = await import('../graphql/index');
const { sprayWallMutations } = await import('../graphql/resolvers/board/spray-walls');
const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
const { sprayWallPhotoKey } = await import('../handlers/spray-wall-photos');
const { fanoutCommentFeedItems } = await import('../events/feed-fanout');
const { generateSessionSummary } = await import('../graphql/resolvers/sessions/session-summary');

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
const HIDE_REASON = 'Zqx Sentinel Hide Reason Zqx';
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
/**
 * Somebody both the owner and the stranger follow, who logged the private
 * wall's climb. Not a viewer: it exists so the follow-scoped readers have a row
 * to return, which is what makes their owner half mean something.
 */
const FRIEND = 'sweep-friend';
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
  hideProposalUuid: string;
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
 * wall.
 *
 * A bare `layoutId` counts ON ITS OWN, with no board type beside it. That is the
 * whole point of the epic's enumeration worry — `spray_wall_catalog_id_seq` hands
 * out 1, 2, 3, … — and requiring the PAIR left `sprayWallByLayout(layoutId: Int!)`
 * out of both the sweep and the allow-list, which is precisely the reader
 * `docs/spray-walls.md` splits its two visibility rules over. `serialNumbers` is
 * here for the same reason: it names a board without naming a board type.
 *
 * `grades(boardName:)` still is not swept — a board type alone scopes nothing to a
 * wall — and that is the only thing the old pairing rule was buying.
 */
function isRelevant(kinds: Set<SeedKind>): boolean {
  return (
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
    kinds.has('username') ||
    kinds.has('layoutId') ||
    kinds.has('serialNumbers')
  );
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
 * reason. Adding a row is a claim about this field — check it before you write
 * one, because the NEGATIVE half of the sweep still runs against every row here.
 *
 * Two different claims live in this one list, and the reason text says which.
 * Most rows are genuinely inapplicable: the field answers with counts, ids the
 * caller already sent, or rows that are not climbs. But some are **seed gaps** —
 * `recentBetaLinks`, `gymKiosk(s)`, the board-presence rows and `eventsReplay`
 * all read state this sweep does not create (an enriched beta link, a kiosk, a
 * live queue event, Redis). Their negative half still runs and still has to pass;
 * what is unproven is the owner half, so seeding what they read is an
 * improvement, not a rule change.
 */
const NOT_APPLICABLE: Record<string, string> = {
  // --- readers scoped to another board type entirely ---------------------------
  'Query.checkMoonBoardClimbDuplicates':
    "hardcoded to board_type = 'moonboard', so a spray climb is not a row it can return",

  // --- similar climbs: never materialised for a wall --------------------------
  'Query.similarClimbs':
    'a non-admin (the sweep owner included) reads board_climb_neighbors, which the nightly job never computes for spray layouts, so a wall answers []; only an admin reaches the live query, and it keeps the sprayLayoutIsReadable gate (docs/similar-climbs.md)',
  // --- hold heatmap: admin-only live aggregate --------------------------------
  'Query.holdHeatmap':
    'an admin-only live aggregate behind requireAdmin, so the sweep owner (not an admin) is refused; a non-admin gets the heatmap from the wall mirrored on the phone, and an admin still passes the sprayLayoutIsReadableWithCapability gate',

  // --- stats and grades: numbers keyed on a uuid the caller already holds -----
  'Query.angles': 'the static angle catalogue for a board type; the layout id is not read',
  'Query.climbStatsHistory': 'ascent/quality/grade numbers per angle, never a name or a frame',
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
  'Query.climbRevisions': 'retired with climb revision history: it always answers [] and reads no row',

  // --- user-shaped reads: aggregates and follow graphs ------------------------
  'Query.favorites': 'answers which of the uuids the CALLER sent they have favourited; nothing else',
  'Query.userTickCountsByBoard': "one count per board type, and the count is the climber's own",
  'Query.userClimbPercentile': 'a percentile over one climber; no climb is named',
  'Query.userAscentCaptionMatches': "matches a caption against the climber's own ascents, and the sweep sends none",
  'Query.followers': 'the follow graph, users only',
  'Query.following': 'the follow graph, users only',
  'Query.isFollowing': 'one boolean about two users',
  'Query.privacyRelationship': 'follow-request and account-privacy flags for a supplied user id; no climb metadata',
  'Query.contentAudience': 'audience and edit-permission flags for a supplied entity id; no climb metadata',
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
  'Query.activityFeed':
    'reads materialised feed_items, and the sweep fans nothing out to the owner (an actor is never a recipient of their own event). A comment on a proposal used to fan out for a private wall and for drafts; since #6032 the write skips both, and the read gates carry the pre-fix rows: spray-wall-api.test.ts for a wall that went private, and the hard-deleted block at the end of this file, which seeds a pre-fix row by hand',

  // --- session readers --------------------------------------------------------
  'Query.session': 'live room state held in Redis, not a climb read; membership-gated',
  'Query.eventsReplay': 'the event buffer requires Redis, which the sweep does not run',
  'Query.sessionStatus': 'one enum: whether the session is active',
  'Query.followedLiveSessions':
    'lists only LIVE sessions (a live connection, or a Redis session key), and the sweep opens neither; the spray gates (followed/selected wall, board name, current climb) are pinned by the spray-wall block in live-sessions.test.ts',
  'Query.boardLiveSessions':
    'same: lists only live sessions, and the sweep opens no connection; the board gate mirrors boardHistory (assertSprayBoardIsReadable)',

  // --- board presence: Redis queue state, not board_climbs --------------------
  'Query.boardClimbRecentSenders': 'same: live queue events only',
  'Query.boardConnection': 'who holds the board connection right now; Redis state',
  'Query.boardQueuePreview': 'the live queue preview; Redis state',
  'Query.boardLeaderboard': 'senders and counts for the board uuid the caller sent; no climb is named',
  'Query.boardDiscovery':
    'anonymous marketing discovery never includes private walls, even for their owner; the explicit public/private/unlisted/hidden transition test below proves its positive and negative paths',

  // --- serial-number lookups --------------------------------------------------
  // A spray wall is LED-less by construction (`has_leds` is forced false and is
  // not in the input schema at all), so it never gets a serial number and there
  // is nothing for these to look one up by.
  'Query.boardsBySerialNumbers': 'a spray wall has no serial number, so it can never be a row in this answer',
  'Query.myBoardSerialConfigs': 'same: there is no serial to configure',

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

  // --- moderation queue -------------------------------------------------------
  // Two independent reasons, either of which would be enough on its own.
  // `requireAdmin(ctx, 'spray')` is the first statement in the resolver, so the
  // sweep's OWNER — who is not an admin — is rejected before a single row is
  // read. That is what makes the owner half vacuous here rather than meaningful:
  // it sees nothing because nobody but an admin ever does, not because a gate
  // held. And the rows are report records — id, wall uuid, layout id, reason,
  // hidden, createdAt — so there is no climb name or frame in the answer to
  // leak. The admin path is deliberately all-seeing and is pinned instead by
  // spray-wall-moderation.test.ts, which asserts the non-admin rejection.
  'Query.sprayWallReports':
    'admin-only — requireAdmin runs before any read, so the non-admin owner is rejected — and it answers with report rows (wall uuid, layout id, reason), never a climb name or frames',

  // --- beta links -------------------------------------------------------------
  // The seeded link is not an Instagram or TikTok URL, because those enrich
  // through a live outbound fetch that CI cannot answer; the unknown-platform
  // path serves only an already-cached thumbnail, so the row is dropped before
  // it is returned. The gates themselves are pinned by spray-wall-api.test.ts.
  'Query.recentBetaLinks': 'same — and the home slider reads only enriched rows',
  'Query.userBetaLinks': 'same',

  // --- subscriptions the sweep cannot separate --------------------------------
  // A subscription is "exercised" when the owner's stream stays open and both
  // other viewers' close. Controller events depend on state the sweep does not
  // create; session, queue and comment subscriptions are swept at subscribe time.
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

/**
 * How deep the generated selection goes. Two levels reaches the rows of every
 * list reader, which is where a climb is named.
 *
 * The session readers nest further, and a sweep that does not ask for a field
 * cannot see it leak. `sessionGroupedFeed` puts a tick at
 * `sessions.hardestSend` and a beta link at `sessions.featuredBeta.betaLink`;
 * `sessionDetail` puts beta links at `ticks.betaLinks`. At depth 2 neither was
 * requested, the owner saw nothing through `sessionGroupedFeed`, and the field
 * sat on the allow-list while it returned a private wall's log to anybody
 * (#6031). A new reader that nests a tick or a beta link deeper than two levels
 * gets a row here.
 */
const DEFAULT_SELECTION_DEPTH = 2;
const SELECTION_DEPTH: Record<string, number> = {
  'Query.sessionGroupedFeed': 4,
  'Query.sessionDetail': 3,
};

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
      const selection = selectionSetFor(
        namedType(field.type),
        SELECTION_DEPTH[`${rootName}.${field.name}`] ?? DEFAULT_SELECTION_DEPTH,
        new Set(),
      );
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
const SESSION_SUBSCRIPTION_TIMEOUT_MS = 8_000;

/**
 * Per-field deadline on the query path.
 *
 * Without it one wedged resolver — a lock wait, a single-flight that never
 * resolves — eats the whole `beforeAll` and the sweep reports a 600 s hook
 * timeout naming nothing. With it the row fails, carrying its own field name, and
 * the coverage test says which reader stopped answering. Generous on purpose: the
 * slowest honest row here is two orders of magnitude under it.
 */
const QUERY_TIMEOUT_MS = 30_000;

/** Reject with `label` if `work` has not settled before its deadline. */
async function withQueryDeadline<T>(work: Promise<T>, label: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
        const firstRead = iterator.next().then((step) => (step.done === true ? 'closed' : 'event'));
        // These streams emit an initial snapshot after membership authorization.
        // A caller without membership first waits through the join retry window
        // (~6.35s), so the quiet-stream probe would mistake that wait for access.
        const emitsInitialSnapshot = row.fieldName === 'sessionUpdates' || row.fieldName === 'queueUpdates';
        const first = emitsInitialSnapshot
          ? await withQueryDeadline(firstRead, row.key, SESSION_SUBSCRIPTION_TIMEOUT_MS)
          : await Promise.race([
              firstRead,
              new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), SUBSCRIPTION_SETTLE_MS)),
            ]);
        // NOT awaited. A resolver that gates by ending its stream is an async
        // GENERATOR, and by now it is suspended inside its own `for await` on a
        // pubsub push that this sweep never sends. `return()` on a generator in
        // that state queues behind the pending `next()` and settles never — an
        // `await` here hangs the whole sweep, which is how it was found.
        void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
        return { data: null, errorMessages: [], subscribed: first !== 'closed' };
      }
      return {
        data: result.data ?? null,
        errorMessages: (result.errors ?? []).map((error) => error.message),
        subscribed: false,
      };
    }
    const result = await withQueryDeadline(Promise.resolve(execute(shared)), row.key);
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
  await insertUser(FRIEND);

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

  // Generated wall looks, READY, so `sprayWallArt` has something to hand the
  // owner. The keys carry the photo-id sentinel, as the presigned URLs do.
  const artStem = `spray-walls/${wall.uuid}/art/${photoId}-r${ART_RECIPE}`;
  await db
    .update(sprayWallVersions)
    .set({
      art: {
        recipe: ART_RECIPE,
        status: 'ready',
        width: 800,
        height: 620,
        cropKey: `${artStem}-crop.jpg`,
        cutoutKey: `${artStem}-cutout.webp`,
        quality: { stretch: 1, verdict: 'good' },
        error: null,
        requestedAt: new Date().toISOString(),
      },
    })
    .where(eq(sprayWallVersions.id, Number(version.id)));

  const holdIds = holds.map((hold) => hold.id);
  const frames = holdIds.map((holdId, index) => `p${holdId}r${[1, 2, 3][index] ?? 2}`).join('');

  const savedClimb = (await climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'spray',
        layoutId: wall.layoutId,
        name: CLIMB_NAME,
        // Not the sentinel yet: the edit below puts it there.
        description: 'Before the edit',
        isDraft: false,
        frames,
        angle: ANGLE,
        userGrade: '6b/V4',
      },
    },
    ctxFor(OWNER),
  )) as { uuid: string };

  // ONE edit, in place, inside the setter's 24 hours. It is what writes the
  // sentinel description, so every reader finds the climb by name, description
  // and frames.
  await climbMutations.updateClimb(
    {},
    { input: { uuid: savedClimb.uuid, boardType: 'spray', description: CLIMB_DESCRIPTION } },
    ctxFor(OWNER),
  );

  // A SECOND climb on the same wall, sharing two holds, so a hold-overlap read
  // has something to find. (`similarClimbs` itself answers a non-admin from
  // the materialised index, which skips spray — see NOT_APPLICABLE.)
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
  // Exercise native and merged recent history plus both durable APIs. The
  // owner must see real content so empty responses cannot hide missing gates.
  const displayedAt = new Date().toISOString();
  await db.insert(boardClimbEvents).values({
    boardId,
    boardType: 'spray',
    climbUuid: savedClimb.uuid,
    angle: ANGLE,
    seq: 1,
    confirmedAt: displayedAt,
    name: CLIMB_NAME,
    frames,
    userId: OWNER,
  });
  vi.spyOn(pubsub, 'getRecentBoardClimbs').mockImplementation(async (queriedBoardId) =>
    queriedBoardId === String(boardId)
      ? [
          {
            climbUuid: savedClimb.uuid,
            angle: ANGLE,
            seq: 1,
            sentAt: displayedAt,
            name: CLIMB_NAME,
            frames,
            sentByUserId: OWNER,
          },
        ]
      : [],
  );

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

  // The follow-scoped reader (`followingClimbAscents`) answers with logs by
  // people the VIEWER follows, so the wall needs a log by somebody followed. The
  // owner follows the friend and must see it. The stranger follows the friend
  // AND the owner, which is the case the gate exists for: following a climber
  // must not become a way to read what they logged on a wall you cannot see.
  // No session and no board on this tick, so the session readers are untouched.
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, difficulty, quality,
                                 attempt_count, is_mirror, is_benchmark, session_id, board_id,
                                 comment, climbed_at, created_at, updated_at)
    VALUES (${uuidv4()}, ${FRIEND}, ${savedClimb.uuid}, 'spray', ${ANGLE}, 'send', 18, 3,
            1, false, false, NULL, NULL, ${TICK_COMMENT}, now(), now(), now())
  `);
  await db.execute(sql`
    INSERT INTO user_follows (follower_id, following_id, created_at)
    VALUES (${OWNER}, ${FRIEND}, now()),
           (${STRANGER}, ${FRIEND}, now()),
           (${STRANGER}, ${OWNER}, now())
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

  // A HIDE proposal, which is the shape that persists its reason as a COMMENT on
  // itself — see `createProposal` in `social/proposals/mutations.ts`. That
  // comment is prose about the climb, hung off an entity that is not the climb,
  // and it is how a private wall reached `globalCommentFeed` before #5495's
  // review. Angle is NULL on a hide proposal, which is also why this is a second
  // row rather than a change to the one above: `climbProposals(angle: 40)` would
  // stop finding it.
  const hideProposalUuid = uuidv4();
  await db.execute(sql`
    INSERT INTO climb_proposals (uuid, climb_uuid, board_type, angle, proposer_id, type, proposed_value, current_value, reason, status, created_at)
    VALUES (${hideProposalUuid}, ${savedClimb.uuid}, 'spray', NULL, ${OWNER}, 'hide', 'true', 'false', ${HIDE_REASON}, 'open', now())
  `);
  await db.execute(sql`
    INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
    VALUES (${uuidv4()}, 'proposal', ${hideProposalUuid}, ${OWNER}, ${HIDE_REASON}, now(), now())
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
    hideProposalUuid,
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
    { name: 'hide-proposal reason', value: HIDE_REASON, kind: 'secret' },
    { name: 'hide-proposal uuid', value: world.hideProposalUuid, kind: 'identifier' },
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

    // Pinned BY NAME, because narrowing the detection rule is the one change
    // nothing else in this file notices: a field that stops being swept simply
    // vanishes from `rows`, and only the allow-listed ones leave a stale row
    // behind. `sprayWallByLayout` is the canonical case — a bare layout id, the
    // enumerable key `docs/spray-walls.md` splits its two visibility rules over —
    // and the others stand for the argument shapes beside it.
    const swept = rows.map((row) => row.key);
    for (const key of [
      'Query.sprayWallByLayout',
      'Query.climb',
      'Query.climbRevisions',
      'Query.searchClimbs',
      'Query.userTicks',
      'Query.boardDiscovery',
    ]) {
      expect(swept).toContain(key);
    }
  });

  it('discovers a published public gym wall but never private, unlisted, or moderated walls, even for owners', async () => {
    const row = rows.find((candidate) => candidate.key === 'Query.boardDiscovery');
    expect(row).toBeDefined();
    if (!row) throw new Error('boardDiscovery must participate in the visibility sweep');
    const [originalBoard] = await db
      .select({
        isPublic: userBoards.isPublic,
        isUnlisted: userBoards.isUnlisted,
        hideLocation: userBoards.hideLocation,
      })
      .from(userBoards)
      .where(eq(userBoards.id, world.boardId));
    const [originalWall] = await db
      .select({ hiddenAt: sprayWalls.hiddenAt })
      .from(sprayWalls)
      .where(eq(sprayWalls.boardUuid, world.wallUuid));
    expect(originalBoard).toBeDefined();
    expect(originalWall).toBeDefined();
    if (!originalBoard || !originalWall) throw new Error('The seeded discovery wall must exist');

    try {
      await db
        .update(userBoards)
        .set({ isPublic: true, isUnlisted: false, hideLocation: false })
        .where(eq(userBoards.id, world.boardId));
      for (const viewer of VIEWERS) {
        const outcome = await runRow(row, viewer.ctx);
        expect(outcome.errorMessages, viewer.name).toEqual([]);
        expect(findSentinels(outcome.data, scannableSentinels(row.variables)).join(' | '), viewer.name).toContain(
          'wall name',
        );
      }

      for (const restriction of ['private', 'unlisted', 'hidden'] as const) {
        await db
          .update(userBoards)
          .set({ isPublic: restriction !== 'private', isUnlisted: restriction === 'unlisted' })
          .where(eq(userBoards.id, world.boardId));
        await db
          .update(sprayWalls)
          .set({ hiddenAt: restriction === 'hidden' ? new Date() : null })
          .where(eq(sprayWalls.boardUuid, world.wallUuid));
        for (const viewer of VIEWERS) {
          const outcome = await runRow(row, viewer.ctx);
          expect(outcome.errorMessages, `${restriction}: ${viewer.name}`).toEqual([]);
          expect(outcome.data, `${restriction}: ${viewer.name}`).toEqual({ boardDiscovery: [] });
        }
      }
    } finally {
      await db.update(userBoards).set(originalBoard).where(eq(userBoards.id, world.boardId));
      await db.update(sprayWalls).set(originalWall).where(eq(sprayWalls.boardUuid, world.wallUuid));
    }
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

  /**
   * The one thread the generic sweep cannot reach.
   *
   * `comments(input)` is swept with `entityType: 'climb'`, because that is what
   * the seed table answers for an enum argument. A `hide` proposal's reason lives
   * on `entityType: 'proposal'` instead — prose about a climb, hung off an entity
   * that is not the climb — so it needs saying out loud.
   */
  it('hides a hide-proposal reason from a stranger and shows it to the owner', async () => {
    const row: SweepRow = {
      key: 'Query.comments(proposal)',
      rootName: 'Query',
      fieldName: 'comments',
      document:
        'query Sweep($input: CommentsInput!) { comments(input: $input) ' +
        '{ __typename totalCount comments { __typename uuid entityType entityId body } } }',
      variables: { input: { entityType: 'proposal', entityId: world.hideProposalUuid } },
      kinds: [],
    };
    const scanFor = scannableSentinels(row.variables);

    for (const viewer of VIEWERS) {
      const outcome = await runRow(row, viewer.ctx);
      const found = findSentinels(outcome.data, scanFor);
      if (viewer.name === 'owner') {
        expect(found.join(' | ')).toContain('hide-proposal reason');
      } else {
        expect({ viewer: viewer.name, found }).toEqual({ viewer: viewer.name, found: [] });
      }
    }
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

// ---------------------------------------------------------------------------
// Hard-deleted climbs (#5981)
// ---------------------------------------------------------------------------

/**
 * What the sweep above cannot reach: a reference whose climb row is GONE.
 *
 * Deleting a wall is a soft delete that keeps its climbs. `deleteDraftClimb` and
 * account deletion are not: they hard-delete the `board_climbs` row and leave
 * the ticks, proposals and comments that named it. With the climb gone there is
 * no layout id, so no wall to check, and the reference form of the wall rule
 * ("there is no INVISIBLE spray climb behind this reference") passes the row
 * for everybody.
 *
 * So this block seeds a draft on the private wall, hangs one of each reference
 * off it, deletes the draft through the real mutation, and asks each reader.
 * The owner's raw logbook and summaries retain their own records. Enriched
 * ascent feeds and session-detail ticks require a readable parent climb even
 * for the owner, so stale climb metadata cannot escape through those readers.
 */
const ORPHAN_TICK_COMMENT = 'Zqx Orphan Tick Comment Zqx';
const ORPHAN_SESSION_TICK_COMMENT = 'Zqx Orphan Session Tick Comment Zqx';
const DAILY_PRIVATE_TICK_COMMENT = 'Zqx Daily Private Tick Comment Zqx';
const DAILY_PRIVATE_BETA_LINK = 'https://beta.example/ZqxDailyPrivateBetaZqx';
const PUBLIC_KILTER_SEND_COMMENT = 'Zqx Public Kilter Send Comment Zqx';
const PUBLIC_KILTER_TICK_COMMENT = 'Zqx Public Kilter Tick Comment Zqx';
const GHOST_KILTER_TICK_COMMENT = 'Zqx Ghost Kilter Tick Comment Zqx';
const ORPHAN_COMMENT_BODY = 'Zqx Orphan Comment Body Zqx';
const ORPHAN_PROPOSAL_REASON = 'Zqx Orphan Proposal Reason Zqx';
const ORPHAN_HIDE_REASON = 'Zqx Orphan Hide Reason Zqx';
const MISSING_KILTER_COMMENT = 'Zqx Missing Kilter Climb Comment Zqx';
const ORPHAN_DRAFT_NAME = 'Zqx Orphan Draft Zqx';
/** A grade no other seeded tick uses, so the bucket it lands in is its own. */
const ORPHAN_DIFFICULTY = 23;

const ORPHAN_SECRETS = [ORPHAN_TICK_COMMENT, ORPHAN_COMMENT_BODY, ORPHAN_PROPOSAL_REASON, ORPHAN_HIDE_REASON];

type ProfileStatsAnswer = {
  totalDistinctClimbs: number;
  layoutStats: Array<{
    layoutKey: string;
    boardType: string;
    layoutId: number | null;
    distinctClimbCount: number;
    gradeCounts: Array<{ grade: string; count: number }>;
  }>;
};

describe('references to a hard-deleted spray climb', () => {
  let orphanClimbUuid: string;
  let orphanGradeProposalUuid: string;
  let orphanHideProposalUuid: string;
  const orphanHideCommentUuid = uuidv4();
  const orphanTickUuid = uuidv4();
  const orphanOnlySessionId = uuidv4();
  const publicSessionId = uuidv4();
  const publicClimbUuid = 'sweep-public-kilter-climb';
  const proposalTotalBefore = new Map<ViewerName, number>();
  const profileStatsBefore = new Map<ViewerName, ProfileStatsAnswer>();

  /** One query, run exactly as the sweep runs its rows. Errors fail the case. */
  async function ask(viewer: ViewerName, document: string, variables: Record<string, unknown>): Promise<unknown> {
    const { ctx } = VIEWERS.find((candidate) => candidate.name === viewer)!;
    const outcome = await runRow(
      { key: 'orphan case', rootName: 'Query', fieldName: 'orphan', document, variables, kinds: [] },
      ctx,
    );
    expect(outcome.errorMessages, viewer).toEqual([]);
    return outcome.data;
  }

  const secretsIn = (answer: unknown) => ORPHAN_SECRETS.filter((secret) => JSON.stringify(answer).includes(secret));

  const browseProposals = (viewer: ViewerName) =>
    ask(
      viewer,
      'query Orphan($input: BrowseProposalsInput!) { browseProposals(input: $input) ' +
        '{ totalCount proposals { uuid climbUuid reason } } }',
      { input: { boardType: 'spray', limit: 50 } },
    ) as Promise<{ browseProposals: { totalCount: number; proposals: Array<{ uuid: string; climbUuid: string }> } }>;

  const commentFeed = (viewer: ViewerName, boardUuid?: string) =>
    ask(
      viewer,
      'query Orphan($input: GlobalCommentFeedInput) { globalCommentFeed(input: $input) ' +
        '{ comments { uuid entityType entityId body } } }',
      { input: boardUuid ? { limit: 50, boardUuid } : { limit: 50 } },
    );

  const profileStats = async (viewer: ViewerName) => {
    const answer = (await ask(
      viewer,
      'query Orphan($userId: ID!) { userProfileStats(userId: $userId) { totalDistinctClimbs ' +
        'layoutStats { layoutKey boardType layoutId distinctClimbCount gradeCounts { grade count } } } }',
      { userId: OWNER },
    )) as { userProfileStats: ProfileStatsAnswer };
    return answer.userProfileStats;
  };

  /**
   * `setup.ts` truncates `board_sessions` before every test, so by the time
   * anything in this block runs the sweep's session rows are gone (their ticks
   * keep the session id). The session readers answer null or drop the session's
   * name without the row, which would make a pass over them prove nothing. Put
   * the rows back wherever a session reader is about to be asked.
   */
  async function reseedSessionRows(): Promise<void> {
    for (const [sessionId, name] of [
      [world.sessionId, 'Sweep session'],
      [orphanOnlySessionId, 'Orphan-only session'],
    ]) {
      await db.execute(sql`
        INSERT INTO board_sessions (id, board_path, created_by_user_id, name, board_id, status, started_at, created_at, last_activity)
        VALUES (${sessionId}, ${`spray/${world.layoutId}/${world.sizeId}/1/${ANGLE}`}, ${OWNER}, ${name},
                ${world.boardId}, 'active', now() - interval '1 hour', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);
      await db.execute(sql`
        INSERT INTO board_session_participants (session_id, user_id, joined_at) VALUES (${sessionId}, ${OWNER}, now())
        ON CONFLICT DO NOTHING
      `);
    }
    await db.execute(sql`
      INSERT INTO board_sessions (id, board_path, created_by_user_id, name, is_public, status, started_at, created_at, last_activity)
      VALUES (${publicSessionId}, ${`kilter/1/1/1/${ANGLE}`}, ${OWNER}, 'Public Kilter session',
              true, 'active', now() - interval '1 hour', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO board_session_participants (session_id, user_id, joined_at) VALUES (${publicSessionId}, ${OWNER}, now())
      ON CONFLICT DO NOTHING
    `);
  }

  beforeAll(async () => {
    // Readable parent climbs and public sessions are separate positive controls:
    // a missing catalogue row or a private session must never grant feed access.
    // Seed before the "before" answers so these sends do not move later counts.
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed)
      VALUES (${publicClimbUuid}, 'kilter', 1, 'Public Kilter climb', 'p1r12p2r13', false, true)
    `);
    await reseedSessionRows();
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, difficulty,
                                   attempt_count, is_mirror, is_benchmark, session_id, comment, climbed_at, created_at, updated_at)
      VALUES (${uuidv4()}, ${OWNER}, ${publicClimbUuid}, 'kilter', ${ANGLE}, 'send', 10,
              1, false, false, ${publicSessionId}, ${PUBLIC_KILTER_SEND_COMMENT}, now(), now(), now()),
             (${uuidv4()}, ${OWNER}, ${publicClimbUuid}, 'kilter', ${ANGLE}, 'attempt', NULL,
              1, false, false, NULL, ${PUBLIC_KILTER_TICK_COMMENT}, now(), now(), now())
    `);

    // The answers BEFORE the orphan exists. A count is a leak the sentinel scan
    // cannot see, so the cases below compare against these.
    for (const viewer of VIEWERS) {
      proposalTotalBefore.set(viewer.name, (await browseProposals(viewer.name)).browseProposals.totalCount);
      profileStatsBefore.set(viewer.name, await profileStats(viewer.name));
    }

    const draft = (await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'spray',
          layoutId: world.layoutId,
          name: ORPHAN_DRAFT_NAME,
          isDraft: true,
          frames: world.frames,
          angle: ANGLE,
        },
      },
      ctxFor(OWNER),
    )) as { uuid: string };
    orphanClimbUuid = draft.uuid;

    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, difficulty, quality,
                                   attempt_count, is_mirror, is_benchmark, session_id, board_id,
                                   comment, climbed_at, created_at, updated_at)
      VALUES (${orphanTickUuid}, ${OWNER}, ${orphanClimbUuid}, 'spray', ${ANGLE}, 'send', ${ORPHAN_DIFFICULTY}, 3,
              1, false, false, ${world.sessionId}, ${world.boardId},
              ${ORPHAN_TICK_COMMENT}, now(), now(), now())
    `);

    // A session made of NOTHING but a log on the deleted climb, so a reader that
    // answers per session can be asked whether it leaves an empty shell behind.
    // Same climb and grade as the log above, so no profile count moves.
    await db.execute(sql`
      INSERT INTO board_sessions (id, board_path, created_by_user_id, name, board_id, status, started_at, created_at, last_activity)
      VALUES (${orphanOnlySessionId}, ${`spray/${world.layoutId}/${world.sizeId}/1/${ANGLE}`}, ${OWNER}, 'Orphan-only session',
              ${world.boardId}, 'active', now() - interval '1 hour', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO board_session_participants (session_id, user_id, joined_at) VALUES (${orphanOnlySessionId}, ${OWNER}, now())
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, difficulty, quality,
                                   attempt_count, is_mirror, is_benchmark, session_id, board_id,
                                   comment, climbed_at, created_at, updated_at)
      VALUES (${uuidv4()}, ${OWNER}, ${orphanClimbUuid}, 'spray', ${ANGLE}, 'send', ${ORPHAN_DIFFICULTY}, 3,
              1, false, false, ${orphanOnlySessionId}, ${world.boardId},
              ${ORPHAN_SESSION_TICK_COMMENT}, now(), now(), now())
    `);

    // A catalogue tick can arrive before its climb. Keep it in the author's raw
    // logbook, but deny enriched/public reads until the parent is available.
    // An attempt, so no profile count moves.
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status,
                                   attempt_count, is_mirror, is_benchmark, comment, climbed_at, created_at, updated_at)
      VALUES (${uuidv4()}, ${OWNER}, 'sweep-ghost-kilter-climb', 'kilter', ${ANGLE}, 'attempt',
              1, false, false, ${GHOST_KILTER_TICK_COMMENT}, now(), now(), now())
    `);

    orphanGradeProposalUuid = uuidv4();
    orphanHideProposalUuid = uuidv4();
    await db.execute(sql`
      INSERT INTO climb_proposals (uuid, climb_uuid, board_type, angle, proposer_id, type, proposed_value, current_value, reason, status, created_at)
      VALUES (${orphanGradeProposalUuid}, ${orphanClimbUuid}, 'spray', ${ANGLE}, ${OWNER}, 'grade', '20', '18', ${ORPHAN_PROPOSAL_REASON}, 'open', now()),
             (${orphanHideProposalUuid}, ${orphanClimbUuid}, 'spray', NULL, ${OWNER}, 'hide', 'true', 'false', ${ORPHAN_HIDE_REASON}, 'open', now())
    `);
    await db.execute(sql`
      INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
      VALUES (${orphanHideCommentUuid}, 'proposal', ${orphanHideProposalUuid}, ${OWNER}, ${ORPHAN_HIDE_REASON}, now(), now()),
             (${uuidv4()}, 'climb', ${orphanClimbUuid}, ${OWNER}, ${ORPHAN_COMMENT_BODY}, now(), now())
    `);

    // The comment rule has no board type to key on, so it applies to every
    // board: a comment on a catalogue-board climb that has no row.
    await db.execute(sql`
      INSERT INTO comments (uuid, entity_type, entity_id, user_id, body, created_at, updated_at)
      VALUES (${uuidv4()}, 'climb', 'sweep-orphan-kilter-missing', ${OWNER}, ${MISSING_KILTER_COMMENT}, now(), now())
    `);

    // The stranger follows the owner. A build before #6032 wrote the stranger a
    // feed row for the hide-reason comment WHILE THE DRAFT STILL EXISTS — its
    // metadata carried the draft's name, frames and layout id, because
    // `getProposalContextMetadata` checked nothing. Now the write-side gate skips
    // a draft climb and a wall that may not announce, so the fan-out lands empty.
    await fanoutCommentFeedItems({
      type: 'comment.created',
      actorId: OWNER,
      entityType: 'comment',
      entityId: orphanHideCommentUuid,
      timestamp: Date.now(),
      metadata: { commentUuid: orphanHideCommentUuid },
    });
    const fannedOut = (await db.execute(sql`
      SELECT metadata->>'climbName' AS "climbName", metadata->>'boardType' AS "boardType"
      FROM feed_items WHERE recipient_id = ${STRANGER} AND entity_id = ${orphanHideCommentUuid}
    `)) as unknown as Array<{ climbName: string; boardType: string }>;
    expect(fannedOut).toEqual([]);

    // …and the row a PRE-fix build would already have written is seeded by hand —
    // the same shape spray-wall-api.test.ts uses for the post-commit window — so
    // the #5981 read gate below stays tested against the legacy rows production
    // still holds. Only the fields the gate keys on and the leak scan looks for.
    await db.execute(sql`
      INSERT INTO feed_items (recipient_id, actor_id, type, entity_type, entity_id, metadata, created_at)
      VALUES (
        ${STRANGER}, ${OWNER}, 'comment', 'comment', ${orphanHideCommentUuid},
        ${JSON.stringify({
          climbUuid: orphanClimbUuid,
          boardType: 'spray',
          proposalType: 'hide',
          climbName: ORPHAN_DRAFT_NAME,
          layoutId: world.layoutId,
          frames: world.frames,
          commentBody: ORPHAN_HIDE_REASON,
        })}::jsonb,
        now()
      )
    `);

    // The real path, not a raw DELETE: this is the mutation that strands them.
    await climbMutations.deleteDraftClimb({}, { uuid: orphanClimbUuid, boardType: 'spray' }, ctxFor(OWNER));
    const remaining = (await db.execute(
      sql`SELECT 1 FROM board_climbs WHERE uuid = ${orphanClimbUuid}`,
    )) as unknown as unknown[];
    expect(remaining).toHaveLength(0);
  }, 120_000);

  it('browseProposals lists no proposal on the deleted climb, and counts none', async () => {
    for (const viewer of VIEWERS) {
      const answer = await browseProposals(viewer.name);
      expect({ viewer: viewer.name, secrets: secretsIn(answer) }, 'the proposal reason must not be returned').toEqual({
        viewer: viewer.name,
        secrets: [],
      });
      expect(
        answer.browseProposals.proposals.filter((proposal) => proposal.climbUuid === orphanClimbUuid),
        viewer.name,
      ).toEqual([]);
      expect(answer.browseProposals.totalCount, `${viewer.name}: totalCount`).toBe(
        proposalTotalBefore.get(viewer.name),
      );
    }
    // The gate did not empty the reader: the owner still gets the live climb's.
    expect(JSON.stringify(await browseProposals('owner'))).toContain(PROPOSAL_REASON);
  });

  it('climbProposals answers the empty page for the deleted climb', async () => {
    for (const viewer of VIEWERS) {
      const answer = await ask(
        viewer.name,
        'query Orphan($input: GetClimbProposalsInput!) { climbProposals(input: $input) ' +
          '{ totalCount hasMore proposals { uuid reason } } }',
        { input: { climbUuid: orphanClimbUuid, boardType: 'spray' } },
      );
      expect(answer, viewer.name).toEqual({ climbProposals: { totalCount: 0, hasMore: false, proposals: [] } });
    }
  });

  it('globalCommentFeed carries no comment on the deleted climb', async () => {
    for (const viewer of VIEWERS) {
      const answer = await commentFeed(viewer.name);
      expect(
        { viewer: viewer.name, found: secretsIn(answer).filter((secret) => secret === ORPHAN_COMMENT_BODY) },
        'a comment on a hard-deleted climb must not be listed',
      ).toEqual({ viewer: viewer.name, found: [] });
    }
    expect(JSON.stringify(await commentFeed('owner'))).toContain(COMMENT_BODY);
  });

  it('globalCommentFeed carries no thread of a proposal on the deleted climb', async () => {
    for (const viewer of VIEWERS) {
      const answer = await commentFeed(viewer.name);
      expect(
        { viewer: viewer.name, found: secretsIn(answer).filter((secret) => secret === ORPHAN_HIDE_REASON) },
        'a hide reason on a hard-deleted spray climb must not be listed',
      ).toEqual({ viewer: viewer.name, found: [] });
    }
    // The live climb's hide reason still reaches the owner, so the new condition
    // did not drop every proposal thread (or, through a NULL, the whole feed).
    expect(JSON.stringify(await commentFeed('owner'))).toContain(HIDE_REASON);
  });

  it('globalCommentFeed applies the missing-climb rule on every board', async () => {
    for (const viewer of VIEWERS) {
      const feed = JSON.stringify(await commentFeed(viewer.name));
      expect(feed.includes(MISSING_KILTER_COMMENT), `${viewer.name}: comment on a climb with no row`).toBe(false);
    }
  });

  it('globalCommentFeed filtered to the wall carries nothing from the deleted climb either', async () => {
    // The board filter joins `board_climbs` for a climb comment, so that arm was
    // already closed. A proposal thread is filtered on the PROPOSAL's board type,
    // which a proposal on a deleted climb still has.
    for (const viewer of VIEWERS) {
      const answer = await commentFeed(viewer.name, world.wallUuid);
      expect({ viewer: viewer.name, found: secretsIn(answer) }, 'filtered by the wall').toEqual({
        viewer: viewer.name,
        found: [],
      });
    }
    expect(JSON.stringify(await commentFeed('owner', world.wallUuid))).toContain(COMMENT_BODY);
  });

  it('activityFeed drops a fanned-out row once its spray climb is deleted', async () => {
    // Authenticated only, and the row was written for the stranger: the owner is
    // the actor and never a recipient of their own event.
    const answer = await ask(
      'stranger',
      'query Orphan($input: ActivityFeedInput) { activityFeed(input: $input) ' +
        '{ items { type entityId climbName climbUuid layoutId frames commentBody } } }',
      { input: { limit: 50 } },
    );
    const feed = JSON.stringify(answer);
    expect(
      {
        draftName: feed.includes(ORPHAN_DRAFT_NAME),
        hideReason: feed.includes(ORPHAN_HIDE_REASON),
        climbUuid: feed.includes(orphanClimbUuid),
        frames: feed.includes(world.frames),
      },
      "a follower must not be handed a deleted draft's name, frames or the comment about it",
    ).toEqual({ draftName: false, hideReason: false, climbUuid: false, frames: false });
  });

  it('comments(proposal) answers the empty page for a proposal on the deleted climb', async () => {
    for (const viewer of VIEWERS) {
      const answer = await ask(
        viewer.name,
        'query Orphan($input: CommentsInput!) { comments(input: $input) { totalCount comments { uuid body } } }',
        { input: { entityType: 'proposal', entityId: orphanHideProposalUuid } },
      );
      expect(answer, viewer.name).toEqual({ comments: { totalCount: 0, comments: [] } });
    }
  });

  it('userProfileStats counts the log for its author and for nobody else', async () => {
    // Keep the same public session parent that existed for the baseline counts;
    // setup.ts removed it before this test, independently of the orphaned climb.
    await reseedSessionRows();
    for (const viewer of ['anonymous', 'stranger'] as const) {
      // Not one number moves: no `spray-unknown` bucket, no extra distinct climb.
      expect(await profileStats(viewer), viewer).toEqual(profileStatsBefore.get(viewer));
    }

    const own = await profileStats('owner');
    const ownBefore = profileStatsBefore.get('owner')!;
    expect(own.totalDistinctClimbs).toBe(ownBefore.totalDistinctClimbs + 1);
    expect(own.layoutStats.find((entry) => entry.layoutKey === 'spray-unknown')).toEqual({
      layoutKey: 'spray-unknown',
      boardType: 'spray',
      layoutId: null,
      distinctClimbCount: 1,
      gradeCounts: [{ grade: String(ORPHAN_DIFFICULTY), count: 1 }],
    });
  });

  /**
   * The generic half, for the log itself (#6031).
   *
   * The explicit cases above name the readers #5981 fixed. A LOG reaches far
   * more of the schema than a proposal does: the logbook, the ascents feeds, the
   * session readers. So every enumerated field is run again, now that the
   * orphan exists, and scanned for what only the deleted climb's log carries.
   * A reader added tomorrow is covered the day it lands.
   */
  describe('the log on the deleted climb, through every reader', () => {
    const orphanOutcomes = new Map<string, Record<ViewerName, Outcome>>();
    let orphanSentinels: Sentinel[] = [];

    beforeAll(async () => {
      orphanSentinels = [
        { name: 'orphan tick comment', value: ORPHAN_TICK_COMMENT, kind: 'secret' },
        { name: 'orphan session tick comment', value: ORPHAN_SESSION_TICK_COMMENT, kind: 'secret' },
        { name: 'orphan tick uuid', value: orphanTickUuid, kind: 'secret' },
        { name: 'orphan climb uuid', value: orphanClimbUuid, kind: 'secret' },
      ];
      await reseedSessionRows();
      for (const row of rows) {
        const perViewer = {} as Record<ViewerName, Outcome>;
        for (const viewer of VIEWERS) {
          perViewer[viewer.name] = await runRow(row, viewer.ctx);
        }
        orphanOutcomes.set(row.key, perViewer);
      }
    }, 600_000);

    it('never hands it to an anonymous caller or a stranger', () => {
      const leaks: string[] = [];
      for (const row of rows) {
        for (const viewer of ['anonymous', 'stranger'] as const) {
          const outcome = orphanOutcomes.get(row.key)![viewer];
          const hits = [
            ...findSentinels(outcome.data, orphanSentinels),
            ...findSentinels(outcome.errorMessages, orphanSentinels),
          ];
          for (const hit of hits) leaks.push(`${row.key} → ${viewer}: ${hit}`);
        }
      }
      expect(leaks).toEqual([]);
    });

    it('keeps the author’s raw logbook entry but omits it from enriched ascent feeds', () => {
      const seenByOwner = rows
        .filter((row) => findSentinels(orphanOutcomes.get(row.key)!.owner.data, orphanSentinels).length > 0)
        .map((row) => row.key);
      expect(seenByOwner).toContain('Query.userTicks');
      for (const key of ['Query.userAscentsFeed', 'Query.userGroupedAscentsFeed', 'Query.sessionDetail']) {
        expect(seenByOwner, key).not.toContain(key);
      }
    });

    it('reached every session reader for the owner, so the pass above is not vacuous', () => {
      const ownerData = (key: string) =>
        orphanOutcomes.get(key)!.owner.data as Record<string, { sessions?: unknown[] } | null> | null;
      expect(ownerData('Query.sessionDetail')?.sessionDetail, 'sessionDetail').not.toBeNull();
      expect(ownerData('Query.sessionSummary')?.sessionSummary, 'sessionSummary').not.toBeNull();
      expect(
        ownerData('Query.sessionGroupedFeed')?.sessionGroupedFeed?.sessions?.length,
        'sessionGroupedFeed',
      ).toBeGreaterThan(0);
      expect(ownerData('Query.gymStats')?.gymStats, 'gymStats').not.toBeNull();
      // …and through the session cards the owner is shown their own log on the
      // deleted climb: it is the hardest send of the sweep's session.
      expect(findSentinels(ownerData('Query.sessionGroupedFeed'), orphanSentinels).join(' | ')).toContain(
        'hardestSend',
      );
    });

    it('sessionGroupedFeed picks the hardest send the viewer may see, not a nulled shell', async () => {
      await reseedSessionRows();
      const cards = async (viewer: ViewerName) => {
        const answer = (await ask(
          viewer,
          'query Orphan($input: ActivityFeedInput) { sessionGroupedFeed(input: $input) ' +
            '{ sessions { sessionId tickCount hardestSend { uuid climbUuid climbName boardType comment } ' +
            'featuredBeta { tick { uuid climbUuid comment } betaLink { climbUuid link } } } } }',
          { input: { userId: OWNER, limit: 50 } },
        )) as {
          sessionGroupedFeed: {
            sessions: Array<{ sessionId: string; hardestSend: { boardType: string; comment: string | null } | null }>;
          };
        };
        return answer.sessionGroupedFeed.sessions;
      };

      for (const viewer of ['anonymous', 'stranger'] as const) {
        const sessions = await cards(viewer);
        // Nothing of the wall: not the live climb's log, not the deleted one's,
        // not the beta link. `sentinels` is the main sweep's list.
        expect(
          { viewer, hits: findSentinels(sessions, [...sentinels, ...orphanSentinels].filter(isSecretSentinel)) },
          'a session card must not carry a log or a beta link from a wall the viewer cannot see',
        ).toEqual({ viewer, hits: [] });
        // The private wall's sessions stay hidden. A separate public session
        // proves this reader still delivers an authorized send.
        expect(
          sessions.find((session) => session.sessionId === world.sessionId),
          viewer,
        ).toBeUndefined();
        expect(sessions.find((session) => session.sessionId === publicSessionId)?.hardestSend, viewer).toMatchObject({
          boardType: 'kilter',
          comment: PUBLIC_KILTER_SEND_COMMENT,
        });
        expect(
          sessions.find((session) => session.sessionId === orphanOnlySessionId),
          `${viewer}: orphan-only session`,
        ).toBeUndefined();
      }

      const own = await cards('owner');
      expect(own.find((session) => session.sessionId === world.sessionId)?.hardestSend?.comment).toBe(
        ORPHAN_TICK_COMMENT,
      );
      // A user-scoped feed requires at least one readable parent climb to select
      // the session. The raw logbook and numeric summary remain covered above.
      expect(own.find((session) => session.sessionId === orphanOnlySessionId)).toBeUndefined();
    });

    it('the daily highlight card never anchors on a log the viewer may not see', async () => {
      // A day with no session: the feed builds a "daily highlight" card from the
      // day's hardest log, and anchors the card's votes and comments on that
      // tick's uuid. Seeded here, on the LIVE private climb and three days back,
      // with a beta link of its own. Same climb and grade as the sweep's tick, so
      // no profile count moves.
      const dailyTickUuid = uuidv4();
      await db.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, climb_uuid, board_type, angle, status, difficulty, quality,
                                     attempt_count, is_mirror, is_benchmark, comment, climbed_at, created_at, updated_at)
        VALUES (${dailyTickUuid}, ${OWNER}, ${world.climbUuid}, 'spray', ${ANGLE}, 'send', 18, 3,
                1, false, false, ${DAILY_PRIVATE_TICK_COMMENT}, now() - interval '3 days', now(), now())
      `);
      await db.execute(sql`
        INSERT INTO board_beta_links (board_type, climb_uuid, link, foreign_username, angle, is_listed, created_by_user_id, tick_uuid)
        VALUES ('spray', ${world.climbUuid}, ${DAILY_PRIVATE_BETA_LINK}, 'someone', ${ANGLE}, true, ${OWNER}, ${dailyTickUuid})
      `);

      const daily = (viewer: ViewerName) =>
        ask(
          viewer,
          'query Daily($input: ActivityFeedInput) { sessionGroupedFeed(input: $input) ' +
            '{ sessions { sessionId sessionType socialEntityId hardestSend { uuid climbUuid comment } ' +
            'featuredBeta { tick { uuid comment } betaLink { climbUuid link } } } } }',
          { input: { userId: OWNER, includeDailyHighlights: true, limit: 50 } },
        );
      const dailySecrets = [DAILY_PRIVATE_TICK_COMMENT, DAILY_PRIVATE_BETA_LINK, dailyTickUuid];
      const found = (answer: unknown) => dailySecrets.filter((secret) => JSON.stringify(answer).includes(secret));

      for (const viewer of ['anonymous', 'stranger'] as const) {
        expect({ viewer, found: found(await daily(viewer)) }).toEqual({ viewer, found: [] });
      }
      // The owner gets the card, the log and the link.
      expect(found(await daily('owner')).sort()).toEqual([...dailySecrets].sort());
    });

    // The two ascents feeds take no argument the sweep can seed, so it never
    // enumerates them. The stranger follows the owner, which is the case the
    // following feed exists for.
    const ascentsFeed = (field: 'followingAscentsFeed' | 'globalAscentsFeed', viewer: ViewerName) =>
      ask(
        viewer,
        `query Orphan($input: FollowingAscentsFeedInput) { ${field}(input: $input) ` +
          '{ items { uuid climbUuid climbName boardType comment } } }',
        { input: { limit: 50 } },
      );
    const orphanHits = (answer: unknown) => findSentinels(answer, orphanSentinels);
    const isSecretSentinel = (sentinel: Sentinel) => sentinel.kind === 'secret';

    it('followingAscentsFeed does not carry it to a follower', async () => {
      const feed = await ascentsFeed('followingAscentsFeed', 'stranger');
      expect(orphanHits(feed)).toEqual([]);
      // The feed itself is not empty: the owner's logs on other boards arrive.
      expect(JSON.stringify(feed)).toContain(PUBLIC_KILTER_TICK_COMMENT);
    });

    it('globalAscentsFeed requires a readable parent even for the tick author', async () => {
      for (const viewer of VIEWERS) {
        const feed = await ascentsFeed('globalAscentsFeed', viewer.name);
        expect({ viewer: viewer.name, hits: orphanHits(feed) }).toEqual({
          viewer: viewer.name,
          hits: [],
        });
        expect(JSON.stringify(feed), viewer.name).toContain(PUBLIC_KILTER_TICK_COMMENT);
      }
    });

    it('sessionDetail keeps the owner’s counts without enriching a missing-climb tick', async () => {
      await reseedSessionRows();
      const detail = (viewer: ViewerName) =>
        ask(
          viewer,
          'query Orphan($sessionId: ID!) { sessionDetail(sessionId: $sessionId) { sessionId tickCount ticks { uuid comment } } }',
          { sessionId: orphanOnlySessionId },
        );
      for (const viewer of ['anonymous', 'stranger'] as const) {
        expect(await detail(viewer), viewer).toEqual({ sessionDetail: null });
      }
      expect(await detail('owner')).toEqual({
        sessionDetail: { sessionId: orphanOnlySessionId, tickCount: 1, ticks: [] },
      });
    });

    it('the session summary names the deleted climb as the hardest send to its author only', async () => {
      // Called directly, as `spray-wall-api.test.ts` does: the summary is also
      // built by `endSession`, with the viewer it is being rendered for.
      const hardest = async (viewer: string | null) =>
        (await generateSessionSummary(orphanOnlySessionId, viewer))?.hardestClimb?.climbUuid ?? null;

      await reseedSessionRows();

      expect(await hardest(STRANGER)).toBeNull();
      expect(await hardest(null)).toBeNull();
      expect(await hardest(OWNER)).toBe(orphanClimbUuid);
    });

    it('gymStats does not list the deleted climb among the top climbs', () => {
      // `gymStats` passes a null viewer, so nobody is exempt, the owner included.
      const stats = orphanOutcomes.get('Query.gymStats')!.owner;
      expect(stats.errorMessages).toEqual([]);
      expect((stats.data as { gymStats: unknown } | null)?.gymStats).not.toBeNull();
      expect(JSON.stringify(stats.data)).not.toContain(orphanClimbUuid);
    });

    it('userAscentsFeed leaves it out of the total as well as the page', async () => {
      // A count is a leak the sentinel scan cannot see. The list and the count
      // spread the same conditions, so a stranger's total is what they are shown.
      const feed = (await ask(
        'stranger',
        'query Orphan($userId: ID!, $input: AscentFeedInput) { userAscentsFeed(userId: $userId, input: $input) ' +
          '{ totalCount items { uuid } } }',
        { userId: OWNER, input: { limit: 50 } },
      )) as { userAscentsFeed: { totalCount: number; items: unknown[] } };
      expect(feed.userAscentsFeed.totalCount).toBe(feed.userAscentsFeed.items.length);
    });

    it('keeps missing catalogue-climb logs only in the author’s raw logbook', async () => {
      for (const viewer of VIEWERS) {
        const ticks = await ask(
          viewer.name,
          'query Ghost($userId: ID!, $boardType: String!) { userTicks(userId: $userId, boardType: $boardType) { climbUuid comment } }',
          { userId: OWNER, boardType: 'kilter' },
        );
        expect(JSON.stringify(ticks).includes(GHOST_KILTER_TICK_COMMENT), `${viewer.name}: userTicks`).toBe(
          viewer.name === 'owner',
        );
        expect(JSON.stringify(ticks), `${viewer.name}: userTicks positive control`).toContain(
          PUBLIC_KILTER_TICK_COMMENT,
        );
        const feed = await ask(
          viewer.name,
          'query Ghost($userId: ID!) { userAscentsFeed(userId: $userId) { items { climbName comment } } }',
          { userId: OWNER },
        );
        expect(JSON.stringify(feed), `${viewer.name}: userAscentsFeed`).not.toContain(GHOST_KILTER_TICK_COMMENT);
        expect(JSON.stringify(feed), `${viewer.name}: userAscentsFeed positive control`).toContain(
          PUBLIC_KILTER_TICK_COMMENT,
        );
        const grouped = await ask(
          viewer.name,
          'query Ghost($userId: ID!) { userGroupedAscentsFeed(userId: $userId) { groups { climbUuid latestComment } } }',
          { userId: OWNER },
        );
        expect(JSON.stringify(grouped), `${viewer.name}: userGroupedAscentsFeed`).not.toContain(
          'sweep-ghost-kilter-climb',
        );
        expect(JSON.stringify(grouped), `${viewer.name}: userGroupedAscentsFeed positive control`).toContain(
          publicClimbUuid,
        );
      }
      expect(JSON.stringify(await ascentsFeed('globalAscentsFeed', 'anonymous'))).not.toContain(
        GHOST_KILTER_TICK_COMMENT,
      );
      expect(JSON.stringify(await ascentsFeed('followingAscentsFeed', 'stranger'))).not.toContain(
        GHOST_KILTER_TICK_COMMENT,
      );
    });
  });
});

// #6037: anonymous totals remain, but UUID possession never unlocks private prose.
describe('private spray social references and anonymous aggregates', () => {
  const publicClimbUuid = uuidv4();
  const deletedSprayUuid = uuidv4();
  const deletedCatalogueUuid = uuidv4();
  const privateTickUuid = uuidv4();
  const publicTickUuid = uuidv4();
  const privateFriendTickUuid = uuidv4();
  const privateCommentUuid = uuidv4();
  const cycleCommentUuid = uuidv4();
  const sessionId = uuidv4();
  const privacyViewers = [
    ...VIEWERS,
    { name: 'unauthenticated owner', ctx: { ...ctxFor(OWNER), isAuthenticated: false } },
  ];
  const privateThreadBody = '6037 private tick prose';
  const publicThreadBody = '6037 catalogue tick prose';

  async function ask6037(
    ctx: ConnectionContext,
    document: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const outcome = await runRow(
      { key: '6037 case', rootName: 'Query', fieldName: 'privacy', document, variables, kinds: [] },
      ctx,
    );
    expect(outcome.errorMessages).toEqual([]);
    return outcome.data;
  }

  async function restoreSession(): Promise<void> {
    await db
      .insert(dbSchema.boardSessions)
      .values({
        id: sessionId,
        boardPath: 'kilter/1/1/1/40',
        createdByUserId: OWNER,
        name: '6037 mixed session',
        boardId: world.boardId,
        status: 'active',
        startedAt: new Date(),
        lastActivity: new Date(),
      })
      .onConflictDoNothing();
  }

  beforeAll(async () => {
    await db.insert(dbSchema.boardClimbs).values({
      uuid: publicClimbUuid,
      boardType: 'kilter',
      layoutId: 1,
      name: '6037 public catalogue climb',
      isDraft: false,
      isListed: true,
      frames: '',
      userId: OWNER,
    });
    await db.insert(dbSchema.boardseshTicks).values([
      {
        uuid: privateTickUuid,
        userId: OWNER,
        climbUuid: world.climbUuid,
        boardType: 'spray',
        angle: ANGLE,
        status: 'send',
        quality: 5,
        difficulty: 18,
        sessionId,
        boardId: world.boardId,
        climbedAt: new Date().toISOString(),
      },
      {
        uuid: publicTickUuid,
        userId: OWNER,
        climbUuid: publicClimbUuid,
        boardType: 'kilter',
        angle: ANGLE,
        status: 'send',
        difficulty: 10,
        sessionId,
        climbedAt: new Date().toISOString(),
      },
      {
        uuid: privateFriendTickUuid,
        userId: FRIEND,
        climbUuid: world.climbUuid,
        boardType: 'spray',
        angle: ANGLE,
        status: 'send',
        difficulty: 18,
        sessionId,
        climbedAt: new Date().toISOString(),
      },
      {
        uuid: uuidv4(),
        userId: OWNER,
        climbUuid: deletedSprayUuid,
        boardType: 'spray',
        angle: ANGLE,
        status: 'send',
        quality: 5,
        climbedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(dbSchema.boardseshTicks).values([
      {
        uuid: uuidv4(),
        userId: OWNER,
        climbUuid: world.climbUuid,
        boardType: 'spray',
        angle: ANGLE,
        status: 'send',
        difficulty: 18,
        climbedAt: '2026-10-03T12:00:00Z',
      },
      {
        uuid: uuidv4(),
        userId: OWNER,
        climbUuid: publicClimbUuid,
        boardType: 'kilter',
        angle: ANGLE,
        status: 'send',
        difficulty: 10,
        climbedAt: '2026-10-03T12:01:00Z',
      },
      {
        uuid: uuidv4(),
        userId: FRIEND,
        climbUuid: world.climbUuid,
        boardType: 'spray',
        angle: ANGLE,
        status: 'send',
        difficulty: 18,
        climbedAt: '2026-10-03T12:02:00Z',
      },
    ]);
    await db.insert(dbSchema.comments).values([
      {
        uuid: uuidv4(),
        userId: OWNER,
        entityType: 'playlist_climb',
        entityId: `${world.playlistId}:${world.climbUuid}`,
        body: '6037 private playlist prose',
      },
      {
        uuid: uuidv4(),
        userId: OWNER,
        entityType: 'comment',
        entityId: privateCommentUuid,
        body: '6037 nested private prose',
      },

      {
        uuid: privateCommentUuid,
        userId: OWNER,
        entityType: 'tick',
        entityId: privateTickUuid,
        body: privateThreadBody,
      },
      { uuid: uuidv4(), userId: OWNER, entityType: 'tick', entityId: publicTickUuid, body: publicThreadBody },
      {
        uuid: uuidv4(),
        userId: OWNER,
        entityType: 'climb',
        entityId: deletedSprayUuid,
        body: '6037 deleted spray prose',
      },
      {
        uuid: uuidv4(),
        userId: OWNER,
        entityType: 'climb',
        entityId: deletedCatalogueUuid,
        body: '6037 deleted catalogue prose',
      },
      {
        uuid: cycleCommentUuid,
        userId: OWNER,
        entityType: 'comment',
        entityId: cycleCommentUuid,
        body: '6037 cyclic prose',
      },
    ]);
    await db
      .insert(dbSchema.voteCounts)
      .values([
        { entityType: 'tick', entityId: privateTickUuid, upvotes: 3, downvotes: 1, score: 2, createdAt: new Date() },
        { entityType: 'tick', entityId: publicTickUuid, upvotes: 2, downvotes: 0, score: 2, createdAt: new Date() },
        {
          entityType: 'comment',
          entityId: privateCommentUuid,
          upvotes: 4,
          downvotes: 1,
          score: 3,
          createdAt: new Date(),
        },
        { entityType: 'climb', entityId: world.climbUuid, upvotes: 5, downvotes: 0, score: 5, createdAt: new Date() },
        {
          entityType: 'comment',
          entityId: cycleCommentUuid,
          upvotes: 6,
          downvotes: 0,
          score: 6,
          createdAt: new Date(),
        },
      ])
      .onConflictDoUpdate({
        target: [dbSchema.voteCounts.entityType, dbSchema.voteCounts.entityId],
        set: { upvotes: 5, downvotes: 0, score: 5 },
      });
    await db
      .insert(dbSchema.votes)
      .values({ userId: STRANGER, entityType: 'tick', entityId: privateTickUuid, value: 1 });
    await db
      .insert(dbSchema.userFavorites)
      .values({ userId: OWNER, climbUuid: deletedSprayUuid, boardName: 'spray', angle: ANGLE });
    const [lastProposal] = await db
      .select({ id: dbSchema.climbProposals.id })
      .from(dbSchema.climbProposals)
      .where(eq(dbSchema.climbProposals.uuid, world.hideProposalUuid));
    await db.insert(dbSchema.climbCommunityStatus).values({
      climbUuid: world.climbUuid,
      boardType: 'spray',
      angle: ANGLE,
      communityGrade: '27',
      lastProposalId: lastProposal.id,
    });
    await db
      .insert(dbSchema.climbClassicStatus)
      .values({ climbUuid: world.climbUuid, boardType: 'spray', isClassic: true, lastProposalId: lastProposal.id });
  });

  it('hides private tick/comment threads and every deleted-climb thread, keeping a live catalogue control', async () => {
    const document =
      'query Privacy($input: CommentsInput!) { comments(input: $input) { totalCount hasMore comments { body } } }';
    for (const viewer of privacyViewers) {
      const privateAnswer = await ask6037(viewer.ctx, document, {
        input: { entityType: 'tick', entityId: privateTickUuid },
      });
      if (viewer.name === 'owner') expect(JSON.stringify(privateAnswer)).toContain(privateThreadBody);
      else expect(privateAnswer).toEqual({ comments: { totalCount: 0, hasMore: false, comments: [] } });
      expect(
        JSON.stringify(
          await ask6037(viewer.ctx, document, { input: { entityType: 'tick', entityId: publicTickUuid } }),
        ),
      ).toContain(publicThreadBody);

      for (const root of [
        {
          entityType: 'playlist_climb',
          entityId: `${world.playlistId}:${world.climbUuid}`,
          body: '6037 private playlist prose',
        },
        { entityType: 'comment', entityId: privateCommentUuid, body: '6037 nested private prose' },
      ]) {
        const rootAnswer = await ask6037(viewer.ctx, document, {
          input: { entityType: root.entityType, entityId: root.entityId },
        });
        if (viewer.name === 'owner') expect(JSON.stringify(rootAnswer)).toContain(root.body);
        else expect(rootAnswer).toEqual({ comments: { totalCount: 0, hasMore: false, comments: [] } });
      }
      for (const climbUuid of [deletedSprayUuid, deletedCatalogueUuid]) {
        expect(await ask6037(viewer.ctx, document, { input: { entityType: 'climb', entityId: climbUuid } })).toEqual({
          comments: { totalCount: 0, hasMore: false, comments: [] },
        });
      }
    }
  });

  it('neutralizes single and batch private votes, including comment roots and the caller vote', async () => {
    const document =
      'query Privacy($type: SocialEntityType!, $id: String!, $input: BulkVoteSummaryInput!) { voteSummary(entityType: $type, entityId: $id) { upvotes downvotes voteScore userVote } bulkVoteSummaries(input: $input) { entityId upvotes userVote } }';
    for (const viewer of privacyViewers) {
      const answer = await ask6037(viewer.ctx, document, {
        type: 'tick',
        id: privateTickUuid,
        input: { entityType: 'tick', entityIds: [privateTickUuid, publicTickUuid] },
      });
      if (viewer.name === 'owner')
        expect(answer).toMatchObject({ voteSummary: { upvotes: 3, downvotes: 1, voteScore: 2 } });
      else
        expect(answer).toMatchObject({
          voteSummary: { upvotes: 0, downvotes: 0, voteScore: 0, userVote: 0 },
          bulkVoteSummaries: [
            { entityId: privateTickUuid, upvotes: 0, userVote: 0 },
            { entityId: publicTickUuid, upvotes: 2 },
          ],
        });
      const commentAnswer = await ask6037(viewer.ctx, document, {
        type: 'comment',
        id: privateCommentUuid,
        input: { entityType: 'comment', entityIds: [privateCommentUuid, cycleCommentUuid] },
      });
      expect(commentAnswer).toMatchObject({
        voteSummary: { upvotes: viewer.name === 'owner' ? 4 : 0 },
        bulkVoteSummaries: [{ entityId: privateCommentUuid }, { entityId: cycleCommentUuid, upvotes: 0, userVote: 0 }],
      });
    }
  });

  it('neutralizes inaccessible community metadata before enrichment and keeps owner data', async () => {
    const document =
      'query Privacy($uuid: String!) { climbCommunityStatus(climbUuid: $uuid, boardType: "spray", angle: 40) { communityGrade isClassic openProposalCount freezeReason } bulkClimbCommunityStatus(climbUuids: [$uuid], boardType: "spray", angle: 40) { communityGrade isClassic } climbClassicStatus(climbUuid: $uuid, boardType: "spray") { isClassic } }';
    for (const viewer of privacyViewers) {
      const answer = await ask6037(viewer.ctx, document, { uuid: world.climbUuid });
      if (viewer.name === 'owner')
        expect(answer).toMatchObject({
          climbCommunityStatus: { communityGrade: '27', isClassic: true },
          climbClassicStatus: { isClassic: true },
        });
      else
        expect(answer).toEqual({
          climbCommunityStatus: { communityGrade: null, isClassic: false, openProposalCount: 0, freezeReason: null },
          bulkClimbCommunityStatus: [{ communityGrade: null, isClassic: false }],
          climbClassicStatus: { isClassic: false },
        });
    }
    expect(await ask6037(ctxFor(OWNER), document, { uuid: deletedSprayUuid })).toMatchObject({
      climbCommunityStatus: { communityGrade: null, openProposalCount: 0 },
    });
  });

  it('excludes deleted spray smart refs and retains the author’s live climb counts', async () => {
    const document =
      'query Privacy($input: GetSmartPlaylistInput!) { smartPlaylist(input: $input) { totalCount hasMore meta { climbCount } climbs { uuid } } }';
    for (const type of ['FIVE_STARS', 'LIKED_CLIMBS']) {
      for (const ctx of [ctxFor(null), ctxFor(STRANGER), { ...ctxFor(OWNER), isAuthenticated: false }]) {
        expect(await ask6037(ctx, document, { input: { type, userId: OWNER, boardName: 'spray' } })).toMatchObject({
          smartPlaylist: { totalCount: 0, hasMore: false, meta: { climbCount: 0 }, climbs: [] },
        });
      }
      expect(
        await ask6037(ctxFor(OWNER), document, { input: { type, userId: OWNER, boardName: 'spray' } }),
      ).toMatchObject({ smartPlaylist: { totalCount: 1, meta: { climbCount: 1 } } });
    }
  });

  it('fails closed for unknown social roots while allowing established general threads', async () => {
    const { readableSocialEntityIds } = await import('../graphql/resolvers/social/entity-read-access');
    expect(await readableSocialEntityIds('future_private_root' as SocialEntityType, [privateTickUuid], null)).toEqual(
      new Set(),
    );
    for (const entityType of ['board', 'gym', 'session'] as const) {
      expect(await readableSocialEntityIds(entityType, [publicTickUuid], null)).toEqual(new Set([publicTickUuid]));
    }
  });

  it('keeps aggregate sends while hiding named private-only participants and their counts', async () => {
    await restoreSession();
    const document =
      'query Privacy($input: ActivityFeedInput) { sessionGroupedFeed(input: $input) { sessions { sessionId totalSends tickCount participants { userId sends } } } }';
    for (const viewer of privacyViewers) {
      const answer = (await ask6037(viewer.ctx, document, { input: { limit: 50 } })) as {
        sessionGroupedFeed: {
          sessions: Array<{
            sessionId: string;
            totalSends: number;
            tickCount: number;
            participants: Array<{ userId: string; sends: number }>;
          }>;
        };
      };
      const card = answer.sessionGroupedFeed.sessions.find((session) => session.sessionId === sessionId);
      expect(card).toMatchObject({ totalSends: 3, tickCount: 3 });
      expect(card?.participants).toEqual(
        viewer.name === 'owner'
          ? [
              { userId: OWNER, sends: 2 },
              { userId: FRIEND, sends: 1 },
            ]
          : [{ userId: OWNER, sends: 1 }],
      );
      const detail = await ask6037(
        viewer.ctx,
        'query Privacy($id: String!) { sessionDetail(sessionId: $id) { totalSends participants { userId sends } ticks { uuid } } }',
        { id: sessionId },
      );
      expect(detail).toMatchObject({
        sessionDetail: { totalSends: viewer.name === 'owner' ? 3 : 1, participants: card?.participants },
      });
      if (viewer.name !== 'owner') expect(JSON.stringify(detail)).not.toContain(privateTickUuid);
      const summary = await generateSessionSummary(sessionId, viewer.name === 'owner' ? OWNER : null);
      expect(summary?.totalSends).toBe(3);
      expect(
        summary?.participants.map((participant) => ({ userId: participant.userId, sends: participant.sends })),
      ).toEqual(card?.participants);
    }
  });
  it('separates daily aggregate counts from named public/private-only activity', async () => {
    const document =
      'query Privacy($input: ActivityFeedInput) { sessionGroupedFeed(input: $input) { sessions { sessionId totalSends tickCount participants { userId sends } } } }';
    for (const viewer of privacyViewers) {
      const answer = (await ask6037(viewer.ctx, document, {
        input: { limit: 50, includeDailyHighlights: true, userId: OWNER },
      })) as {
        sessionGroupedFeed: {
          sessions: Array<{
            sessionId: string;
            totalSends: number;
            tickCount: number;
            participants: Array<{ userId: string; sends: number }>;
          }>;
        };
      };
      const ownerCard = answer.sessionGroupedFeed.sessions.find(
        (session) => session.sessionId === `daily:${OWNER}:2026-10-03`,
      );
      const friendAnswer = (await ask6037(viewer.ctx, document, {
        input: { limit: 50, includeDailyHighlights: true, userId: FRIEND },
      })) as typeof answer;
      const friendCard = friendAnswer.sessionGroupedFeed.sessions.find(
        (session) => session.sessionId === `daily:${FRIEND}:2026-10-03`,
      );
      expect(ownerCard).toMatchObject({ totalSends: 2, tickCount: 2 });
      expect(ownerCard?.participants).toEqual([{ userId: OWNER, sends: viewer.name === 'owner' ? 2 : 1 }]);
      if (viewer.name === 'owner') {
        expect(friendCard).toMatchObject({ totalSends: 1, tickCount: 1, participants: [{ userId: FRIEND, sends: 1 }] });
      } else {
        // A daily card has no session UUID independent of its tick. Existing
        // policy drops private-only days rather than exposing a private tick.
        expect(friendCard).toBeUndefined();
      }
    }
  });
});
