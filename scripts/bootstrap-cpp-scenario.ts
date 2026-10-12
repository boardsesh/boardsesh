import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getOperationAST, parse } from 'graphql';
import WebSocket from 'ws';
import {
  CREATE_BOARD,
  GET_BOARD_BY_SLUG,
  GET_MY_BOARDS,
  UPDATE_BOARD,
} from '../packages/shared/graphql/src/operations/boards';
import { SEARCH_CLIMBS, SEARCH_CLIMBS_COUNT } from '../packages/shared/graphql/src/operations/climb-search';
import { GET_GRADES, UPDATE_PROFILE } from '../packages/mobile/src/lib/graphql/operations';
import { formatGrade } from '../packages/shared/play-view/src/grade-display';
import { buildGradeRailStops } from '../packages/mobile/src/lib/grade-stops';
import { buildCountPreviewInput } from '../packages/mobile/src/lib/climb-count-preview-input';
import { DEFAULT_FILTERS } from '../packages/mobile/src/lib/climb-filter-types';
import { GET_USER_GROUPED_ASCENTS_FEED, SAVE_TICK } from '../packages/shared/graphql/src/operations/ticks';
import { BOARD_LIVE_SESSIONS } from '../packages/shared/graphql/src/operations/live-sessions';
import { CREATE_SESSION } from '../packages/shared/graphql/src/operations/create-session';
import { JOIN_SESSION, SET_QUEUE_WITH_BASELINE } from '../packages/shared/graphql/src/operations/queue-session';
import {
  CREATE_SPRAY_WALL,
  CREATE_SPRAY_WALL_VERSION,
  GET_MY_SPRAY_WALLS,
  GET_MY_SPRAY_WALL_LIFECYCLE,
  type SprayWallLifecycleRow,
  GET_SPRAY_WALL_WITH_VERSIONS,
  GET_SPRAY_WALL_DRAFT_RENDER_DATA,
  PUBLISH_SPRAY_WALL_VERSION,
  UPSERT_SPRAY_WALL_HOLDS,
  UPDATE_SPRAY_WALL,
} from '../packages/shared/graphql/src/operations/spray-walls';
import {
  GET_SPRAY_DETECTION,
  REQUEST_SPRAY_DETECTION,
} from '../packages/shared/graphql/src/operations/spray-detection';
import { GET_PRIVACY_SETTINGS } from '../packages/shared/graphql/src/operations/privacy';
import { GET_SMART_PLAYLIST } from '../packages/shared/graphql/src/operations/playlists';
import { mapPhotoHoldToCanonical } from '../packages/mobile/src/lib/spray/spray-hold-canonical';
import { BACKEND_URL } from '../packages/mobile/src/lib/env';
import { MAX_SPRAY_WALLS_PER_USER } from '../packages/shared/board-config/src/spray-config';
import { parseBoardPath, parseNamedBoardPath } from '../packages/shared/board-config/src/board-path';
import { pickBestGroupEntry, type GroupableEntry } from '../packages/shared/logbook/src/group-units';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from '../packages/shared/logbook/src/defaults';
import { toAscentFeedInput } from '../packages/shared/logbook/src/to-ascent-feed-input';
import type { SprayDetectionView } from '../packages/shared-schema/src/spray-detection';
import type { ClimbInput, ClimbQueueItemInput } from '../packages/shared-schema/src/generated/types';
import type { ScreenshotCaptureScenario } from './lib/screenshot-fixtures';
import {
  readCppPage,
  isCppTarget,
  isCppAscentId,
  isCppClimbId,
  type CppHeroClimb,
  type CppBoard,
  type CppTarget,
  type CppSceneCoverage,
} from './lib/screenshot-cpp';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
export const CPP_BOOTSTRAP_PROFILE_QUERY = 'query CppBootstrapProfile { profile { id displayName avatarUrl } }';
const SESSION_STATUS_QUERY = `query CppBootstrapSessionStatus($sessionId: ID!) { sessionStatus(sessionId: $sessionId) }`;
const OWNED_SESSIONS_QUERY = `query CppBootstrapOwnedSessions { mySessions { id boardPath createdByUserId isActive isPublic isPermanent } }`;

export interface BootstrapBoard {
  uuid: string;
  name: string;
  ownerId: string;
  canEdit: boolean;
  boardId: number;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isPublic?: boolean;
  layoutName?: string;
  sizeName?: string;
  slug?: string;
}
interface WallVersion {
  id: string;
  number: number;
  status: string;
  homography: number[];
  photo: { url: string; width: number; height: number } | null;
}
interface Wall {
  uuid: string;
  board: BootstrapBoard;
  currentVersion: WallVersion | null;
  versions?: WallVersion[];
  holdCount: number;
}
interface BootstrapSession {
  id: string;
  boardPath: string;
  createdByUserId: string;
  isActive: boolean;
  isPublic: boolean;
  isPermanent: boolean;
}
export interface BootstrapAscent extends GroupableEntry {
  climbUuid: string;
  climbName: string;
  boardType: string;
  layoutId: number | null;
  angle: number;
  isMirror: boolean;
  renderBoard?: { sizeId: number; setIds: number[] } | null;
}
/** SearchClimbs selects statsAngle, which is intentionally absent from queue mutation inputs. */
export type BootstrapClimb = ClimbInput & { statsAngle?: number | null };
export interface BootstrapCheckpoint {
  version: 1;
  upstream: string;
  accountUserId: string;
  boards: Record<
    string,
    {
      uuid: string;
      /** Retained only until the newly created QA row passes a fresh name reread. */
      expectedCatalogueName?: string;
      sourceSha256?: string;
      storedPhotoSha256?: string;
      provenance?: 'pixel-verified' | 'visually-accepted';
      photoId?: string;
      versionId?: string;
    }
  >;
  sessions: Partial<Record<CppTarget, string>>;
  sessionReplacements?: Array<{
    target: CppTarget;
    previousSessionId: string;
    newSessionId: string;
    reason: 'ended-checkpoint' | 'nonpermanent' | 'board-identity';
  }>;
  demoTicks?: Partial<Record<CppTarget, string>>;
  /** Preserved public catalogue rows while a separate private QA board is selected. */
  catalogueSourceBoardIds?: Record<string, string[]>;
}
export interface BootstrapTransport {
  request<T>(this: void, query: string, variables?: Record<string, unknown>): Promise<T>;
  upload(this: void, wallUuid: string, bytes: Buffer, filename: string): Promise<{ photoId: string }>;
  bytes(this: void, url: string): Promise<Buffer>;
  join(
    this: void,
    variables: {
      sessionId: string;
      boardPath: string;
      initialQueue: ClimbQueueItemInput[];
      initialCurrentClimb: ClimbQueueItemInput;
      initializeEmpty?: boolean;
    },
  ): Promise<{ queue: ClimbQueueItemInput[]; currentClimbQueueItem?: ClimbQueueItemInput | null }>;
}
export interface BootstrapOptions {
  target: CppTarget;
  upstream: string;
  accountUserId: string;
  apply: boolean;
  checkpoint: BootstrapCheckpoint;
  saveCheckpoint: (checkpoint: BootstrapCheckpoint) => void;
  transport: BootstrapTransport;
  bindings?: Record<string, string>;
  acceptSourceBindings?: boolean;
  acceptedSourcePhotoSha256?: Record<string, string>;
  seedDemoContent?: boolean;
  detectionWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}
export interface BootstrapResult {
  target: CppTarget;
  boards: Array<{ variantId: string; uuid: string; selector: string }>;
  actions: string[];
  blockers: string[];
  scenario?: ScreenshotCaptureScenario;
}

/** At most ten genuine query rows per board, with no fallback outside that page. */
export function selectCppHeroClimbs(
  sources: readonly {
    variantId: string;
    board: BootstrapBoard;
    climbs: readonly BootstrapClimb[];
    requireBenchmark?: boolean;
  }[],
): Record<string, CppHeroClimb> | undefined {
  if (sources.length > 3) throw new Error('CPP hero selection is bounded to one three-board trio');
  const choices = sources.map(({ board, climbs, requireBenchmark }) =>
    climbs.slice(0, 10).flatMap((climb): CppHeroClimb[] => {
      if (
        !isCppClimbId(climb.uuid) ||
        !climb.name?.trim() ||
        !climb.frames ||
        climb.boardType !== board.boardType ||
        climb.layoutId !== board.layoutId ||
        (climb.angle != null && climb.angle !== board.angle) ||
        (climb.compatibleSizeIds != null && !climb.compatibleSizeIds.includes(board.sizeId)) ||
        (climb.missingHoldCount != null && climb.missingHoldCount > 0) ||
        (board.boardType === 'kilter' && /^moon\s*landing$/i.test(climb.name.trim()))
      )
        return [];
      const benchmark = climb.benchmark_difficulty == null ? undefined : Number(climb.benchmark_difficulty);
      if (
        requireBenchmark &&
        (benchmark === undefined || !Number.isFinite(benchmark) || benchmark <= 0 || climb.statsAngle !== board.angle)
      )
        return [];
      return [
        {
          boardId: board.uuid,
          climbId: climb.uuid,
          readyText: climb.name,
          gradeLabel: formatGrade(climb.difficulty, 'v-grade', board.boardType) ?? '',
          ...(climb.statsAngle != null ? { statsAngle: climb.statsAngle } : {}),
          ...(benchmark !== undefined && Number.isFinite(benchmark) && benchmark > 0 && climb.statsAngle === board.angle
            ? { benchmarkDifficulty: benchmark }
            : {}),
        },
      ];
    }),
  );
  let best: CppHeroClimb[] | undefined;
  let bestScore = -1;
  const visit = (selected: CppHeroClimb[], names: Set<string>, grades: Set<string>) => {
    if (selected.length === choices.length) {
      if (grades.size > bestScore) {
        best = [...selected];
        bestScore = grades.size;
      }
      return;
    }
    for (const candidate of choices[selected.length]) {
      const title = candidate.readyText.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
      if (names.has(title)) continue;
      visit(
        [...selected, candidate],
        new Set([...names, title]),
        new Set([...grades, ...(candidate.gradeLabel ? [candidate.gradeLabel] : [])]),
      );
    }
  };
  visit([], new Set(), new Set());
  return best ? Object.fromEntries(sources.map((source, index) => [source.variantId, best![index]])) : undefined;
}

export function screenshotCatalogueName(variant: CppBoard): string {
  return `Liz's ${variant.selector.replace(/^(Kilter|Tension) Board /, '$1 ')}`;
}

/** Keep the accessory local to the selected wall, using only its real first page. */
export function selectCppAccessoryClimb(
  board: BootstrapBoard,
  climbs: readonly BootstrapClimb[],
  wallClimbId: string,
): CppHeroClimb | undefined {
  if (!isCppClimbId(wallClimbId)) return undefined;
  return selectCppHeroClimbs([
    {
      variantId: 'accessory',
      board,
      climbs: climbs.slice(0, 10).filter((climb) => climb.uuid !== wallClimbId),
    },
  ])?.accessory;
}

function catalogueBoardProof(variant: CppBoard, board: BootstrapBoard, accountUserId: string): string {
  return (
    `${variant.id}: catalogue board proof ownerMatches=${board.ownerId === accountUserId}, ` +
    `editabilityKnown=${typeof board.canEdit === 'boolean'}, canEdit=${board.canEdit === true}, ` +
    `visibilityKnown=${typeof board.isPublic === 'boolean'}, isPrivate=${board.isPublic === false}`
  );
}

/** Public catalogue metadata is preserved; marketing writes use an owned private QA row. */
export function selectScreenshotCatalogueBoard(
  options: Pick<BootstrapOptions, 'accountUserId' | 'bindings' | 'checkpoint'>,
  variant: CppBoard,
  roster: readonly BootstrapBoard[],
): { board?: BootstrapBoard; sourcePublicBoardIds: string[]; problem?: string } {
  const candidates = roster.filter(
    (board) => board.ownerId === options.accountUserId && boardMatchesConfig(board, variant),
  );
  const sourcePublicBoardIds = candidates.filter((board) => board.isPublic === true).map((board) => board.uuid);
  const explicitId = options.bindings?.[variant.id];
  const savedId = options.checkpoint.boards[variant.id]?.uuid;
  const boundId = explicitId ?? savedId;
  const bound = boundId ? candidates.find((board) => board.uuid === boundId) : undefined;
  const expectedName = options.checkpoint.boards[variant.id]?.expectedCatalogueName;
  if (bound && expectedName && (bound.name !== expectedName || bound.isPublic !== false || bound.canEdit !== true))
    return {
      sourcePublicBoardIds,
      problem:
        catalogueBoardProof(variant, bound, options.accountUserId) +
        `, nameMatchesExpected=${bound.name === expectedName}; pending QA creation failed fresh verification; original rows preserved`,
    };
  if (boundId && !bound)
    return {
      sourcePublicBoardIds,
      problem: `${variant.id}: bound catalogue board is unavailable or has another owner/configuration`,
    };
  if (bound && bound.isPublic === false && bound.canEdit === true) return { board: bound, sourcePublicBoardIds };
  if (bound && (explicitId || bound.isPublic !== true || typeof bound.canEdit !== 'boolean'))
    return {
      sourcePublicBoardIds,
      problem:
        catalogueBoardProof(variant, bound, options.accountUserId) +
        '; binding requires an editable private board; source preserved',
    };
  const privateCandidates = candidates.filter((board) => board.isPublic === false && board.canEdit === true);
  const namedQa = privateCandidates.filter((board) => board.name === screenshotCatalogueName(variant));
  const matches = namedQa.length ? namedQa : privateCandidates;
  if (matches.length === 1) return { board: matches[0], sourcePublicBoardIds };
  if (matches.length > 1)
    return {
      sourcePublicBoardIds,
      problem: `${variant.id}: multiple editable private catalogue boards require an explicit UUID binding`,
    };
  const unverified = candidates.find(
    (board) => typeof board.isPublic !== 'boolean' || typeof board.canEdit !== 'boolean' || board.isPublic === false,
  );
  if (unverified)
    return {
      sourcePublicBoardIds,
      problem:
        catalogueBoardProof(variant, unverified, options.accountUserId) +
        '; catalogue permissions cannot be verified; no QA board created',
    };
  return { sourcePublicBoardIds };
}

export async function ensureScreenshotCatalogueName(
  options: BootstrapOptions,
  variant: CppBoard,
  board: BootstrapBoard,
  actions: string[],
): Promise<BootstrapBoard> {
  if (variant.family === 'spray' || !/^test user(?:['’]s)?\b/i.test(board.name)) return board;
  if (
    board.ownerId !== options.accountUserId ||
    !board.canEdit ||
    board.isPublic !== false ||
    !boardMatchesConfig(board, variant)
  )
    throw new Error(`${variant.id}: generated QA board name is not an editable private owned configuration`);
  const name = screenshotCatalogueName(variant);
  actions.push(`${variant.id}: set own private QA board name to ${name}`);
  if (!options.apply) return board;
  await options.transport.request(UPDATE_BOARD, { input: { boardUuid: board.uuid, name } });
  const after = (await listOwnedBoards(options)).find((candidate) => candidate.uuid === board.uuid);
  if (
    !after ||
    after.name !== name ||
    after.ownerId !== board.ownerId ||
    !after.canEdit ||
    after.isPublic !== false ||
    !boardMatchesConfig(after, variant) ||
    after.layoutId !== board.layoutId ||
    after.sizeId !== board.sizeId ||
    after.angle !== board.angle ||
    after.setIds !== board.setIds
  )
    throw new Error(
      `${variant.id}: name-only QA board update failed fresh ownership/configuration/privacy verification`,
    );
  return after;
}

export async function ensureScreenshotProfileName(
  options: BootstrapOptions,
  actions: string[],
): Promise<string | null> {
  type Profile = { id: string; displayName: string | null; avatarUrl: string | null };
  const before = (await options.transport.request<{ profile: Profile | null }>(CPP_BOOTSTRAP_PROFILE_QUERY)).profile;
  if (!before || before.id !== options.accountUserId)
    return 'screenshot profile is not the authenticated checkpoint owner';
  if (before.displayName === 'Liz') return null;
  actions.push('screenshot account: set own display name to Liz');
  if (!options.apply) return 'screenshot display-name update requires --apply';
  const updated = await options.transport.request<{ updateProfile: Profile }>(UPDATE_PROFILE, {
    input: { displayName: 'Liz' },
  });
  const after = (await options.transport.request<{ profile: Profile | null }>(CPP_BOOTSTRAP_PROFILE_QUERY)).profile;
  if (
    updated.updateProfile.id !== before.id ||
    !after ||
    after.id !== before.id ||
    after.displayName !== 'Liz' ||
    after.avatarUrl !== before.avatarUrl
  )
    return 'screenshot account display-name update failed fresh owner/name/avatar verification';
  return null;
}

export function boardMatchesConfig(board: BootstrapBoard, variant: CppBoard): boolean {
  const sortedSets = (sets: readonly number[]) => [...sets].sort((left, right) => left - right).join(',');
  return (
    board.boardType === variant.boardType &&
    (variant.family === 'spray' ||
      (board.layoutId === variant.layoutId &&
        board.sizeId === variant.sizeId &&
        sortedSets(board.setIds.split(',').map(Number)) === sortedSets(variant.setIds ?? []) &&
        board.angle === variant.angle))
  );
}

/** Compare the actual owned board, allowing only equivalent set ordering/path spelling. */
export function sessionPathMatchesBoard(path: string, board: BootstrapBoard): boolean {
  const segments = path.split('/').filter(Boolean);
  const named = parseNamedBoardPath(path);
  if (named) return segments.length === 3 && named.slug === board.slug && named.angle === board.angle;
  const tuple = parseBoardPath(path);
  const sortedSets = (sets: string) =>
    sets
      .split(',')
      .map(Number)
      .sort((left, right) => left - right)
      .join(',');
  return (
    !!tuple &&
    segments.length === 5 &&
    tuple.boardName === board.boardType &&
    tuple.layoutId === board.layoutId &&
    tuple.sizeId === board.sizeId &&
    sortedSets(tuple.setIds) === sortedSets(board.setIds) &&
    tuple.angle === board.angle
  );
}

/** A config tuple cannot distinguish two owned catalogue rows with the same geometry. */
function namedSessionBoardPath(board: BootstrapBoard): string | undefined {
  if (!board.slug || board.slug.trim() !== board.slug) return undefined;
  const path = `/b/${board.slug}/${board.angle}`;
  const parsed = parseNamedBoardPath(path);
  return parsed &&
    path.split('/').filter(Boolean).length === 3 &&
    parsed.slug === board.slug &&
    parsed.angle === board.angle
    ? path
    : undefined;
}

async function verifyNamedSessionBoard(
  options: BootstrapOptions,
  board: BootstrapBoard,
  variant: CppBoard,
): Promise<string | null> {
  if (!namedSessionBoardPath(board)) return 'PRIMARY_BOARD_SLUG_UNAVAILABLE';
  const result = await options.transport.request<{ boardBySlug: BootstrapBoard | null }>(GET_BOARD_BY_SLUG, {
    slug: board.slug,
  });
  const resolved = result.boardBySlug;
  if (!resolved || resolved.uuid !== board.uuid || resolved.slug !== board.slug || resolved.boardId !== board.boardId)
    return 'PRIMARY_BOARD_SLUG_IDENTITY_MISMATCH';
  if (resolved.ownerId !== options.accountUserId || resolved.canEdit !== true || resolved.isPublic !== false)
    return 'PRIMARY_BOARD_SLUG_NOT_PRIVATE_OWNED';
  const selectedConfigPath = `/${board.boardType}/${board.layoutId}/${board.sizeId}/${board.setIds}/${board.angle}`;
  if (!boardMatchesConfig(resolved, variant) || !sessionPathMatchesBoard(selectedConfigPath, resolved))
    return 'PRIMARY_BOARD_SLUG_CONFIGURATION_MISMATCH';
  return null;
}

function diagnosticSessionPath(path: string | undefined): string {
  if (!path) return 'not_returned';
  const named = parseNamedBoardPath(path);
  if (named) return `named_board/angle=${named.angle ?? 'missing'}`;
  const tuple = parseBoardPath(path);
  if (
    !tuple ||
    !['kilter', 'tension', 'moonboard', 'spray', 'woods'].includes(tuple.boardName) ||
    !/^\d+(,\d+)*$/.test(tuple.setIds)
  )
    return 'unsupported_path';
  return `${tuple.boardName}/${tuple.layoutId}/${tuple.sizeId}/${tuple.setIds}/${tuple.angle ?? 'missing'}`;
}

async function readSessionBinding(options: BootstrapOptions, sessionId: string) {
  const owned = await options.transport.request<{ mySessions: BootstrapSession[] }>(OWNED_SESSIONS_QUERY);
  // The recent owned listing and live presence are separate from durable lifecycle.
  const status = await options.transport.request<{ sessionStatus: string | null }>(SESSION_STATUS_QUERY, { sessionId });
  return { session: owned.mySessions.find((entry) => entry.id === sessionId), status: status.sessionStatus };
}

function sessionBindingProblem(
  session: BootstrapSession | undefined,
  status: string | null,
  options: BootstrapOptions,
  board: BootstrapBoard,
): string | null {
  if (!session) return 'NOT_IN_OWNED_LIST';
  if (session.createdByUserId !== options.accountUserId) return 'OWNER_MISMATCH';
  if (!sessionPathMatchesBoard(session.boardPath, board)) return 'BOARD_CONFIGURATION_MISMATCH';
  if (session.isPublic !== false) return 'SESSION_NOT_PRIVATE';
  if (status === 'ended') return 'SESSION_ENDED';
  if (status !== 'active') return 'SESSION_UNAVAILABLE';
  if (session.isPermanent !== true) return 'SESSION_NOT_PERMANENT';
  if (!parseNamedBoardPath(session.boardPath)) return 'SESSION_BOARD_IDENTITY_UNBOUND';
  return null;
}

function sessionReplacementReason(
  options: BootstrapOptions,
  sessionId: string,
  binding: Awaited<ReturnType<typeof readSessionBinding>>,
  reason: string,
): 'ended-checkpoint' | 'nonpermanent' | 'board-identity' | undefined {
  if (options.checkpoint.sessions[options.target] !== sessionId) return undefined;
  if (binding.status === 'ended' && (reason === 'SESSION_ENDED' || reason === 'NOT_IN_OWNED_LIST'))
    return 'ended-checkpoint';
  if (reason === 'SESSION_NOT_PERMANENT') return 'nonpermanent';
  if (reason === 'SESSION_BOARD_IDENTITY_UNBOUND') return 'board-identity';
  return undefined;
}

function describeSessionBinding(
  session: BootstrapSession | undefined,
  status: string | null,
  expected: string,
  reason: string,
): string {
  const lifecycle = status === 'active' || status === 'ended' ? status : status === null ? 'missing' : 'unknown';
  return `reason=${reason}, lifecycle=${lifecycle}, permanent=${session ? String(session.isPermanent === true) : 'not_returned'}, expected=${diagnosticSessionPath(expected)}, actual=${diagnosticSessionPath(session?.boardPath)}`;
}

/** Select an actual row that remains a native representative in every device timezone. */
function ascentMatchesPrimaryGeometry(item: BootstrapAscent, board: BootstrapBoard): boolean {
  return (
    item.boardType === board.boardType &&
    item.layoutId === board.layoutId &&
    item.angle === board.angle &&
    item.renderBoard?.sizeId === board.sizeId &&
    [...item.renderBoard.setIds].sort((left, right) => left - right).join(',') ===
      board.setIds
        .split(',')
        .map(Number)
        .sort((left, right) => left - right)
        .join(',')
  );
}

export function selectCppLogbookAscent(
  groups: readonly { items: readonly BootstrapAscent[] }[],
  board: BootstrapBoard,
): BootstrapAscent | undefined {
  const buckets = new Map<string, BootstrapAscent[]>();
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) {
      if (seen.has(item.uuid)) continue;
      seen.add(item.uuid);
      const key = `${item.climbUuid}|${item.angle}|${item.isMirror}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }
  }
  // Native splits these supersets by LOCAL day before using the same picker.
  // A best entry in the larger set is also best in its local-day subset. Do
  // not prefilter geometry: a preferred entry on another configuration must
  // not be silently replaced with a primary-board attempt that native hides.
  const representatives = [...buckets.values()].map((items) => pickBestGroupEntry(items));
  representatives.sort((left, right) => right.climbedAt.localeCompare(left.climbedAt));
  return representatives.find(
    (item) =>
      isCppAscentId(item.uuid) &&
      item.climbUuid?.trim() &&
      item.climbName?.trim() &&
      item.climbedAt &&
      ascentMatchesPrimaryGeometry(item, board),
  );
}

async function readCppLogbookAscent(options: BootstrapOptions, board: BootstrapBoard) {
  const grouped = await options.transport.request<{
    userGroupedAscentsFeed: { groups: Array<{ items: BootstrapAscent[] }> };
  }>(GET_USER_GROUPED_ASCENTS_FEED, {
    userId: options.accountUserId,
    input: {
      ...toAscentFeedInput({
        filters: DEFAULT_LOGBOOK_FILTERS,
        sort: DEFAULT_LOGBOOK_SORT,
        name: '',
        boardTypes: [board.boardType],
      }),
      limit: 20,
      offset: 0,
    },
  });
  return {
    ascent: selectCppLogbookAscent(grouped.userGroupedAscentsFeed.groups, board),
    primaryEntries: grouped.userGroupedAscentsFeed.groups
      .flatMap((group) => group.items)
      .filter((item) => ascentMatchesPrimaryGeometry(item, board)),
  };
}

/** JPEG generations differ; compare oriented, downsized real pixels rather than pretending byte hashes match. */
export async function photosMatch(source: Buffer, stored: Buffer): Promise<boolean> {
  const sourceImage = sharp(source).rotate();
  const storedImage = sharp(stored).rotate();
  const sourceDimensions = await sourceImage.metadata();
  const storedDimensions = await storedImage.metadata();
  const orientedSourceWidth = sourceDimensions.autoOrient?.width ?? sourceDimensions.width;
  const orientedSourceHeight = sourceDimensions.autoOrient?.height ?? sourceDimensions.height;
  const orientedStoredWidth = storedDimensions.autoOrient?.width ?? storedDimensions.width;
  const orientedStoredHeight = storedDimensions.autoOrient?.height ?? storedDimensions.height;
  if (!orientedSourceWidth || !orientedSourceHeight || !orientedStoredWidth || !orientedStoredHeight) return false;
  if (Math.abs(orientedSourceWidth / orientedSourceHeight - orientedStoredWidth / orientedStoredHeight) > 0.01)
    return false;
  const [sourcePixels, storedPixels] = await Promise.all([
    sourceImage.resize(256, 256, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer(),
    storedImage.resize(256, 256, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer(),
  ]);
  let absoluteDifference = 0;
  for (let index = 0; index < sourcePixels.length; index++)
    absoluteDifference += Math.abs(sourcePixels[index] - storedPixels[index]);
  return sourcePixels.length === storedPixels.length && absoluteDifference / sourcePixels.length < 6;
}

function localized(namespace: string, key: string): Record<(typeof LOCALES)[number], string> {
  return Object.fromEntries(
    LOCALES.map((locale) => {
      let candidate: unknown = JSON.parse(
        readFileSync(resolve(ROOT, 'packages/shared/i18n/locales', locale, `${namespace}.json`), 'utf8'),
      );
      for (const part of key.split('.')) {
        if (!candidate || typeof candidate !== 'object')
          throw new Error(`Missing readiness key ${locale}/${namespace}/${key}`);
        candidate = (candidate as Record<string, unknown>)[part];
      }
      if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('{{'))
        throw new Error(`Invalid readiness key ${locale}/${namespace}/${key}`);
      return [locale, candidate];
    }),
  ) as Record<(typeof LOCALES)[number], string>;
}

async function listOwnedBoards(options: BootstrapOptions): Promise<BootstrapBoard[]> {
  const boards: BootstrapBoard[] = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const result = await options.transport.request<{ myBoards: { boards: BootstrapBoard[]; hasMore: boolean } }>(
      GET_MY_BOARDS,
      { input: { offset, limit: 50, includeUnfinishedSprayWalls: true } },
    );
    boards.push(...result.myBoards.boards.filter((board) => board.ownerId === options.accountUserId));
    if (!result.myBoards.hasMore) return boards;
  }
  throw new Error('Screenshot account has over 1000 boards; refusing incomplete ownership discovery');
}

export async function ensureSprayPhoto(
  options: BootstrapOptions,
  variant: CppBoard,
  initialWall: Wall,
  actions: string[],
): Promise<string | null> {
  const refreshed = await options.transport.request<{ sprayWall: Wall | null }>(GET_SPRAY_WALL_WITH_VERSIONS, {
    uuid: initialWall.uuid,
  });
  const wall = refreshed.sprayWall;
  if (!wall || wall.uuid !== initialWall.uuid || wall.board.ownerId !== options.accountUserId)
    return `${variant.id}: spray-wall ownership changed or wall became unavailable`;
  const source = readFileSync(resolve(ROOT, variant.photo!));
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const saved = options.checkpoint.boards[variant.id];
  if (saved?.sourceSha256 && saved.sourceSha256 !== sourceSha256)
    return `${variant.id}: checkpoint source photo changed; retain the existing wall and reconcile its provenance`;
  if (wall.currentVersion?.photo) {
    const stored = await options.transport.bytes(wall.currentVersion.photo.url);
    const storedPhotoSha256 = createHash('sha256').update(stored).digest('hex');
    const pixelVerified = await photosMatch(source, stored);
    const previouslyAccepted =
      saved?.provenance === 'visually-accepted' && saved.storedPhotoSha256 === storedPhotoSha256;
    const explicitlyAccepted =
      options.acceptSourceBindings &&
      options.bindings?.[variant.id] === wall.uuid &&
      options.acceptedSourcePhotoSha256?.[variant.id] === storedPhotoSha256;
    if (!pixelVerified && !previouslyAccepted && !explicitlyAccepted)
      return `${variant.id}: published photo differs from original; visually verify this wall and use its explicit --bindings with --accept-source-bindings and --accepted-source-hashes`;
    if (wall.holdCount <= 0) return `${variant.id}: published wall contains no real detected or manually placed holds`;
    if (options.apply) {
      options.checkpoint.boards[variant.id] = {
        uuid: wall.uuid,
        sourceSha256,
        storedPhotoSha256,
        provenance: pixelVerified ? 'pixel-verified' : 'visually-accepted',
        versionId: wall.currentVersion.id,
      };
      options.saveCheckpoint(options.checkpoint);
    }
    return null;
  }
  if (!options.apply) {
    actions.push(`${variant.id}: upload original photo, detect holds, publish the resulting unlisted wall`);
    return `${variant.id}: photo import requires --apply`;
  }
  const details = await options.transport.request<{ sprayWall: Wall }>(GET_SPRAY_WALL_WITH_VERSIONS, {
    uuid: wall.uuid,
  });
  let version = details.sprayWall.versions?.find((candidate) => candidate.status === 'DRAFT');
  if (version && saved?.versionId !== version.id)
    return `${variant.id}: existing draft is not in this bootstrap checkpoint; review it manually`;
  if (!version) {
    let photoId = saved?.photoId;
    if (!photoId) {
      const uploaded = await options.transport.upload(wall.uuid, source, variant.photo!.split('/').pop()!);
      photoId = uploaded.photoId;
      options.checkpoint.boards[variant.id] = { uuid: wall.uuid, sourceSha256, photoId };
      options.saveCheckpoint(options.checkpoint);
    }
    const created = await options.transport.request<{ createSprayWallVersion: WallVersion }>(
      CREATE_SPRAY_WALL_VERSION,
      { input: { wallUuid: wall.uuid, photoId } },
    );
    version = created.createSprayWallVersion;
    options.checkpoint.boards[variant.id] = { uuid: wall.uuid, sourceSha256, photoId, versionId: version.id };
    options.saveCheckpoint(options.checkpoint);
  }
  if (!version.photo || !(await photosMatch(source, await options.transport.bytes(version.photo.url))))
    return `${variant.id}: draft photo differs from original`;
  let detection = (
    await options.transport.request<{ sprayWallDetectionForVersion: SprayDetectionView | null }>(GET_SPRAY_DETECTION, {
      wallUuid: wall.uuid,
      versionId: version.id,
    })
  ).sprayWallDetectionForVersion;
  if (!detection)
    detection = (
      await options.transport.request<{ requestSprayWallDetection: SprayDetectionView }>(REQUEST_SPRAY_DETECTION, {
        input: { wallUuid: wall.uuid, versionId: version.id },
      })
    ).requestSprayWallDetection;
  const deadline = Date.now() + (options.detectionWaitMs ?? 15 * 60_000);
  while (['pending', 'running'].includes(detection.status) && Date.now() < deadline) {
    await (options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds))))(5000);
    const status = await options.transport.request<{ sprayWallDetectionForVersion: SprayDetectionView | null }>(
      GET_SPRAY_DETECTION,
      { wallUuid: wall.uuid, versionId: version.id },
    );
    if (!status.sprayWallDetectionForVersion) return `${variant.id}: recognition job disappeared; checkpoint retained`;
    detection = status.sprayWallDetectionForVersion;
  }
  if (detection.status !== 'done' || !detection.result?.candidates.length)
    return `${variant.id}: recognition ${detection.status} (${detection.error ?? 'no result yet'}); checkpoint retained for resume`;
  if (detection.result.width !== version.photo.width || detection.result.height !== version.photo.height)
    return `${variant.id}: detection and photo dimensions differ; refusing guessed geometry`;
  const render = await options.transport.request<{ sprayWallRenderData: { holds: Array<{ id: number }> } }>(
    GET_SPRAY_WALL_DRAFT_RENDER_DATA,
    { uuid: wall.uuid, version: version.number },
  );
  if (render.sprayWallRenderData.holds.length === 0) {
    const holds = detection.result.candidates.map((candidate) => {
      const mapped = mapPhotoHoldToCanonical(version!.homography, candidate);
      if (!mapped) throw new Error(`${variant.id}: detector produced unusable canonical geometry`);
      return { ...mapped, source: 'AUTO', confidence: candidate.confidence };
    });
    await options.transport.request(UPSERT_SPRAY_WALL_HOLDS, {
      input: { wallUuid: wall.uuid, versionId: version.id, holds },
    });
  }
  await options.transport.request(PUBLISH_SPRAY_WALL_VERSION, {
    input: { wallUuid: wall.uuid, versionId: version.id },
  });
  actions.push(`${variant.id}: published actual supplied photo and detected holds`);
  return null;
}

/** Verify the supplied wall before applying the user-approved, name-only metadata change. */
export async function ensureSprayBoardName(
  options: BootstrapOptions,
  variant: CppBoard,
  board: BootstrapBoard,
  initialWall: Wall,
  actions: string[],
): Promise<{ board: BootstrapBoard; problem: string | null }> {
  const photoProblem = await ensureSprayPhoto(options, variant, initialWall, actions);
  if (photoProblem) return { board, problem: photoProblem };
  const before = (
    await options.transport.request<{ sprayWall: Wall | null }>(GET_SPRAY_WALL_WITH_VERSIONS, { uuid: board.uuid })
  ).sprayWall;
  if (
    !before ||
    before.uuid !== board.uuid ||
    before.board.uuid !== board.uuid ||
    before.board.ownerId !== options.accountUserId
  )
    return { board, problem: `${variant.id}: spray-wall ownership changed before name verification` };
  if (
    before.board.name === variant.selector &&
    board.name === variant.selector &&
    board.layoutName === variant.selector &&
    board.sizeName === variant.selector
  )
    return { board, problem: null };
  if (
    board.uuid !== initialWall.uuid ||
    board.ownerId !== options.accountUserId ||
    board.isPublic !== false ||
    !board.canEdit ||
    before.board.isPublic !== false ||
    !before.board.canEdit
  )
    return { board, problem: `${variant.id}: renaming requires an owned, editable private spray wall` };
  actions.push(`${variant.id}: rename verified private wall to ${variant.selector}`);
  if (!options.apply) return { board, problem: `${variant.id}: wall-name update requires --apply` };

  // Publishing a newly imported wall leaves the original checkpoint at the draft stage.
  // Reverify its actual published bytes before any metadata update, as for existing walls.
  const publishedProblem = await ensureSprayPhoto(options, variant, before, actions);
  if (publishedProblem) return { board, problem: publishedProblem };
  const verified = options.checkpoint.boards[variant.id];
  if (
    before.currentVersion?.status !== 'PUBLISHED' ||
    !before.currentVersion.photo ||
    before.holdCount <= 0 ||
    verified?.uuid !== board.uuid ||
    verified.versionId !== before.currentVersion.id ||
    !verified.storedPhotoSha256 ||
    createHash('sha256')
      .update(await options.transport.bytes(before.currentVersion.photo.url))
      .digest('hex') !== verified.storedPhotoSha256
  )
    return { board, problem: `${variant.id}: published photo or version changed before renaming` };

  await options.transport.request(UPDATE_SPRAY_WALL, { input: { uuid: board.uuid, name: variant.selector } });
  let renamed = (await listOwnedBoards(options)).find((candidate) => candidate.uuid === board.uuid);
  // Older backend deployments may leave the social-board label stale. Both
  // labels must agree before native capture; UUID/configuration remain fixed.
  if (
    renamed?.ownerId === options.accountUserId &&
    renamed.isPublic === false &&
    renamed.canEdit &&
    renamed.name !== variant.selector
  ) {
    await options.transport.request(UPDATE_BOARD, { input: { boardUuid: board.uuid, name: variant.selector } });
    renamed = (await listOwnedBoards(options)).find((candidate) => candidate.uuid === board.uuid);
  }
  const after = (
    await options.transport.request<{ sprayWall: Wall | null }>(GET_SPRAY_WALL_WITH_VERSIONS, { uuid: board.uuid })
  ).sprayWall;
  const geometry = (candidate: BootstrapBoard) => [
    candidate.boardType,
    candidate.layoutId,
    candidate.sizeId,
    candidate.setIds,
    candidate.angle,
  ];
  if (
    !renamed ||
    !after ||
    after.uuid !== board.uuid ||
    after.board.uuid !== board.uuid ||
    renamed.ownerId !== options.accountUserId ||
    after.board.ownerId !== options.accountUserId ||
    renamed.isPublic !== false ||
    after.board.isPublic !== false ||
    renamed.name !== variant.selector ||
    renamed.layoutName !== variant.selector ||
    renamed.sizeName !== variant.selector ||
    after.board.name !== variant.selector ||
    JSON.stringify(geometry(renamed)) !== JSON.stringify(geometry(board)) ||
    JSON.stringify(geometry(after.board)) !== JSON.stringify(geometry(before.board)) ||
    after.holdCount !== before.holdCount ||
    after.currentVersion?.id !== before.currentVersion.id ||
    after.currentVersion.status !== before.currentVersion.status ||
    JSON.stringify(after.currentVersion.homography) !== JSON.stringify(before.currentVersion.homography) ||
    after.currentVersion.photo?.width !== before.currentVersion.photo.width ||
    after.currentVersion.photo?.height !== before.currentVersion.photo.height ||
    !after.currentVersion.photo ||
    createHash('sha256')
      .update(await options.transport.bytes(after.currentVersion.photo.url))
      .digest('hex') !== verified.storedPhotoSha256
  )
    return { board, problem: `${variant.id}: name update failed catalogue or unchanged photo/geometry verification` };
  return { board: renamed, problem: null };
}

export async function bootstrapCppScenario(options: BootstrapOptions): Promise<BootstrapResult> {
  if (
    options.checkpoint.version !== 1 ||
    options.checkpoint.accountUserId !== options.accountUserId ||
    options.checkpoint.upstream !== options.upstream
  )
    throw new Error('CPP checkpoint belongs to another account or backend');
  const page = readCppPage(options.target);
  const variants = [...page.heroBoards, ...page.otherBoards];
  const actions: string[] = [];
  const blockers: string[] = [];
  let owned = await listOwnedBoards(options);
  let walls = (await options.transport.request<{ mySprayWalls: Wall[] }>(GET_MY_SPRAY_WALLS)).mySprayWalls;
  const sprayVariants = variants.filter((variant) => variant.family === 'spray');
  if (sprayVariants.length) {
    const lifecycle = await options.transport.request<{ mySprayWalls: SprayWallLifecycleRow[] }>(
      GET_MY_SPRAY_WALL_LIFECYCLE,
    );
    const missingVariants = sprayVariants.filter((variant) => {
      const boundId = options.bindings?.[variant.id] ?? options.checkpoint.boards[variant.id]?.uuid;
      // A supplied but unavailable binding is handled by the ordinary identity guard;
      // it never authorizes creating a replacement wall.
      if (boundId) return false;
      return !owned.some((board) => boardMatchesConfig(board, variant) && board.name === variant.selector);
    });
    if (lifecycle.mySprayWalls.some((wall) => wall.archivedAt !== null && typeof wall.archivedAt !== 'string')) {
      return {
        target: options.target,
        boards: [],
        actions: [],
        blockers: [
          'spray: live-wall capacity cannot be verified because lifecycle archive status was not returned; no demo data was created',
        ],
      };
    }
    const activeCount = new Set(
      lifecycle.mySprayWalls.filter((wall) => wall.archivedAt === null).map((wall) => wall.uuid),
    ).size;
    if (missingVariants.length > 0 && activeCount + missingVariants.length > MAX_SPRAY_WALLS_PER_USER) {
      return {
        target: options.target,
        boards: [],
        actions: [],
        blockers: [
          `spray: account has ${activeCount} active walls; ${missingVariants.length} additional walls (${missingVariants.map((variant) => variant.selector).join(', ')}) would require ${activeCount + missingVariants.length} slots, exceeding the ${MAX_SPRAY_WALLS_PER_USER}-wall cap. No demo data was created. Use another authorized screenshot account or explicitly approve changing an existing demo wall; existing walls will not be deleted or repurposed automatically.`,
        ],
      };
    }
  }
  const catalogueProblems = variants
    .filter((variant) => variant.family !== 'spray')
    .flatMap((variant) => {
      const selectedCatalogue = selectScreenshotCatalogueBoard(options, variant, owned);
      return selectedCatalogue.problem ? [selectedCatalogue.problem] : [];
    });
  if (catalogueProblems.length) return { target: options.target, boards: [], actions: [], blockers: catalogueProblems };
  const primarySelection =
    page.primaryBoard.family !== 'spray'
      ? selectScreenshotCatalogueBoard(options, page.primaryBoard, owned).board
      : owned.find(
          (board) =>
            board.uuid ===
              (options.bindings?.[page.primaryBoard.id] ?? options.checkpoint.boards[page.primaryBoard.id]?.uuid) &&
            board.ownerId === options.accountUserId &&
            boardMatchesConfig(board, page.primaryBoard),
        );
  if (primarySelection) {
    const problem = await verifyNamedSessionBoard(options, primarySelection, page.primaryBoard);
    if (problem)
      return {
        target: options.target,
        boards: [],
        actions: [],
        blockers: [`${options.target}: ${problem}; no account metadata changed`],
      };
  }
  const savedSessionId = options.checkpoint.sessions[options.target];
  if (savedSessionId) {
    // Check saved scope before profile, board-name, photo, or example-tick writes.
    // A legacy tuple can migrate only after proving its owner/private/config scope.
    const probe =
      primarySelection ??
      owned.find((board) => board.ownerId === options.accountUserId && boardMatchesConfig(board, page.primaryBoard));
    const binding = await readSessionBinding(options, savedSessionId);
    const reason = probe
      ? sessionBindingProblem(binding.session, binding.status, options, probe)
      : 'PRIMARY_BOARD_UNAVAILABLE';
    const absentEnded = !binding.session && binding.status === 'ended';
    if (reason && !absentEnded && !sessionReplacementReason(options, savedSessionId, binding, reason))
      return {
        target: options.target,
        boards: [],
        actions: [],
        blockers: [
          `${options.target}: saved session binding rejected (${describeSessionBinding(binding.session, binding.status, probe ? (namedSessionBoardPath(probe) ?? '') : '', reason)}); checkpoint retained and no replacement session created`,
        ],
      };
  }
  const profileProblem = await ensureScreenshotProfileName(options, actions);
  if (profileProblem) return { target: options.target, boards: [], actions, blockers: [profileProblem] };
  const selected = new Map<string, BootstrapBoard>();
  const boardReadyText: Record<string, string> = {};
  const boardPhotoSha256: Record<string, string> = {};
  const climbsByBoard = new Map<string, BootstrapClimb[]>();
  const boardHeroModes: Record<string, 'climb' | 'wall-editor'> = {};
  const boardClimbCounts: Record<string, number> = {};
  const boardReadyTextByLocale: Record<string, Record<(typeof LOCALES)[number], string>> = {};
  for (const variant of variants) {
    const boundId = options.bindings?.[variant.id] ?? options.checkpoint.boards[variant.id]?.uuid;
    let matches = owned.filter(
      (board) =>
        boardMatchesConfig(board, variant) &&
        (boundId ? board.uuid === boundId : variant.family !== 'spray' || board.name === variant.selector),
    );
    const catalogueSelection =
      variant.family !== 'spray' ? selectScreenshotCatalogueBoard(options, variant, owned) : undefined;
    if (catalogueSelection?.problem) {
      blockers.push(catalogueSelection.problem);
      continue;
    }
    if (catalogueSelection) matches = catalogueSelection.board ? [catalogueSelection.board] : [];
    if (variant.family === 'spray' && matches.length > 1) {
      const exactName = matches.filter((board) => board.name === variant.selector);
      if (exactName.length === 1) matches = exactName;
    }
    if (variant.family === 'spray' && (matches.length > 1 || (boundId && matches.length !== 1))) {
      blockers.push(`${variant.id}: binding is missing, ambiguous, or has another board configuration`);
      continue;
    }
    let board = matches[0];
    if (!board) {
      const name = variant.family === 'spray' ? variant.selector : screenshotCatalogueName(variant);
      actions.push(`${variant.id}: create private demo board (${name}); existing catalogue rows preserved`);
      if (!options.apply) {
        blockers.push(`${variant.id}: missing owned board; creation requires --apply`);
        continue;
      }
      if (variant.family === 'spray') {
        const created = await options.transport.request<{ createSprayWall: Wall }>(CREATE_SPRAY_WALL, {
          input: { name: variant.selector, angle: 40, isPublic: false, isUnlisted: true, hideLocation: true },
        });
        options.checkpoint.boards[variant.id] = { uuid: created.createSprayWall.uuid };
      } else {
        const created = await options.transport.request<{ createBoard: BootstrapBoard }>(CREATE_BOARD, {
          input: {
            name,
            boardType: variant.boardType,
            layoutId: variant.layoutId,
            sizeId: variant.sizeId,
            setIds: variant.setIds!.join(','),
            angle: variant.angle,
            isPublic: false,
            isUnlisted: true,
            isOwned: false,
            hideLocation: true,
            ...(catalogueSelection?.sourcePublicBoardIds.length ? { allowDuplicateConfig: true } : {}),
          },
        });
        options.checkpoint.boards[variant.id] = { uuid: created.createBoard.uuid, expectedCatalogueName: name };
        if (catalogueSelection?.sourcePublicBoardIds.length)
          options.checkpoint.catalogueSourceBoardIds = {
            ...options.checkpoint.catalogueSourceBoardIds,
            [variant.id]: [
              ...new Set([
                ...(options.checkpoint.catalogueSourceBoardIds?.[variant.id] ?? []),
                ...catalogueSelection.sourcePublicBoardIds,
              ]),
            ],
          };
      }
      options.saveCheckpoint(options.checkpoint);
      owned = await listOwnedBoards(options);
      board = owned.find((candidate) => candidate.uuid === options.checkpoint.boards[variant.id].uuid)!;
      if (!board || board.ownerId !== options.accountUserId || !boardMatchesConfig(board, variant))
        throw new Error(`${variant.id}: created board failed ownership/configuration verification`);
      if (variant.family !== 'spray' && (board.canEdit !== true || board.isPublic !== false || board.name !== name))
        throw new Error(
          catalogueBoardProof(variant, board, options.accountUserId) +
            `, nameMatchesExpected=${board.name === name}; newly created QA board failed private/editable/name verification`,
        );
      walls = (await options.transport.request<{ mySprayWalls: Wall[] }>(GET_MY_SPRAY_WALLS)).mySprayWalls;
    }
    if (variant.family !== 'spray' && options.apply) {
      const previousId = options.checkpoint.boards[variant.id]?.uuid;
      const pendingName = options.checkpoint.boards[variant.id]?.expectedCatalogueName;
      const previousSources = options.checkpoint.catalogueSourceBoardIds?.[variant.id] ?? [];
      const sources = [...new Set([...previousSources, ...(catalogueSelection?.sourcePublicBoardIds ?? [])])].sort();
      options.checkpoint.boards[variant.id] = { uuid: board.uuid };
      if (sources.length)
        options.checkpoint.catalogueSourceBoardIds = {
          ...options.checkpoint.catalogueSourceBoardIds,
          [variant.id]: sources,
        };
      if (pendingName || previousId !== board.uuid || sources.join(',') !== previousSources.join(','))
        options.saveCheckpoint(options.checkpoint);
    }
    if (variant.family === 'spray') {
      const wall = walls.find(
        (candidate) => candidate.uuid === board.uuid && candidate.board.ownerId === options.accountUserId,
      );
      if (!wall) {
        blockers.push(`${variant.id}: owned spray-wall entity not found`);
        continue;
      }
      const verified = await ensureSprayBoardName(options, variant, board, wall, actions);
      if (verified.problem) {
        blockers.push(verified.problem);
        continue;
      }
      board = verified.board;
      boardPhotoSha256[variant.id] = createHash('sha256')
        .update(readFileSync(resolve(ROOT, variant.photo!)))
        .digest('hex');
    }
    board = await ensureScreenshotCatalogueName(options, variant, board, actions);
    selected.set(variant.id, board);
    const result = await options.transport.request<{ searchClimbs: { climbs: BootstrapClimb[] } }>(SEARCH_CLIMBS, {
      input: {
        boardName: board.boardType,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
        page: 0,
        pageSize: 10,
        sortBy: 'ascents',
        sortOrder: 'desc',
        boulders: true,
        routes: false,
      },
    });
    const climbs = result.searchClimbs.climbs.filter(
      (climb) =>
        climb.name?.trim() && climb.frames && climb.boardType === board.boardType && climb.layoutId === board.layoutId,
    );
    climbsByBoard.set(board.uuid, climbs);
    boardClimbCounts[variant.id] = result.searchClimbs.climbs.length;
    if (climbs[0]) {
      boardReadyText[variant.id] = climbs[0].name;
      boardHeroModes[variant.id] = 'climb';
    } else if (
      variant.family === 'spray' &&
      variant.id !== page.primaryBoard.id &&
      result.searchClimbs.climbs.length === 0
    ) {
      const labels = localized('climbs', 'mobile.create.header.newClimb');
      boardReadyText[variant.id] = labels['en-US'];
      boardReadyTextByLocale[variant.id] = labels;
      boardHeroModes[variant.id] = 'wall-editor';
    } else blockers.push(`${variant.id}: no published, drawable real climb returned by SearchClimbs`);
  }
  const heroClimbs: Record<string, CppHeroClimb> = {};
  for (const trio of [page.heroBoards, page.otherBoards]) {
    const sources = trio.flatMap((variant) => {
      const board = selected.get(variant.id);
      return board && boardHeroModes[variant.id] === 'climb'
        ? [
            {
              variantId: variant.id,
              board,
              climbs: climbsByBoard.get(board.uuid) ?? [],
              requireBenchmark: options.target === 'moonboard' && variant.id === page.primaryBoard.id,
            },
          ]
        : [];
    });
    if (!sources.length) continue;
    const chosen = selectCppHeroClimbs(sources);
    if (!chosen)
      blockers.push(
        sources.some(
          (source) =>
            source.requireBenchmark &&
            !source.climbs
              .slice(0, 10)
              .some((climb) => Number(climb.benchmark_difficulty) > 0 && climb.statsAngle === source.board.angle),
        )
          ? `${options.target}: primary first ten real climbs have no benchmark at the captured angle; benchmark marketing requires verified evidence`
          : `${options.target}: first ten real climbs do not contain distinct drawable trio titles; no hero selection invented`,
      );
    else Object.assign(heroClimbs, chosen);
  }
  const primary = selected.get(page.primaryBoard.id);
  let scenario: ScreenshotCaptureScenario | undefined;
  if (primary) {
    const namedProblem = await verifyNamedSessionBoard(options, primary, page.primaryBoard);
    if (namedProblem)
      return {
        target: options.target,
        boards: [],
        actions,
        blockers: [...blockers, `${options.target}: ${namedProblem}; session and logbook untouched`],
      };
  }
  if (primary && climbsByBoard.get(primary.uuid)?.length) {
    const climbs = climbsByBoard.get(primary.uuid)!;
    let logbook = await readCppLogbookAscent(options, primary);
    let ascent = logbook.ascent;
    if (!ascent && options.apply && options.seedDemoContent && logbook.primaryEntries.length === 0) {
      const privacy = await options.transport.request<{
        privacySettings: { enabled: boolean; privacyRevision: number };
      }>(GET_PRIVACY_SETTINGS);
      if (!privacy.privacySettings.enabled)
        blockers.push(`${options.target}: private demo tick requires backend publication privacy support`);
      else {
        const previousDemoTick = options.checkpoint.demoTicks?.[options.target];
        const tickUuid = previousDemoTick ?? randomUUID();
        options.checkpoint.demoTicks = { ...options.checkpoint.demoTicks, [options.target]: tickUuid };
        options.saveCheckpoint(options.checkpoint);
        await options.transport.request(SAVE_TICK, {
          input: {
            uuid: tickUuid,
            boardType: primary.boardType,
            boardUuid: primary.uuid,
            climbUuid: climbs[0].uuid,
            angle: primary.angle,
            isMirror: false,
            status: 'attempt',
            attemptCount: 1,
            isBenchmark: false,
            comment: 'Demo project: example attempt.',
            climbedAt: new Date().toISOString(),
            layoutId: primary.layoutId,
            sizeId: primary.sizeId,
            setIds: primary.setIds,
            privacy: { audience: 'only_me', privacyRevision: privacy.privacySettings.privacyRevision },
          },
        });
        logbook = await readCppLogbookAscent(options, primary);
        ascent = logbook.ascent;
        actions.push(
          previousDemoTick
            ? `${options.target}: resumed checkpointed private example attempt ${tickUuid} through UUID-idempotent SaveTick`
            : `${options.target}: created one explicitly private illustrative attempt through SaveTick`,
        );
      }
    }
    if (!ascent) {
      const demoTick = options.checkpoint.demoTicks?.[options.target];
      blockers.push(
        demoTick
          ? `${options.target}: checkpointed demo attempt ${demoTick} has no guaranteed rendered representative in the first grouped family page; existing records and UUID retained`
          : logbook.primaryEntries.length > 0
            ? `${options.target}: primary logbook entries exist but have no guaranteed rendered representative in the first grouped family page; existing records preserved and no demo attempt added`
            : `${options.target}: primary configuration has no genuine rendered logbook representative in the first grouped family page; --apply --seed-demo-content can create an explicitly private example attempt`,
      );
    }
    const boardPath = namedSessionBoardPath(primary)!;
    let sessionId = options.checkpoint.sessions[options.target];
    let rejectedSession = false;
    let replacement: { sessionId: string; reason: 'ended-checkpoint' | 'nonpermanent' | 'board-identity' } | undefined;
    if (!sessionId) {
      const live = await options.transport.request<{
        boardLiveSessions: Array<{ sessionId: string; host: { userId: string } }>;
      }>(BOARD_LIVE_SESSIONS, { boardId: primary.boardId });
      sessionId = live.boardLiveSessions.find((session) => session.host.userId === options.accountUserId)?.sessionId;
    }
    if (sessionId) {
      const binding = await readSessionBinding(options, sessionId);
      const reason = sessionBindingProblem(binding.session, binding.status, options, primary);
      if (reason) {
        const replacementReason = sessionReplacementReason(options, sessionId, binding, reason);
        if (replacementReason && options.apply) {
          // An absent ended row cannot prove its old ownership or geometry.
          // The account/backend-bound checkpoint authorizes a fresh private
          // session; no operation touches or claims ownership of that old row.
          replacement = { sessionId, reason: replacementReason };
        } else {
          blockers.push(
            `${options.target}: saved session binding rejected (${describeSessionBinding(binding.session, binding.status, boardPath, reason)}); checkpoint retained and no replacement session created`,
          );
          rejectedSession = true;
        }
        sessionId = undefined;
      }
    }
    if (!sessionId && options.apply && !rejectedSession) {
      const created = await options.transport.request<{ createSession: { id: string } }>(CREATE_SESSION, {
        input: {
          boardPath,
          boardIds: [primary.boardId],
          latitude: 0,
          longitude: 0,
          name: `${{ kilter: 'Kilter', tension: 'Tension', moonboard: 'MoonBoard', spray: 'Spray wall' }[options.target]} crew`,
          audience: 'invite_only',
          isPublic: false,
          // This backend path persists permanence. Resource audience and board
          // access predicates keep discovery private; GPS coordinates are synthetic.
          discoverable: true,
          isPermanent: true,
        },
      });
      sessionId = created.createSession.id;
      options.checkpoint.sessions[options.target] = sessionId;
      if (replacement) {
        options.checkpoint.sessionReplacements = [
          ...(options.checkpoint.sessionReplacements ?? []),
          {
            target: options.target,
            previousSessionId: replacement.sessionId,
            newSessionId: sessionId,
            reason: replacement.reason,
          },
        ];
        actions.push(
          `${options.target}: replaced checkpoint ${replacement.reason} session ${replacement.sessionId} with private permanent session ${sessionId}; previous record unchanged`,
        );
      } else actions.push(`${options.target}: created a real private permanent session ${sessionId}`);
      options.saveCheckpoint(options.checkpoint);
      // The HTTP create response echoes inputs; verify persisted values instead.
      const binding = await readSessionBinding(options, sessionId);
      const reason = sessionBindingProblem(binding.session, binding.status, options, primary);
      if (reason) {
        blockers.push(
          `${options.target}: created session failed persisted verification (${describeSessionBinding(binding.session, binding.status, boardPath, reason)}); checkpoint retained and queue untouched`,
        );
        rejectedSession = true;
        sessionId = undefined;
      }
    }
    let queueClimbName: string | undefined;
    if (sessionId) {
      const identityProblem = await verifyNamedSessionBoard(options, primary, page.primaryBoard);
      if (identityProblem) {
        blockers.push(`${options.target}: ${identityProblem}; checkpoint retained and queue untouched`);
        rejectedSession = true;
        sessionId = undefined;
      }
    }
    if (sessionId && options.apply) {
      const queue = climbs.slice(0, 5).map((climb) => ({ uuid: randomUUID(), climb: queueClimb(climb) }));
      const snapshot = await options.transport.join({
        sessionId,
        boardPath,
        initialQueue: queue,
        initialCurrentClimb: queue[0],
        initializeEmpty: options.checkpoint.sessions[options.target] === sessionId,
      });
      const queued = snapshot.queue.find(
        (item) =>
          item.climb.name?.trim() &&
          item.climb.boardType === primary.boardType &&
          item.climb.layoutId === primary.layoutId &&
          item.climb.frames,
      );
      if (!queued)
        blockers.push(
          `${options.target}: actual shared session queue has no drawable primary-board climb; unrelated queues were preserved`,
        );
      else queueClimbName = queued.climb.name;
    } else if (sessionId)
      blockers.push(
        `${options.target}: persistent WebSocket queue verification requires --apply; read-only discovery does not change session membership`,
      );
    if (!sessionId && !rejectedSession)
      blockers.push(`${options.target}: no self-hosted primary-board session; creation requires --apply`);
    const firstClimb = climbs[0].name;
    const makeScene = (
      readyText: string,
      readyTextByLocale?: CppSceneCoverage['readyTextByLocale'],
    ): CppSceneCoverage => ({ boardId: primary.uuid, readyText, ...(readyTextByLocale ? { readyTextByLocale } : {}) });
    const searchLabels = localized('climbs', 'mobile.filter.title');
    const workoutLabels = localized('session', 'mobile.session.headerStart');
    const scenes: Record<string, CppSceneCoverage> = {
      search: makeScene(searchLabels['en-US'], searchLabels),
      logbook: { ...makeScene(ascent?.climbName ?? ''), ...(ascent ? { ascentId: ascent.uuid } : {}) },
      led: makeScene(firstClimb),
      queue: { ...makeScene(queueClimbName ?? ''), ...(sessionId ? { sessionId } : {}) },
      workout: makeScene(workoutLabels['en-US'], workoutLabels),
      status: { ...makeScene(firstClimb), climbId: climbs[0].uuid },
      island: makeScene(firstClimb),
    };
    const grades = (
      await options.transport.request<{ grades: Array<{ difficultyId: number; name: string }> }>(GET_GRADES, {
        boardName: primary.boardType,
      })
    ).grades;
    const stops = buildGradeRailStops(grades, 'v-grade', primary.boardType);
    const labels = new Set(
      climbs
        .slice(0, 10)
        .map((climb) => formatGrade(climb.difficulty, 'v-grade', primary.boardType))
        .filter(Boolean),
    );
    const supported = stops.filter((stop) => labels.has(stop.label));
    const lower = supported[0];
    const upper = supported[1] ?? lower;
    if (lower && upper) {
      const counted = await options.transport.request<{ searchClimbs: { totalCount: number } }>(SEARCH_CLIMBS_COUNT, {
        input: buildCountPreviewInput(
          { ...DEFAULT_FILTERS, minGrade: lower.minGradeId, maxGrade: upper.maxGradeId },
          {},
          {
            boardName: primary.boardType,
            layoutId: primary.layoutId,
            sizeId: primary.sizeId,
            setIds: primary.setIds,
            angle: primary.angle,
          },
          '',
        ),
      });
      if (!Number.isSafeInteger(counted.searchClimbs.totalCount) || counted.searchClimbs.totalCount < 1)
        blockers.push(`${options.target}: selected real grade rail bounds have no verified positive API count`);
      else
        scenes.search.gradeFilter = {
          minLabel: lower.label,
          ...(upper !== lower ? { maxLabel: upper.label } : {}),
          minGradeId: lower.minGradeId,
          maxGradeId: upper.maxGradeId,
          expectedCount: counted.searchClimbs.totalCount,
        };
    } else blockers.push(`${options.target}: genuine primary climb grades do not match available grade rail stops`);
    if (options.target === 'spray') {
      const projects = await options.transport.request<{ smartPlaylist: { climbs: ClimbInput[] } }>(
        GET_SMART_PLAYLIST,
        {
          input: {
            type: 'PROJECTS',
            userId: options.accountUserId,
            boardName: primary.boardType,
            boardUuid: primary.uuid,
            sizeId: primary.sizeId,
            angle: primary.angle,
            page: 0,
            pageSize: 10,
          },
        },
      );
      const project = projects.smartPlaylist.climbs.find(
        (climb) => climb.name?.trim() && climb.layoutId === primary.layoutId && climb.boardType === primary.boardType,
      );
      if (!project) blockers.push('spray: no real project in the primary-wall smart playlist');
      const settingLabels = localized('climbs', 'mobile.create.header.newClimb');
      scenes.led = makeScene(settingLabels['en-US'], settingLabels);
      scenes.status = { ...makeScene(project?.name ?? ''), ...(project ? { climbId: project.uuid } : {}) };
      const holdLabels = localized('boards', 'sprayMaintenance.publish');
      scenes.island = makeScene(holdLabels['en-US'], holdLabels);
    }
    const accessoryClimb = selectCppAccessoryClimb(primary, climbs, scenes.status.climbId!);
    if (!accessoryClimb)
      blockers.push(
        `${options.target}: first ten genuine primary-board climbs contain no different drawable accessory preview; no selection invented`,
      );
    if (!blockers.length && sessionId)
      scenario = {
        sharedSessionId: sessionId,
        boards: variants.map((variant) => selected.get(variant.id)!.name),
        cpp: {
          target: options.target,
          heroClimbs,
          accessoryClimb,
          boardReadyText,
          boardIds: Object.fromEntries(variants.map((variant) => [variant.id, selected.get(variant.id)!.uuid])),
          boardNames: Object.fromEntries(variants.map((variant) => [variant.id, selected.get(variant.id)!.name])),
          boardPhotoSha256,
          scenes,
          boardHeroModes,
          boardClimbCounts,
          boardReadyTextByLocale,
        },
      };
  }
  return {
    target: options.target,
    boards: variants.flatMap((variant) => {
      const board = selected.get(variant.id);
      return board ? [{ variantId: variant.id, uuid: board.uuid, selector: board.name }] : [];
    }),
    actions,
    blockers,
    ...(scenario ? { scenario } : {}),
  };
}

export function queueClimb(climb: ClimbInput): ClimbInput {
  const {
    uuid,
    name,
    setter_username,
    frames,
    angle,
    ascensionist_count,
    difficulty,
    difficulty_error,
    quality_average,
    stars,
    boardType,
    layoutId,
    description,
    framesCount,
    framesPace,
    boardseshDifficulty,
    boardseshConfidence,
    compatibleSizeIds,
    missingHoldCount,
    is_draft,
    is_no_match,
    characteristics,
    benchmark_difficulty,
    published_at,
  } = climb;
  if (
    [uuid, name, setter_username, frames, difficulty, difficulty_error, quality_average].some(
      (field) => typeof field !== 'string',
    ) ||
    ![angle, ascensionist_count, stars].every(Number.isFinite)
  )
    throw new Error('Catalogue climb cannot satisfy the actual ClimbInput contract; refusing invented fields');
  return {
    uuid,
    name,
    setter_username,
    frames,
    angle,
    ascensionist_count,
    difficulty,
    difficulty_error,
    quality_average,
    stars,
    boardType,
    layoutId,
    description,
    framesCount,
    framesPace,
    boardseshDifficulty,
    boardseshConfidence,
    compatibleSizeIds,
    missingHoldCount,
    is_draft,
    is_no_match,
    characteristics,
    benchmark_difficulty,
    published_at,
  };
}

export interface BootstrapGraphqlError {
  message?: string;
  extensions?: { code?: string };
}

/** Classify known failures without logging arbitrary server messages or variables. */
export function classifyBootstrapGraphqlError(error: BootstrapGraphqlError): string {
  const knownCodes = new Set([
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'BAD_USER_INPUT',
    'INVALID_INPUT',
    'GRAPHQL_VALIDATION_FAILED',
    'GRAPHQL_PARSE_FAILED',
    'INTERNAL_SERVER_ERROR',
    'RATE_LIMITED',
  ]);
  if (error.extensions?.code && knownCodes.has(error.extensions.code)) return error.extensions.code;
  if (error.message === 'Authentication required to perform this operation') return 'AUTHENTICATION_REQUIRED';
  if (/^Invalid (?:input|createSession input):/.test(error.message ?? '')) return 'INVALID_INPUT';
  if (/^(?:Cannot query field|Unknown argument|Unknown type|Variable .* got invalid value)/.test(error.message ?? ''))
    return 'GRAPHQL_VALIDATION_FAILED';
  return 'GRAPHQL_ERROR';
}

export async function createTransport(
  upstream: string,
  email: string,
  password: string,
): Promise<{ transport: BootstrapTransport; accountUserId: string }> {
  const backendOrigin = resolveBootstrapUpstream(upstream);
  const auth = await fetch(`${backendOrigin}/auth/native/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    redirect: 'error',
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!auth.ok) throw new Error(`Screenshot-account authentication failed (HTTP ${auth.status})`);
  const authenticated = (await auth.json()) as { jwt?: string };
  if (!authenticated.jwt) throw new Error('Native login did not return a JWT');
  const claims = JSON.parse(Buffer.from(authenticated.jwt.split('.')[1], 'base64url').toString()) as { sub?: string };
  if (!claims.sub) throw new Error('Native login did not identify the screenshot account');
  const jwt = authenticated.jwt;
  const transport: BootstrapTransport = {
    async request<T>(query: string, variables = {}): Promise<T> {
      const operationName = getOperationAST(parse(query))?.name?.value ?? 'unnamed operation';
      const response = await fetch(`${backendOrigin}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await response.json()) as { data?: T; errors?: BootstrapGraphqlError[] };
      if (!response.ok || body.errors?.length || !body.data)
        throw new Error(
          `CPP bootstrap ${operationName} failed (${response.status}, ${body.errors?.map(classifyBootstrapGraphqlError).join(',') ?? 'missing data'}); no credentials or server payload logged`,
        );
      return body.data;
    },
    async upload(wallUuid, bytes, filename) {
      const form = new FormData();
      form.append('wallUuid', wallUuid);
      form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), filename);
      const response = await fetch(`${backendOrigin}/api/spray-wall-photos`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const uploaded = (await response.json()) as { success?: boolean; photoId?: string };
      if (!response.ok || !uploaded.success || !uploaded.photoId)
        throw new Error(`CPP original-photo upload failed (HTTP ${response.status})`);
      return { photoId: uploaded.photoId };
    },
    async bytes(url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`CPP real wall photo unavailable (HTTP ${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },
    async join(variables) {
      return await new Promise<{ queue: ClimbQueueItemInput[]; currentClimbQueueItem?: ClimbQueueItemInput | null }>(
        (done, reject) => {
          const websocketUrl = new URL('/graphql', backendOrigin);
          websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(websocketUrl, 'graphql-transport-ws');
          let snapshot:
            | { sequence: number; queue: ClimbQueueItemInput[]; currentClimbQueueItem?: ClimbQueueItemInput | null }
            | undefined;
          let phase = 'join';
          const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error('CPP session initialization timed out'));
          }, 30_000);
          socket.on('open', () =>
            socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: jwt } })),
          );
          socket.on('message', (raw) => {
            const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            const message = JSON.parse(bytes.toString('utf8')) as {
              id?: string;
              type: string;
              payload?: {
                errors?: unknown[];
                data?: { joinSession?: { queueState?: typeof snapshot }; setQueue?: typeof snapshot };
              };
            };
            if (message.type === 'connection_ack') {
              const {
                initializeEmpty: _initializeEmpty,
                initialQueue: _initialQueue,
                initialCurrentClimb: _initialCurrentClimb,
                ...joinIdentity
              } = variables;
              socket.send(
                JSON.stringify({
                  id: 'join',
                  type: 'subscribe',
                  payload: { query: JOIN_SESSION, variables: joinIdentity },
                }),
              );
            } else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
            else if (message.type === 'error' || message.payload?.errors?.length) {
              clearTimeout(timer);
              socket.close();
              reject(new Error('CPP real session operation failed'));
            } else if (message.type === 'next')
              snapshot = message.payload?.data?.joinSession?.queueState ?? message.payload?.data?.setQueue;
            else if (message.type === 'complete' && message.id === phase) {
              if (!snapshot) {
                clearTimeout(timer);
                socket.close();
                reject(new Error('CPP real session operation returned no queue'));
              } else if (phase === 'join' && variables.initializeEmpty && snapshot.queue.length === 0) {
                phase = 'seed';
                socket.send(
                  JSON.stringify({
                    id: 'seed',
                    type: 'subscribe',
                    payload: {
                      query: SET_QUEUE_WITH_BASELINE,
                      variables: {
                        queue: variables.initialQueue,
                        currentClimbQueueItem: variables.initialCurrentClimb,
                        baselineSequence: snapshot.sequence,
                      },
                    },
                  }),
                );
              } else {
                clearTimeout(timer);
                socket.close();
                done(snapshot);
              }
            }
          });
          socket.on('error', () => {
            clearTimeout(timer);
            reject(new Error('CPP session WebSocket failed'));
          });
          socket.on('close', () => {
            clearTimeout(timer);
            reject(new Error('CPP session WebSocket closed before completion'));
          });
        },
      );
    },
  };
  const authenticatedProfile = await transport.request<{ profile: { id: string } | null }>(CPP_BOOTSTRAP_PROFILE_QUERY);
  if (!authenticatedProfile.profile || authenticatedProfile.profile.id !== claims.sub)
    throw new Error(
      'CPP bootstrap HTTP_AUTHENTICATION_FAILED: native login succeeded, but the authenticated GraphQL profile does not identify that same account',
    );
  return { transport, accountUserId: claims.sub };
}

/** The CLI and native capture share the same backend default. */
export function resolveBootstrapUpstream(upstreamOverride?: string): string {
  const candidate = upstreamOverride ?? process.env.SCREENSHOT_UPSTREAM ?? BACKEND_URL;
  const invalidOrigin = 'Backend must be an HTTPS origin or local HTTP origin without credentials';
  let parsedUpstream: URL;
  try {
    parsedUpstream = new URL(candidate);
  } catch {
    throw new Error(invalidOrigin);
  }
  if (
    !/^https?:\/\//i.test(candidate) ||
    /^https?:\/\/[^/?#]*@/i.test(candidate) ||
    parsedUpstream.username ||
    parsedUpstream.password ||
    candidate.includes('?') ||
    candidate.includes('#') ||
    parsedUpstream.pathname !== '/' ||
    !['https:', 'http:'].includes(parsedUpstream.protocol) ||
    (parsedUpstream.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedUpstream.hostname))
  )
    throw new Error(invalidOrigin);
  return parsedUpstream.origin;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const flags = new Map<string, string>();
  let apply = false;
  let seedDemoContent = false;
  let acceptSourceBindings = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--seed-demo-content') {
      seedDemoContent = true;
      continue;
    }
    if (args[index] === '--accept-source-bindings') {
      acceptSourceBindings = true;
      continue;
    }
    if (args[index] === '--apply') {
      if (apply) throw new Error('Duplicate --apply');
      apply = true;
      continue;
    }
    const flag = args[index];
    const argument = args[++index];
    if (
      !['--target', '--upstream', '--out', '--checkpoint', '--bindings', '--accepted-source-hashes'].includes(flag) ||
      !argument ||
      argument.startsWith('--') ||
      flags.has(flag)
    )
      throw new Error(
        'Usage: vp exec tsx scripts/bootstrap-cpp-scenario.ts --target kilter|tension|moonboard|spray [--apply] [--upstream https://backend] [--out scenario.json] [--checkpoint state.json] [--bindings board-id-to-uuid.json]',
      );
    flags.set(flag, argument);
  }
  if ((seedDemoContent || acceptSourceBindings) && !apply)
    throw new Error('Demo writes and accepted source binding require --apply');
  const target = flags.get('--target');
  if (!isCppTarget(target)) throw new Error('--target must identify exactly one CPP');
  const upstream = resolveBootstrapUpstream(flags.get('--upstream'));
  const email = process.env.SCREENSHOT_USER_EMAIL;
  const password = process.env.SCREENSHOT_USER_PASSWORD;
  if (!email || !password)
    throw new Error(
      'SCREENSHOT_USER_EMAIL and SCREENSHOT_USER_PASSWORD must identify the dedicated screenshot account',
    );
  const { transport, accountUserId } = await createTransport(upstream, email, password);
  const checkpointPath = resolve(flags.get('--checkpoint') ?? '.boardsesh/cpp-seed-state.json');
  const checkpoint: BootstrapCheckpoint = existsSync(checkpointPath)
    ? (JSON.parse(readFileSync(checkpointPath, 'utf8')) as BootstrapCheckpoint)
    : { version: 1, upstream, accountUserId, boards: {}, sessions: {} };
  const bindings = flags.has('--bindings')
    ? (JSON.parse(readFileSync(resolve(flags.get('--bindings')!), 'utf8')) as Record<string, string>)
    : undefined;
  const acceptedSourcePhotoSha256 = flags.has('--accepted-source-hashes')
    ? (JSON.parse(readFileSync(resolve(flags.get('--accepted-source-hashes')!), 'utf8')) as Record<string, string>)
    : undefined;
  if (acceptSourceBindings && (!bindings || !acceptedSourcePhotoSha256))
    throw new Error('--accept-source-bindings requires explicit --bindings and --accepted-source-hashes');
  const result = await bootstrapCppScenario({
    target,
    upstream,
    accountUserId,
    apply,
    checkpoint,
    transport,
    bindings,
    seedDemoContent,
    acceptSourceBindings,
    acceptedSourcePhotoSha256,
    saveCheckpoint: (updated) => {
      mkdirSync(dirname(checkpointPath), { recursive: true });
      const temporaryCheckpoint = `${checkpointPath}.${process.pid}.tmp`;
      writeFileSync(temporaryCheckpoint, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaryCheckpoint, checkpointPath);
    },
  });
  console.log(
    JSON.stringify(
      {
        target: result.target,
        mode: apply ? 'apply' : 'plan',
        boards: result.boards,
        actions: result.actions,
        blockers: result.blockers,
      },
      null,
      2,
    ),
  );
  if (result.scenario && flags.has('--out')) {
    const output = resolve(flags.get('--out')!);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result.scenario, null, 2)}\n`);
    console.log(`[cpp-bootstrap] Real scenario written: ${output}`);
  }
  if (result.blockers.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CPP bootstrap failed');
    process.exitCode = 1;
  });
