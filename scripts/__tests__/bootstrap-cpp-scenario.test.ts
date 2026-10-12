import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse, getOperationAST, buildSchema, validate } from 'graphql';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  boardMatchesConfig,
  sessionPathMatchesBoard,
  selectCppLogbookAscent,
  selectCppHeroClimbs,
  selectCppAccessoryClimb,
  ensureScreenshotProfileName,
  ensureScreenshotCatalogueName,
  selectScreenshotCatalogueBoard,
  bootstrapCppScenario,
  photosMatch,
  ensureSprayPhoto,
  ensureSprayBoardName,
  queueClimb,
  resolveBootstrapUpstream,
  classifyBootstrapGraphqlError,
  CPP_BOOTSTRAP_PROFILE_QUERY,
  createTransport,
  type BootstrapBoard,
  type BootstrapAscent,
  type BootstrapCheckpoint,
  type BootstrapOptions,
  type BootstrapTransport,
} from '../bootstrap-cpp-scenario';
import { readCppPage } from '../lib/screenshot-cpp';
import { typeDefs } from '../../packages/shared-schema/src/schema';
import type { ClimbInput } from '../../packages/shared-schema/src/generated/types';
import { BACKEND_URL } from '../../packages/mobile/src/lib/env';
import {
  MyBoardsInputSchema,
  CreateBoardInputSchema,
  UpdateBoardInputSchema,
} from '../../packages/backend/src/validation/schemas/boards';
import { AscentFeedInputSchema, SaveTickInputSchema } from '../../packages/backend/src/validation/schemas/ticks';
import { CreateSessionInputSchema } from '../../packages/backend/src/validation/schemas/sessions';
import { GetSmartPlaylistInputSchema } from '../../packages/backend/src/validation/schemas/playlists';
import { UpdateProfileInputSchema } from '../../packages/backend/src/validation/schemas/users';
import { getBoulderGradesForBoard } from '../../packages/board-constants/src/boulder-grade-mapping';
import {
  CreateSprayWallInputSchema,
  CreateSprayWallVersionInputSchema,
  UpsertSprayWallHoldsInputSchema,
  PublishSprayWallVersionInputSchema,
  UpdateSprayWallInputSchema,
} from '../../packages/backend/src/validation/schemas/spray-walls';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPSTREAM = 'https://backend.example.test';
const { ClimbSearchInputSchema, ClimbQueueItemSchema } = await vi.importActual<{
  ClimbSearchInputSchema: { safeParse(input: unknown): { success: boolean } };
  ClimbQueueItemSchema: { safeParse(input: unknown): { success: boolean } };
}>('../../packages/backend/src/validation/schemas/climbs');
const API_SCHEMA = buildSchema(typeDefs.join('\n'));
const INPUT_SCHEMAS = {
  GetMyBoards: MyBoardsInputSchema,
  CreateBoard: CreateBoardInputSchema,
  UpdateBoard: UpdateBoardInputSchema,
  SearchClimbs: ClimbSearchInputSchema,
  SearchClimbsCount: ClimbSearchInputSchema,
  UpdateProfile: UpdateProfileInputSchema,
  GetUserGroupedAscentsFeed: AscentFeedInputSchema,
  SaveTick: SaveTickInputSchema,
  CreateSession: CreateSessionInputSchema,
  GetSmartPlaylist: GetSmartPlaylistInputSchema,
  CreateSprayWall: CreateSprayWallInputSchema,
  CreateSprayWallVersion: CreateSprayWallVersionInputSchema,
  UpsertSprayWallHolds: UpsertSprayWallHoldsInputSchema,
  PublishSprayWallVersion: PublishSprayWallVersionInputSchema,
  UpdateSprayWall: UpdateSprayWallInputSchema,
};
function validateActualInput(name: string, variables: Record<string, unknown>): void {
  const schema = INPUT_SCHEMAS[name as keyof typeof INPUT_SCHEMAS];
  if (schema) expect(schema.safeParse(variables.input)).toMatchObject({ success: true });
}
function testUuid(index: number): string {
  return `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, '0')}`;
}

function genuineClimb(board: BootstrapBoard): ClimbInput {
  return {
    uuid: `eeeeeeee-eeee-4eee-8eee-${board.uuid.slice(-12)}`,
    name: `Actual climb on ${board.name}`,
    setter_username: 'Existing setter',
    frames: 'p123r12p456r14',
    angle: board.angle,
    boardType: board.boardType,
    layoutId: board.layoutId,
    ascensionist_count: 4,
    difficulty: '6a/V3',
    difficulty_error: '0',
    quality_average: '3',
    stars: 3,
  };
}

function genuineAscent(board: BootstrapBoard, overrides: Partial<BootstrapAscent> = {}): BootstrapAscent {
  return {
    uuid: testUuid(910),
    climbUuid: genuineClimb(board).uuid,
    climbName: genuineClimb(board).name,
    boardType: board.boardType,
    layoutId: board.layoutId,
    angle: board.angle,
    isMirror: false,
    climbedAt: '2026-10-12T10:00:00',
    status: 'attempt',
    attemptCount: 1,
    difficulty: null,
    renderBoard: { sizeId: board.sizeId, setIds: board.setIds.split(',').map(Number) },
    ...overrides,
  };
}

function manufacturerHarness(): {
  options: BootstrapOptions;
  owned: BootstrapBoard[];
  operations: Array<{ name: string; variables: Record<string, unknown> }>;
  join: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  session: {
    id: string;
    boardPath: string;
    createdByUserId: string;
    isActive: boolean;
    isPublic: boolean;
    isPermanent: boolean;
    status: string | null;
    listed: boolean;
    createId: string;
    persistPermanent: boolean;
  };
} {
  const page = readCppPage('kilter');
  const owned = [...page.heroBoards, ...page.otherBoards].map((variant, index): BootstrapBoard => ({
    uuid: testUuid(index + 1),
    name: `My actual ${variant.selector}`,
    slug: index === 0 ? 'owned-primary' : `owned-variant-${index}`,
    ownerId: ACCOUNT,
    canEdit: true,
    isPublic: false,
    boardId: index + 1,
    boardType: variant.boardType,
    layoutId: variant.layoutId!,
    sizeId: variant.sizeId!,
    setIds: variant.setIds!.join(','),
    angle: variant.angle!,
  }));
  const operations: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const session = {
    id: SESSION,
    boardPath: '/b/owned-primary/40',
    createdByUserId: ACCOUNT,
    isActive: true,
    isPublic: false,
    isPermanent: true,
    status: 'active' as string | null,
    listed: true,
    createId: SESSION,
    persistPermanent: true,
  };
  let recordedAscent = true;
  let recordedAscentId = testUuid(910);
  const join = vi.fn(async () => ({
    queue: [{ uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', climb: genuineClimb(owned[0]) }],
  }));
  const transport: BootstrapTransport = {
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      expect(validate(API_SCHEMA, parse(query))).toEqual([]);
      const name = getOperationAST(parse(query))?.name?.value ?? '';
      validateActualInput(name, variables);
      operations.push({ name, variables });
      let response: unknown;
      switch (name) {
        case 'CppBootstrapProfile':
          response = { profile: { id: ACCOUNT, displayName: 'Liz', avatarUrl: null } };
          break;
        case 'GetGrades':
          response = {
            grades: getBoulderGradesForBoard(variables.boardName as string).map((grade) => ({
              difficultyId: grade.difficulty_id,
              name: grade.difficulty_name,
            })),
          };
          break;
        case 'SearchClimbsCount':
          response = { searchClimbs: { totalCount: 37 } };
          break;
        case 'GetMyBoards':
          response = { myBoards: { boards: owned, hasMore: false } };
          break;
        case 'GetBoardBySlug':
          response = { boardBySlug: owned.find((board) => board.slug === variables.slug) ?? null };
          break;
        case 'GetMySprayWalls':
          response = { mySprayWalls: [] };
          break;
        case 'SearchClimbs': {
          const input = variables.input as { boardName: string; layoutId: number; sizeId: number };
          const board = owned.find(
            (candidate) =>
              candidate.boardType === input.boardName &&
              candidate.layoutId === input.layoutId &&
              candidate.sizeId === input.sizeId,
          )!;
          response = {
            searchClimbs: {
              climbs: [
                genuineClimb(board),
                {
                  ...genuineClimb(board),
                  uuid: testUuid(7000 + board.boardId),
                  name: `Another climb on ${board.name}`,
                },
              ],
            },
          };
          break;
        }
        case 'GetUserGroupedAscentsFeed':
          response = {
            userGroupedAscentsFeed: {
              groups: recordedAscent ? [{ items: [genuineAscent(owned[0], { uuid: recordedAscentId })] }] : [],
            },
          };
          break;
        case 'BoardLiveSessions':
          response = { boardLiveSessions: [{ sessionId: SESSION, host: { userId: ACCOUNT } }] };
          break;
        case 'CppBootstrapSessionStatus':
          response = { sessionStatus: session.status };
          break;
        case 'CreateSession':
          Object.assign(session, {
            id: session.createId,
            boardPath: (variables.input as { boardPath: string }).boardPath,
            createdByUserId: ACCOUNT,
            isActive: false,
            isPublic: false,
            isPermanent: session.persistPermanent,
            status: 'active',
            listed: true,
          });
          response = { createSession: { id: session.id } };
          break;
        case 'CreateBoard': {
          const input = variables.input as {
            name: string;
            boardType: string;
            layoutId: number;
            sizeId: number;
            setIds: string;
            angle: number;
          };
          const board: BootstrapBoard = {
            ...input,
            uuid: testUuid(499 + operations.filter((operation) => operation.name === 'CreateBoard').length),
            slug: `created-qa-${operations.filter((operation) => operation.name === 'CreateBoard').length}`,
            ownerId: ACCOUNT,
            canEdit: true,
            boardId: 500,
          };
          owned.push(board);
          response = { createBoard: board };
          break;
        }
        case 'UpdateBoard': {
          const input = variables.input as { boardUuid: string; name: string };
          owned.find((board) => board.uuid === input.boardUuid)!.name = input.name;
          response = { updateBoard: owned.find((board) => board.uuid === input.boardUuid) };
          break;
        }
        case 'CppBootstrapOwnedSessions':
          response = {
            mySessions: session.listed ? [session] : [],
          };
          break;
        case 'PrivacySettings':
          response = { privacySettings: { enabled: true, privacyRevision: 7 } };
          break;
        case 'SaveTick':
          recordedAscent = true;
          recordedAscentId = (variables.input as { uuid: string }).uuid;
          response = { saveTick: { uuid: (variables.input as { uuid: string }).uuid } };
          break;
        default:
          throw new Error(`Unexpected operation ${name}`);
      }
      return response as T;
    },
    upload: vi.fn().mockRejectedValue(new Error('Unexpected upload')),
    bytes: vi.fn().mockRejectedValue(new Error('Unexpected photo')),
    join,
  };
  const save = vi.fn();
  const checkpoint: BootstrapCheckpoint = {
    version: 1,
    upstream: UPSTREAM,
    accountUserId: ACCOUNT,
    boards: {},
    sessions: { kilter: SESSION },
  };
  const options: BootstrapOptions = {
    target: 'kilter',
    upstream: UPSTREAM,
    accountUserId: ACCOUNT,
    apply: false,
    checkpoint,
    saveCheckpoint: save,
    transport,
  };
  Object.defineProperty(options, 'testRecordedAscent', {
    set: (enabled: boolean) => {
      recordedAscent = enabled;
    },
  });
  return { options, owned, operations, join, save, session };
}

function sprayRenameHarness(variantIndex = 0) {
  const harness = manufacturerHarness();
  const variant = readCppPage('spray').heroBoards[variantIndex];
  const source = readFileSync(variant.photo!);
  let board: BootstrapBoard = {
    ...harness.owned[0],
    uuid: testUuid(700 + variantIndex),
    slug: `actual-spray-${variantIndex}`,
    boardType: 'spray',
    layoutId: 47 + variantIndex,
    sizeId: 47 + variantIndex,
    setIds: '1',
    angle: 40,
    name: ['Home Spray Wall', 'Cherry', 'Bowlo'][variantIndex],
    isPublic: false,
    layoutName: 'Old catalogue label',
    sizeName: 'Old catalogue label',
  };
  let wall = {
    uuid: board.uuid,
    board,
    holdCount: 4,
    currentVersion: {
      id: '47',
      number: 1,
      status: 'PUBLISHED',
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      photo: { url: 'https://photo.example.test/permitted', width: 100, height: 200 },
    },
  };
  const originalBoard = board;
  const originalWall = wall;
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const behavior = {
    staleSocialName: false,
    staleCatalogue: false,
    changedGeometry: false,
    failAfterSprayRename: false,
  };
  harness.options.apply = true;
  harness.options.bindings = { [variant.id]: board.uuid };
  harness.options.checkpoint.boards[variant.id] = {
    uuid: board.uuid,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  };
  harness.options.transport.bytes = vi.fn(async () => source);
  harness.options.transport.request = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    expect(validate(API_SCHEMA, parse(query))).toEqual([]);
    const name = getOperationAST(parse(query))?.name?.value ?? '';
    validateActualInput(name, variables);
    calls.push({ name, variables });
    if (name === 'GetBoardBySlug') return { boardBySlug: variables.slug === board.slug ? board : null } as T;
    if (name === 'GetSprayWallWithVersions') return { sprayWall: wall } as T;
    if (name === 'GetMyBoards') {
      if (behavior.failAfterSprayRename) {
        behavior.failAfterSprayRename = false;
        throw new Error('Interrupted after spray rename');
      }
      return { myBoards: { boards: [board], hasMore: false } } as T;
    }
    if (name === 'UpdateSprayWall') {
      board = {
        ...board,
        name: behavior.staleSocialName ? board.name : variant.selector,
        layoutName: behavior.staleCatalogue ? board.layoutName : variant.selector,
        sizeName: behavior.staleCatalogue ? board.sizeName : variant.selector,
      };
      wall = {
        ...wall,
        board: { ...board, name: variant.selector },
        currentVersion: {
          ...wall.currentVersion,
          homography: behavior.changedGeometry ? [2, 0, 0, 0, 1, 0, 0, 0, 1] : wall.currentVersion.homography,
        },
      };
      return { updateSprayWall: wall } as T;
    }
    if (name === 'UpdateBoard') {
      board = { ...board, name: variant.selector };
      wall = { ...wall, board };
      return { updateBoard: board } as T;
    }
    throw new Error(`Unexpected operation ${name}`);
  };
  return { ...harness, variant, originalBoard, originalWall, calls, behavior, currentBoard: () => board };
}

describe('genuine marketing climb and account coverage', () => {
  it('selects a different actual primary climb and preserves its raw ID, title and displayed grade', () => {
    const board = manufacturerHarness().owned[0];
    const wall = genuineClimb(board);
    const accessory = {
      ...wall,
      uuid: 'ABCDEF1234567890ABCDEF1234567890',
      name: 'Actual different problem',
      difficulty: '6c/V5',
    };
    expect(selectCppAccessoryClimb(board, [wall, accessory], wall.uuid)).toEqual({
      boardId: board.uuid,
      climbId: accessory.uuid,
      readyText: accessory.name,
      gradeLabel: 'V5',
    });
  });

  it.each([
    'same-id',
    'foreign-layout',
    'foreign-family',
    'wrong-angle',
    'incompatible-size',
    'missing-holds',
    'no-frames',
    'invalid-id',
  ] as const)('refuses an accessory candidate with %s instead of using another wall or fabricated climb', (failure) => {
    const board = manufacturerHarness().owned[0];
    const wall = genuineClimb(board);
    const candidate = { ...wall, uuid: testUuid(7900), name: 'Different problem' };
    if (failure === 'same-id') candidate.uuid = wall.uuid;
    if (failure === 'foreign-layout') candidate.layoutId = board.layoutId + 1;
    if (failure === 'foreign-family') candidate.boardType = 'tension';
    if (failure === 'wrong-angle') candidate.angle += 10;
    if (failure === 'incompatible-size') candidate.compatibleSizeIds = [board.sizeId + 1];
    if (failure === 'missing-holds') candidate.missingHoldCount = 1;
    if (failure === 'no-frames') candidate.frames = '';
    if (failure === 'invalid-id') candidate.uuid = 'invented-id';
    expect(selectCppAccessoryClimb(board, [wall, candidate], wall.uuid)).toBeUndefined();
  });

  it('never searches beyond the first ten rows for an accessory and permits a genuine ungraded spray problem', () => {
    const board = manufacturerHarness().owned[0];
    const wall = genuineClimb(board);
    const different = { ...wall, uuid: testUuid(7900), name: 'Different problem' };
    expect(
      selectCppAccessoryClimb(board, [...Array.from({ length: 10 }, () => wall), different], wall.uuid),
    ).toBeUndefined();
    const spray = { ...board, boardType: 'spray', layoutId: 47, sizeId: 47 };
    const project = { ...genuineClimb(spray), uuid: testUuid(7901), difficulty: '' };
    expect(selectCppAccessoryClimb(spray, [project], wall.uuid)).toMatchObject({
      boardId: spray.uuid,
      climbId: project.uuid,
      gradeLabel: '',
    });
  });

  it('blocks a new scenario if the genuine primary result page has no different drawable accessory climb', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      const response = await request<T>(query, variables);
      if (getOperationAST(parse(query))?.name?.value === 'SearchClimbs') {
        const result = response as { searchClimbs: { climbs: ClimbInput[] } };
        if (
          (variables.input as { boardName: string; sizeId: number }).boardName === 'kilter' &&
          (variables.input as { sizeId: number }).sizeId === harness.owned[0].sizeId
        )
          result.searchClimbs.climbs = result.searchClimbs.climbs.slice(0, 1);
      }
      return response;
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.scenario).toBeUndefined();
    expect(result.blockers).toContainEqual(expect.stringContaining('no different drawable accessory preview'));
  });
  it('creates a distinct private QA copy of a genuine owned public configuration and resumes its exact UUID', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.session.boardPath = '/kilter/1/10/1,20/40';
    const variant = readCppPage('kilter').primaryBoard;
    const original = harness.owned[0];
    original.name = "Test User's Kilter Original 12×12 with kickboard";
    original.isPublic = true;
    const before = structuredClone(original);
    harness.options.checkpoint.boards[variant.id] = { uuid: original.uuid };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(original).toEqual(before);
    expect(harness.operations.filter((operation) => operation.name === 'UpdateBoard')).toEqual([]);
    const created = harness.operations.find((operation) => operation.name === 'CreateBoard')!;
    expect(created.variables.input).toEqual({
      name: "Liz's Kilter Original 12x12",
      boardType: original.boardType,
      layoutId: original.layoutId,
      sizeId: original.sizeId,
      setIds: original.setIds,
      angle: original.angle,
      isPublic: false,
      isUnlisted: true,
      isOwned: false,
      hideLocation: true,
      allowDuplicateConfig: true,
    });
    const privateId = harness.options.checkpoint.boards[variant.id].uuid;
    expect(privateId).not.toBe(original.uuid);
    expect(harness.options.checkpoint.catalogueSourceBoardIds?.[variant.id]).toEqual([original.uuid]);
    expect(result.scenario?.cpp?.boardIds?.[variant.id]).toBe(privateId);
    expect(result.scenario?.cpp?.scenes.search.boardId).toBe(privateId);
    const resumed = await bootstrapCppScenario(harness.options);
    expect(resumed.blockers).toEqual([]);
    expect(resumed.scenario?.cpp?.boardIds?.[variant.id]).toBe(privateId);
    expect(harness.operations.filter((operation) => operation.name === 'CreateBoard')).toHaveLength(1);
    expect(original).toEqual(before);
  });

  it('selects an already verified Liz QA board and retains the public checkpoint source without another create', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.session.boardPath = '/kilter/1/10/1,20/40';
    const variant = readCppPage('kilter').primaryBoard;
    const original = harness.owned[0];
    original.isPublic = true;
    harness.options.checkpoint.boards[variant.id] = { uuid: original.uuid };
    const qa = {
      ...original,
      uuid: testUuid(510),
      slug: 'actual-private-qa',
      name: "Liz's Kilter Original 12x12",
      isPublic: false,
    };
    harness.owned.push(qa);
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(harness.options.checkpoint.boards[variant.id].uuid).toBe(qa.uuid);
    expect(harness.options.checkpoint.catalogueSourceBoardIds?.[variant.id]).toEqual([original.uuid]);
    expect(harness.operations.some((operation) => ['CreateBoard', 'UpdateBoard'].includes(operation.name))).toBe(false);
  });

  it.each(['isPublic', 'canEdit'] as const)(
    'blocks omitted catalogue %s before any metadata creation or rename',
    async (field) => {
      const harness = manufacturerHarness();
      harness.options.apply = true;
      Reflect.deleteProperty(harness.owned[0], field);
      const result = await bootstrapCppScenario(harness.options);
      expect(result.scenario).toBeUndefined();
      expect(result.blockers).toContainEqual(
        expect.stringContaining(field === 'isPublic' ? 'visibilityKnown=false' : 'editabilityKnown=false'),
      );
      expect(
        harness.operations.some((operation) =>
          ['CreateBoard', 'UpdateBoard', 'UpdateProfile'].includes(operation.name),
        ),
      ).toBe(false);
      expect(harness.save).not.toHaveBeenCalled();
      expect(harness.operations.some((operation) => operation.name === 'CppBootstrapProfile')).toBe(false);
    },
  );

  it('preserves explicit public and foreign bindings without silently substituting a private clone', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const variant = readCppPage('kilter').primaryBoard;
    harness.owned[0].isPublic = true;
    harness.options.bindings = { [variant.id]: harness.owned[0].uuid };
    expect(selectScreenshotCatalogueBoard(harness.options, variant, harness.owned).problem).toContain(
      'isPrivate=false',
    );
    const bound = await bootstrapCppScenario(harness.options);
    expect(bound.scenario).toBeUndefined();
    expect(harness.operations.some((operation) => ['CreateBoard', 'UpdateBoard'].includes(operation.name))).toBe(false);
    harness.owned[0].ownerId = testUuid(888);
    const foreign = await bootstrapCppScenario(harness.options);
    expect(foreign.blockers).toContainEqual(expect.stringContaining('another owner/configuration'));
    expect(harness.operations.some((operation) => ['CreateBoard', 'UpdateBoard'].includes(operation.name))).toBe(false);
  });

  it('plans a private clone without creating it or changing the source checkpoint in read-only mode', async () => {
    const harness = manufacturerHarness();
    const variant = readCppPage('kilter').primaryBoard;
    harness.owned[0].isPublic = true;
    harness.options.checkpoint.boards[variant.id] = { uuid: harness.owned[0].uuid };
    const before = structuredClone(harness.options.checkpoint);
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('creation requires --apply'));
    expect(result.actions).toContainEqual(expect.stringContaining('existing catalogue rows preserved'));
    expect(harness.options.checkpoint).toEqual(before);
    expect(harness.operations.some((operation) => ['CreateBoard', 'UpdateBoard'].includes(operation.name))).toBe(false);
  });

  it.each(['explicit', 'saved'] as const)(
    'fails unavailable or mismatched %s bindings before every metadata write',
    async (kind) => {
      const harness = manufacturerHarness();
      harness.options.apply = true;
      const variant = readCppPage('kilter').primaryBoard;
      const boundId = testUuid(991);
      if (kind === 'explicit') harness.options.bindings = { [variant.id]: boundId };
      else harness.options.checkpoint.boards[variant.id] = { uuid: boundId };
      for (const row of [undefined, { ...harness.owned[0], uuid: boundId, sizeId: 999 }]) {
        if (row) harness.owned.push(row);
        const result = await bootstrapCppScenario(harness.options);
        expect(result.blockers).toContainEqual(
          expect.stringContaining('unavailable or has another owner/configuration'),
        );
        expect(
          harness.operations.some((operation) =>
            ['CreateBoard', 'UpdateBoard', 'UpdateProfile'].includes(operation.name),
          ),
        ).toBe(false);
        expect(harness.save).not.toHaveBeenCalled();
        expect(harness.operations.some((operation) => operation.name === 'CppBootstrapProfile')).toBe(false);
      }
    },
  );

  it('blocks ambiguous private configurations rather than minting another row', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.owned.push({ ...harness.owned[0], uuid: testUuid(992), name: 'Another real private board' });
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('multiple editable private catalogue boards'));
    expect(harness.operations.some((operation) => operation.name === 'CppBootstrapProfile')).toBe(false);
    expect(
      harness.operations.some((operation) => ['CreateBoard', 'UpdateBoard', 'UpdateProfile'].includes(operation.name)),
    ).toBe(false);
  });

  it('recovers the named private copy after a lost create response without using the duplicate bypass twice', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.session.boardPath = '/kilter/1/10/1,20/40';
    const variant = readCppPage('kilter').primaryBoard;
    const original = harness.owned[0];
    original.isPublic = true;
    harness.options.checkpoint.boards[variant.id] = { uuid: original.uuid };
    const request = harness.options.transport.request;
    let responseLost = false;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      const response = await request<T>(query, variables);
      if (getOperationAST(parse(query))?.name?.value === 'CreateBoard' && !responseLost) {
        responseLost = true;
        // The server committed, but the client never received its new UUID.
        throw new Error('lost create response');
      }
      return response;
    };
    await expect(bootstrapCppScenario(harness.options)).rejects.toThrow('lost create response');
    expect(harness.options.checkpoint.boards[variant.id].uuid).toBe(original.uuid);
    const actualPrivate = harness.owned.find((board) => board.name === "Liz's Kilter Original 12x12")!;
    const resumed = await bootstrapCppScenario(harness.options);
    expect(resumed.blockers).toEqual([]);
    expect(harness.options.checkpoint.boards[variant.id].uuid).toBe(actualPrivate.uuid);
    expect(harness.options.checkpoint.catalogueSourceBoardIds?.[variant.id]).toEqual([original.uuid]);
    expect(harness.operations.filter((operation) => operation.name === 'CreateBoard')).toHaveLength(1);
    expect(original.isPublic).toBe(true);
  });

  it('rejects a wrong-name fresh private reread and keeps its pending proof blocked on retry', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const variant = readCppPage('kilter').primaryBoard;
    const original = harness.owned[0];
    original.isPublic = true;
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      const response = await request<T>(query, variables);
      if (getOperationAST(parse(query))?.name?.value === 'CreateBoard')
        harness.owned.at(-1)!.name = 'Unrelated private resource';
      return response;
    };
    await expect(bootstrapCppScenario(harness.options)).rejects.toThrow('nameMatchesExpected=false');
    expect(harness.options.checkpoint.boards[variant.id].expectedCatalogueName).toBe("Liz's Kilter Original 12x12");
    const resumed = await bootstrapCppScenario(harness.options);
    expect(resumed.scenario).toBeUndefined();
    expect(resumed.blockers).toContainEqual(expect.stringContaining('pending QA creation failed fresh verification'));
    expect(harness.operations.filter((operation) => operation.name === 'CreateBoard')).toHaveLength(1);
    expect(harness.operations.some((operation) => operation.name === 'UpdateBoard')).toBe(false);
    expect(original.isPublic).toBe(true);
  });

  it.each([
    { isPublic: true, canEdit: true },
    { isPublic: false, canEdit: false },
  ])('never mints a replacement for a pending QA creation failing privacy or editability: %o', async (permissions) => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const variant = readCppPage('kilter').primaryBoard;
    const pending = harness.owned[0];
    pending.name = "Liz's Kilter Original 12x12";
    Object.assign(pending, permissions);
    harness.options.checkpoint.boards[variant.id] = {
      uuid: pending.uuid,
      expectedCatalogueName: pending.name,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await bootstrapCppScenario(harness.options);
      expect(result.scenario).toBeUndefined();
      expect(result.blockers).toContainEqual(expect.stringContaining('pending QA creation failed fresh verification'));
    }
    expect(
      harness.operations.some((operation) =>
        ['CreateBoard', 'UpdateBoard', 'UpdateProfile', 'CppBootstrapProfile'].includes(operation.name),
      ),
    ).toBe(false);
    expect(harness.options.saveCheckpoint).not.toHaveBeenCalled();
    expect(pending.isPublic).toBe(permissions.isPublic);
    expect(pending.canEdit).toBe(permissions.canEdit);
    expect(harness.options.checkpoint.boards[variant.id].uuid).toBe(pending.uuid);
  });

  it('chooses three distinct titles and displayed grades without changing primary scene climbs', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const variants = readCppPage('kilter').heroBoards;
    const sources = harness.owned.slice(0, 3).map((board, index) => ({
      variantId: variants[index].id,
      board,
      climbs: [
        { ...genuineClimb(board), name: 'Moon Landing' },
        { ...genuineClimb(board), uuid: testUuid(940 + index), name: 'Shared name', difficulty: '6a/V3' },
        {
          ...genuineClimb(board),
          uuid: testUuid(950 + index),
          name: `Real route ${index}`,
          difficulty: ['6a/V3', '6b/V4', '6c/V5'][index],
        },
      ],
    }));
    const selected = selectCppHeroClimbs(sources)!;
    expect(new Set(Object.values(selected).map((climb) => climb.readyText)).size).toBe(3);
    expect(Object.values(selected).map((climb) => climb.gradeLabel)).toEqual(['V3', 'V4', 'V5']);
    expect(Object.values(selected).every((climb) => climb.readyText !== 'Moon Landing')).toBe(true);
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'SearchClimbs') {
        validateActualInput('SearchClimbs', variables);
        const input = variables.input as { boardName: string; layoutId: number; sizeId: number };
        const source = sources.find(
          ({ board }) =>
            board.boardType === input.boardName && board.layoutId === input.layoutId && board.sizeId === input.sizeId,
        );
        if (source) return { searchClimbs: { climbs: source.climbs } } as T;
      }
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(result.scenario?.cpp?.heroClimbs?.[variants[0].id]).toEqual(selected[variants[0].id]);
    expect(result.scenario?.cpp?.scenes.status.climbId).toBe(sources[0].climbs[0].uuid);
    expect(result.scenario?.cpp?.scenes.status.readyText).toBe('Moon Landing');
    expect(result.scenario?.cpp?.scenes.search.gradeFilter).toMatchObject({ minLabel: 'V3', expectedCount: 37 });
    expect(harness.operations.find((operation) => operation.name === 'SearchClimbsCount')?.variables.input).toEqual({
      boardName: sources[0].board.boardType,
      layoutId: sources[0].board.layoutId,
      sizeId: sources[0].board.sizeId,
      setIds: sources[0].board.setIds,
      angle: 40,
      minGrade: result.scenario?.cpp?.scenes.search.gradeFilter?.minGradeId,
      maxGrade: result.scenario?.cpp?.scenes.search.gradeFilter?.maxGradeId,
      boulders: true,
      page: 0,
      pageSize: 1,
      sortBy: 'ascents',
      sortOrder: 'desc',
    });
  });

  it('uses only the first ten exact-config drawable rows and proves benchmarks at the captured angle', () => {
    const { owned } = manufacturerHarness();
    const board = { ...owned[0], boardType: 'moonboard' };
    const candidate = { ...genuineClimb(board), benchmark_difficulty: '19', statsAngle: 40 };
    expect(selectCppHeroClimbs([{ variantId: 'moon', board, climbs: [candidate] }])?.moon).toMatchObject({
      climbId: candidate.uuid,
      statsAngle: 40,
      benchmarkDifficulty: 19,
    });
    expect(
      selectCppHeroClimbs([
        { variantId: 'moon', board, climbs: [{ ...candidate, statsAngle: 25 }], requireBenchmark: true },
      ]),
    ).toBeUndefined();
    expect(
      selectCppHeroClimbs([
        { variantId: 'moon', board, climbs: [{ ...candidate, benchmark_difficulty: '0' }], requireBenchmark: true },
      ]),
    ).toBeUndefined();
    expect(
      selectCppHeroClimbs([
        {
          variantId: 'moon',
          board,
          climbs: [{ ...candidate, uuid: testUuid(966), benchmark_difficulty: null }, candidate],
          requireBenchmark: true,
        },
      ])?.moon.climbId,
    ).toBe(candidate.uuid);
    expect(
      selectCppHeroClimbs([{ variantId: 'moon', board, climbs: [{ ...candidate, statsAngle: 25 }] }])?.moon
        .benchmarkDifficulty,
    ).toBeUndefined();
    for (const invalid of [
      { layoutId: 999 },
      { angle: 25 },
      { compatibleSizeIds: [999] },
      { missingHoldCount: 1 },
      { uuid: 'fabricated' },
    ])
      expect(
        selectCppHeroClimbs([{ variantId: 'moon', board, climbs: [{ ...candidate, ...invalid }] }]),
      ).toBeUndefined();
    const invalidRows = Array.from({ length: 10 }, () => ({ ...candidate, frames: '' }));
    expect(selectCppHeroClimbs([{ variantId: 'moon', board, climbs: [...invalidRows, candidate] }])).toBeUndefined();
    expect(() =>
      selectCppHeroClimbs(Array.from({ length: 4 }, () => ({ variantId: 'moon', board, climbs: [candidate] }))),
    ).toThrow('bounded');
  });

  it('renames only the authenticated profile with a name-only API input and fresh immutable avatar proof', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const profile = { id: ACCOUNT, displayName: 'Test User', avatarUrl: 'https://avatar.example.test/existing' };
    const calls: Array<{ name: string; variables: Record<string, unknown> }> = [];
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      expect(validate(API_SCHEMA, parse(query))).toEqual([]);
      const name = getOperationAST(parse(query))?.name?.value ?? '';
      calls.push({ name, variables });
      if (name === 'CppBootstrapProfile') return { profile: { ...profile } } as T;
      validateActualInput(name, variables);
      expect(variables.input).toEqual({ displayName: 'Liz' });
      profile.displayName = 'Liz';
      return { updateProfile: { ...profile } } as T;
    };
    expect(await ensureScreenshotProfileName(harness.options, [])).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['CppBootstrapProfile', 'UpdateProfile', 'CppBootstrapProfile']);
    expect(await ensureScreenshotProfileName(harness.options, [])).toBeNull();
    expect(calls.filter((call) => call.name === 'UpdateProfile')).toHaveLength(1);
    profile.id = testUuid(999);
    expect(await ensureScreenshotProfileName(harness.options, [])).toContain('authenticated checkpoint owner');
    expect(calls.filter((call) => call.name === 'UpdateProfile')).toHaveLength(1);
  });

  it('plans profile changes without writes and fails a stale name/avatar reread', async () => {
    const harness = manufacturerHarness();
    const profile = { id: ACCOUNT, displayName: 'Test User', avatarUrl: null };
    const request = vi.fn(async <T>(query: string): Promise<T> =>
      getOperationAST(parse(query))?.name?.value === 'CppBootstrapProfile'
        ? ({ profile } as T)
        : ({ updateProfile: { ...profile, displayName: 'Liz' } } as T),
    );
    harness.options.transport.request = async <T>(query: string): Promise<T> => (await request(query)) as T;
    expect(await ensureScreenshotProfileName(harness.options, [])).toContain('--apply');
    expect(request).toHaveBeenCalledTimes(1);
    harness.options.apply = true;
    expect(await ensureScreenshotProfileName(harness.options, [])).toContain('fresh owner/name/avatar');
  });

  it('renames a generated private QA board without changing its identity or configuration', async () => {
    const harness = manufacturerHarness();
    const variant = readCppPage('kilter').heroBoards[0];
    const board = harness.owned[0];
    board.name = "Test User's Kilter Original 12×12";
    board.isPublic = false;
    harness.options.apply = true;
    const before = { ...board };
    const renamed = await ensureScreenshotCatalogueName(harness.options, variant, board, []);
    expect(renamed.name).toBe("Liz's Kilter Original 12x12");
    expect(renamed).toEqual({ ...before, name: renamed.name });
    expect(harness.operations.find((operation) => operation.name === 'UpdateBoard')?.variables.input).toEqual({
      boardUuid: before.uuid,
      name: renamed.name,
    });
    board.name = "Test User's public board";
    board.isPublic = true;
    await expect(ensureScreenshotCatalogueName(harness.options, variant, board, [])).rejects.toThrow(
      'editable private owned',
    );
    expect(harness.operations.filter((operation) => operation.name === 'UpdateBoard')).toHaveLength(1);
  });
});

describe('verified spray wall names', () => {
  it.each([0, 1, 2])('applies only the requested name to verified owned variant %s', async (variantIndex) => {
    const harness = sprayRenameHarness(variantIndex);
    const checkpointIdentity = harness.options.checkpoint.boards[harness.variant.id];
    const result = await ensureSprayBoardName(
      harness.options,
      harness.variant,
      harness.originalBoard,
      harness.originalWall,
      [],
    );
    expect(result.problem).toBeNull();
    expect(result.board).toMatchObject({
      uuid: checkpointIdentity.uuid,
      name: harness.variant.selector,
      layoutName: harness.variant.selector,
      sizeName: harness.variant.selector,
    });
    const mutations = harness.calls.filter((call) => !call.name.startsWith('Get'));
    expect(mutations).toEqual([
      {
        name: 'UpdateSprayWall',
        variables: { input: { uuid: checkpointIdentity.uuid, name: harness.variant.selector } },
      },
    ]);
    expect(harness.options.checkpoint.boards[harness.variant.id]).toMatchObject(checkpointIdentity);
    expect(harness.options.transport.upload).not.toHaveBeenCalled();
    const mutationIndex = harness.calls.findIndex((call) => call.name === 'UpdateSprayWall');
    expect(mutationIndex).toBeGreaterThan(0);
    expect(harness.calls.slice(0, mutationIndex).every((call) => call.name.startsWith('Get'))).toBe(true);
    expect(harness.options.transport.bytes).toHaveBeenCalled();
    expect(
      (await ensureSprayBoardName(harness.options, harness.variant, result.board, harness.originalWall, [])).problem,
    ).toBeNull();
    expect(harness.calls.filter((call) => call.name === 'UpdateSprayWall')).toHaveLength(1);
  });

  it('aligns the social name with a name-only owner update when production leaves it stale', async () => {
    const harness = sprayRenameHarness();
    harness.behavior.staleSocialName = true;
    const result = await ensureSprayBoardName(
      harness.options,
      harness.variant,
      harness.originalBoard,
      harness.originalWall,
      [],
    );
    expect(result.problem).toBeNull();
    expect(harness.calls.filter((call) => call.name === 'UpdateBoard')).toEqual([
      {
        name: 'UpdateBoard',
        variables: { input: { boardUuid: harness.originalBoard.uuid, name: harness.variant.selector } },
      },
    ]);
    expect(result.board.name).toBe("Liz's Wall");
  });

  it('resumes an interrupted partial rename using the same checkpoint UUID and source', async () => {
    const harness = sprayRenameHarness(1);
    harness.behavior.staleSocialName = true;
    harness.behavior.failAfterSprayRename = true;
    await expect(
      ensureSprayBoardName(harness.options, harness.variant, harness.originalBoard, harness.originalWall, []),
    ).rejects.toThrow('Interrupted');
    const result = await ensureSprayBoardName(
      harness.options,
      harness.variant,
      harness.currentBoard(),
      harness.originalWall,
      [],
    );
    expect(result.problem).toBeNull();
    expect(result.board.uuid).toBe(harness.originalBoard.uuid);
    expect(harness.options.checkpoint.boards[harness.variant.id]).toMatchObject({
      uuid: harness.originalBoard.uuid,
      sourceSha256: createHash('sha256').update(readFileSync(harness.variant.photo!)).digest('hex'),
    });
  });

  it('plans the exact name update without changing metadata in read-only mode', async () => {
    const harness = sprayRenameHarness();
    harness.options.apply = false;
    const actions: string[] = [];
    const result = await ensureSprayBoardName(
      harness.options,
      harness.variant,
      harness.originalBoard,
      harness.originalWall,
      actions,
    );
    expect(result.problem).toContain('requires --apply');
    expect(actions).toEqual(["spray-liz: rename verified private wall to Liz's Wall"]);
    expect(harness.calls.every((call) => call.name.startsWith('Get'))).toBe(true);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('never renames an unverified photo', async () => {
    const harness = sprayRenameHarness();
    harness.options.transport.bytes = async () => readFileSync(readCppPage('spray').heroBoards[1].photo!);
    const result = await ensureSprayBoardName(
      harness.options,
      harness.variant,
      harness.originalBoard,
      harness.originalWall,
      [],
    );
    expect(result.problem).toContain('visually verify');
    expect(harness.calls.every((call) => call.name.startsWith('Get'))).toBe(true);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it.each(['owner', 'public', 'holds'] as const)(
    'refuses metadata writes when %s verification fails',
    async (failure) => {
      const harness = sprayRenameHarness();
      if (failure === 'owner') harness.originalWall.board.ownerId = testUuid(900);
      if (failure === 'public') harness.originalWall.board.isPublic = true;
      if (failure === 'holds') harness.originalWall.holdCount = 0;
      const result = await ensureSprayBoardName(
        harness.options,
        harness.variant,
        harness.originalBoard,
        harness.originalWall,
        [],
      );
      expect(result.problem).not.toBeNull();
      expect(harness.calls.every((call) => call.name.startsWith('Get'))).toBe(true);
    },
  );

  it.each(['staleCatalogue', 'changedGeometry'] as const)(
    'blocks capture when the real reread reports %s',
    async (failure) => {
      const harness = sprayRenameHarness();
      harness.behavior[failure] = true;
      const result = await ensureSprayBoardName(
        harness.options,
        harness.variant,
        harness.originalBoard,
        harness.originalWall,
        [],
      );
      expect(result.problem).toContain('unchanged photo/geometry verification');
    },
  );
});

describe('CPP account/bootstrap safety', () => {
  it('stops an entire spray trio before any writes when current capacity cannot fit both new walls', async () => {
    const harness = manufacturerHarness();
    harness.options.target = 'spray';
    harness.options.apply = true;
    harness.options.bindings = { 'spray-liz': testUuid(700) };
    const sprayBoards = Array.from({ length: 9 }, (_, index): BootstrapBoard => ({
      ...harness.owned[0],
      uuid: testUuid(700 + index),
      boardId: 700 + index,
      boardType: 'spray',
      layoutId: 47 + index,
      sizeId: 47 + index,
      setIds: '1',
      name: index === 0 ? 'Home Spray Wall' : `Existing QA wall ${index}`,
    }));
    const calls: string[] = [];
    harness.options.transport.request = async <T>(query: string): Promise<T> => {
      expect(validate(API_SCHEMA, parse(query))).toEqual([]);
      const name = getOperationAST(parse(query))?.name?.value ?? '';
      calls.push(name);
      if (name === 'GetMyBoards')
        return { myBoards: { boards: [...harness.owned, ...sprayBoards], hasMore: false } } as T;
      if (name === 'GetMySprayWalls')
        return {
          mySprayWalls: sprayBoards.map((board) => ({ uuid: board.uuid, board, currentVersion: null, holdCount: 0 })),
        } as T;
      if (name === 'GetMySprayWallLifecycle')
        return {
          mySprayWalls: sprayBoards.map((board) => ({
            uuid: board.uuid,
            archivedAt: null,
            board: { uuid: board.uuid, name: board.name },
          })),
        } as T;
      throw new Error(`Unexpected action after capacity preflight: ${name}`);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(
      expect.stringContaining("9 active walls; 2 additional walls (Cherry's Wall, The Bowlo) would require 11 slots"),
    );
    expect(result.scenario).toBeUndefined();
    expect(calls).toEqual(['GetMyBoards', 'GetMySprayWalls', 'GetMySprayWallLifecycle']);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.join).not.toHaveBeenCalled();
  });

  it('does not charge archived walls against the live-wall capacity preflight', async () => {
    const harness = manufacturerHarness();
    harness.options.target = 'spray';
    harness.options.bindings = { 'spray-liz': testUuid(700) };
    const sprayBoards = Array.from({ length: 9 }, (_, index): BootstrapBoard => ({
      ...harness.owned[0],
      uuid: testUuid(700 + index),
      boardType: 'spray',
      layoutId: 47 + index,
      sizeId: 47 + index,
      setIds: '1',
      name: index === 0 ? 'Home Spray Wall' : `Existing QA wall ${index}`,
    }));
    const original = readFileSync(readCppPage('spray').primaryBoard.photo!);
    const currentVersion = {
      id: '47',
      number: 1,
      status: 'PUBLISHED',
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      photo: { url: 'https://photo.example.test/liz', width: 100, height: 100 },
    };
    const walls = sprayBoards.map((board) => ({ uuid: board.uuid, board, currentVersion, holdCount: 4 }));
    harness.options.transport.bytes = async () => original;
    harness.options.transport.request = async <T>(query: string): Promise<T> => {
      const name = getOperationAST(parse(query))?.name?.value ?? '';
      if (name === 'GetMyBoards')
        return { myBoards: { boards: [...harness.owned, ...sprayBoards], hasMore: false } } as T;
      if (name === 'GetMySprayWalls') return { mySprayWalls: walls } as T;
      if (name === 'GetBoardBySlug') return { boardBySlug: sprayBoards[0] } as T;
      if (name === 'GetMySprayWallLifecycle')
        return {
          mySprayWalls: sprayBoards.map((board, index) => ({
            uuid: board.uuid,
            archivedAt: index === 8 ? '2026-10-01T00:00:00Z' : null,
            board: { uuid: board.uuid, name: board.name },
          })),
        } as T;
      if (name === 'GetSprayWallWithVersions') return { sprayWall: walls[0] } as T;
      if (name === 'CppBootstrapProfile') return { profile: { id: ACCOUNT, displayName: 'Liz', avatarUrl: null } } as T;
      if (name === 'SearchClimbs') return { searchClimbs: { climbs: [] } } as T;
      throw new Error(`Unexpected action ${name}`);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers.some((blocker) => blocker.includes('wall cap'))).toBe(false);
    expect(result.blockers).toContainEqual(expect.stringContaining('spray-cherry: missing owned board'));
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('uses an actual schema-valid read-only HTTP authentication probe', () => {
    expect(validate(API_SCHEMA, parse(CPP_BOOTSTRAP_PROFILE_QUERY))).toEqual([]);
    expect(getOperationAST(parse(CPP_BOOTSTRAP_PROFILE_QUERY))?.operation).toBe('query');
  });

  it('classifies known auth/input failures without echoing server payloads', () => {
    expect(classifyBootstrapGraphqlError({ message: 'Authentication required to perform this operation' })).toBe(
      'AUTHENTICATION_REQUIRED',
    );
    expect(classifyBootstrapGraphqlError({ message: 'Invalid input: Too big: expected number to be <=50' })).toBe(
      'INVALID_INPUT',
    );
    expect(classifyBootstrapGraphqlError({ message: 'Cannot query field unsupported on UserBoard.' })).toBe(
      'GRAPHQL_VALIDATION_FAILED',
    );
    expect(classifyBootstrapGraphqlError({ extensions: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(
      'INTERNAL_SERVER_ERROR',
    );
    expect(classifyBootstrapGraphqlError({ message: 'jwt-secret-data', extensions: { code: 'jwt-secret-data' } })).toBe(
      'GRAPHQL_ERROR',
    );
  });

  it('paginates the actual roster with the backend limit rather than skipping owned boards', async () => {
    const harness = manufacturerHarness();
    const originalRequest = harness.options.transport.request;
    const offsets: number[] = [];
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'GetMyBoards') {
        validateActualInput('GetMyBoards', variables);
        const input = variables.input as { limit: number; offset: number };
        offsets.push(input.offset);
        expect(input.limit).toBe(50);
        if (input.offset === 0)
          return {
            myBoards: {
              boards: Array.from({ length: 50 }, (_, index) => ({
                ...harness.owned[0],
                uuid: testUuid(1000 + index),
                ownerId: 'another-account',
              })),
              hasMore: true,
            },
          } as T;
      }
      return originalRequest<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(offsets).toEqual([0, 50]);
    expect(result.boards).toHaveLength(6);
  });

  it('creates missing catalogue boards and private sessions using actual backend input constraints', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.owned.shift();
    harness.options.checkpoint.sessions = {};
    const originalRequest = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'BoardLiveSessions') return { boardLiveSessions: [] } as T;
      return originalRequest<T>(query, variables);
    };
    // The new primary goes last in the roster; return its genuine history and queue.
    const activePrimary = () =>
      harness.owned.find((board) => board.layoutId === 1 && board.sizeId === 10 && board.boardType === 'kilter')!;
    const previousRequest = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'GetUserGroupedAscentsFeed') {
        validateActualInput('GetUserGroupedAscentsFeed', variables);
        return { userGroupedAscentsFeed: { groups: [{ items: [genuineAscent(activePrimary())] }] } } as T;
      }
      return previousRequest<T>(query, variables);
    };
    harness.join.mockImplementation(async (variables: { initialQueue: Array<{ uuid: string; climb: ClimbInput }> }) => {
      for (const item of variables.initialQueue)
        expect(ClimbQueueItemSchema.safeParse(item)).toMatchObject({ success: true });
      return { queue: variables.initialQueue };
    });
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(harness.operations.find((entry) => entry.name === 'CreateBoard')?.variables.input).toMatchObject({
      isPublic: false,
      isUnlisted: true,
      setIds: '1,20',
    });
    expect(harness.operations.find((entry) => entry.name === 'CreateSession')?.variables.input).toMatchObject({
      audience: 'invite_only',
      isPublic: false,
      discoverable: true,
      isPermanent: true,
    });
  });

  it('resolves the CLI default to the same production origin as native capture', () => {
    vi.stubEnv('SCREENSHOT_UPSTREAM', undefined);
    try {
      expect(resolveBootstrapUpstream()).toBe(BACKEND_URL.replace(/\/$/, ''));
      expect(new URL(resolveBootstrapUpstream()).origin).toBe(new URL(BACKEND_URL).origin);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'not-an-origin',
    'https:example.test',
    'http://example.test',
    'ftp://example.test',
    'https://user:password@example.test',
    'https://@example.test',
    'https://example.test/nested/path',
    'https://example.test?secret=value',
    'https://example.test?',
    'https://example.test#fragment',
    'https://example.test#',
  ])('rejects unsafe backend origin %s before credential fetch', async (upstream) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      expect(() => resolveBootstrapUpstream(upstream)).toThrow('HTTPS origin or local HTTP origin');
      await expect(createTransport(upstream, 'dedicated@example.test', 'test-password')).rejects.toThrow(
        'HTTPS origin or local HTTP origin',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['http://localhost:4000/', 'http://127.0.0.1:4000/', 'http://[::1]:4000/'])(
    'allows local HTTP development origins %s',
    (upstream) => {
      expect(resolveBootstrapUpstream(upstream)).toBe(new URL(upstream).origin);
    },
  );

  it('retains screenshot environment and explicit CLI overrides in precedence order', () => {
    vi.stubEnv('SCREENSHOT_UPSTREAM', `${UPSTREAM}/`);
    try {
      expect(resolveBootstrapUpstream()).toBe(UPSTREAM);
      expect(resolveBootstrapUpstream('http://localhost:4000/')).toBe('http://localhost:4000');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('compares manufacturer identity by exact geometry rather than a board name', () => {
    const { owned } = manufacturerHarness();
    const primary = readCppPage('kilter').primaryBoard;
    expect(boardMatchesConfig(owned[0], primary)).toBe(true);
    expect(boardMatchesConfig({ ...owned[0], setIds: '20,1' }, primary)).toBe(true);
    expect(boardMatchesConfig({ ...owned[0], sizeId: 17, name: primary.selector }, primary)).toBe(false);
  });

  it('defaults to read-only account planning and never claims queue verification', async () => {
    const harness = manufacturerHarness();
    const result = await bootstrapCppScenario(harness.options);
    expect(result.boards[0].selector).toBe(harness.owned[0].name);
    expect(result.blockers).toContainEqual(expect.stringContaining('queue verification requires --apply'));
    expect(result.scenario).toBeUndefined();
    expect(harness.join).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(
      harness.operations.every((operation) => !['CreateBoard', 'CreateSession', 'SaveTick'].includes(operation.name)),
    ).toBe(true);
  });

  it('rejects account/upstream checkpoint mismatches before any API action', async () => {
    const harness = manufacturerHarness();
    harness.options.checkpoint.accountUserId = 'another-account';
    await expect(bootstrapCppScenario(harness.options)).rejects.toThrow('another account or backend');
    expect(harness.operations).toHaveLength(0);
  });

  it('never adopts a matching board owned by someone else', async () => {
    const harness = manufacturerHarness();
    harness.owned[0].ownerId = 'unapproved-real-user';
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('PRIMARY_BOARD_UNAVAILABLE'));
    expect(result.boards.find((board) => board.uuid === harness.owned[0].uuid)).toBeUndefined();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('emits real roster aliases and gates from actual returned content after applying queue verification', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(result.scenario?.boards).toEqual(harness.owned.map((board) => board.name));
    expect(result.scenario?.cpp?.boardIds).toEqual(
      Object.fromEntries(
        [...readCppPage('kilter').heroBoards, ...readCppPage('kilter').otherBoards].map((variant, index) => [
          variant.id,
          harness.owned[index].uuid,
        ]),
      ),
    );
    expect(result.scenario?.cpp?.boardNames).toEqual(
      Object.fromEntries(
        [...readCppPage('kilter').heroBoards, ...readCppPage('kilter').otherBoards].map((variant, index) => [
          variant.id,
          harness.owned[index].name,
        ]),
      ),
    );
    expect(result.scenario?.cpp?.scenes.logbook).toMatchObject({
      readyText: genuineClimb(harness.owned[0]).name,
      ascentId: testUuid(910),
    });
    expect(result.scenario?.cpp?.scenes.status).toMatchObject({
      readyText: genuineClimb(harness.owned[0]).name,
      climbId: genuineClimb(harness.owned[0]).uuid,
    });
    expect(result.scenario?.cpp?.accessoryClimb).toEqual({
      boardId: harness.owned[0].uuid,
      climbId: testUuid(7000 + harness.owned[0].boardId),
      readyText: `Another climb on ${harness.owned[0].name}`,
      gradeLabel: 'V3',
    });
    expect(harness.operations.find((entry) => entry.name === 'GetUserGroupedAscentsFeed')?.variables).toEqual({
      userId: ACCOUNT,
      input: {
        boardType: 'kilter',
        statusMode: 'both',
        flashOnly: false,
        sortBy: 'recent',
        sortOrder: 'desc',
        limit: 20,
        offset: 0,
      },
    });
    expect(result.scenario?.cpp?.scenes.queue.sessionId).toBe(SESSION);
    expect(result.scenario?.cpp?.scenes.search.readyTextByLocale?.fr).toBeTruthy();
    expect(harness.join).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION, initializeEmpty: true }));
  });

  it.each(['/b/owned-primary/40', 'b/owned-primary/40'])(
    'reuses a dormant private permanent session with equivalent actual path %s',
    async (boardPath) => {
      const harness = manufacturerHarness();
      harness.options.apply = true;
      harness.owned[0].slug = 'owned-primary';
      Object.assign(harness.session, { boardPath, isActive: false, isPermanent: true, status: 'active' });
      const result = await bootstrapCppScenario(harness.options);
      expect(result.blockers).toEqual([]);
      expect(result.scenario?.sharedSessionId).toBe(SESSION);
      expect(harness.operations.some((operation) => operation.name === 'CreateSession')).toBe(false);
      expect(harness.join).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION, initializeEmpty: true }));
    },
  );

  it.each(['ended', 'nonpermanent'] as const)(
    'replaces only the verified checkpoint-owned %s session and preserves its record',
    async (reason) => {
      const harness = manufacturerHarness();
      harness.options.apply = true;
      const replacementId = testUuid(990);
      Object.assign(harness.session, {
        createId: replacementId,
        isActive: false,
        status: reason === 'ended' ? 'ended' : 'active',
        isPermanent: reason !== 'nonpermanent',
      });
      const result = await bootstrapCppScenario(harness.options);
      expect(result.blockers).toEqual([]);
      expect(result.scenario?.sharedSessionId).toBe(replacementId);
      expect(harness.options.checkpoint.sessionReplacements).toEqual([
        {
          target: 'kilter',
          previousSessionId: SESSION,
          newSessionId: replacementId,
          reason: reason === 'ended' ? 'ended-checkpoint' : reason,
        },
      ]);
      expect(result.actions).toContainEqual(expect.stringContaining(`previous record unchanged`));
      expect(harness.operations.filter((operation) => operation.name === 'CreateSession')).toHaveLength(1);
      expect(harness.operations.every((operation) => !['EndSession', 'DeleteSession'].includes(operation.name))).toBe(
        true,
      );
      expect(harness.join).toHaveBeenCalledWith(expect.objectContaining({ sessionId: replacementId }));
      const second = await bootstrapCppScenario(harness.options);
      expect(second.blockers).toEqual([]);
      expect(harness.operations.filter((operation) => operation.name === 'CreateSession')).toHaveLength(1);
    },
  );

  it.each(['/kilter/1/10/1,20/40', 'kilter/1/10/20,1/40'])(
    'migrates an owned private tuple checkpoint %s to the exact named QA board once',
    async (legacyPath) => {
      const harness = manufacturerHarness();
      harness.options.apply = true;
      const primary = harness.owned[0];
      const originalPublic = { ...primary, uuid: testUuid(990), slug: 'public-original', isPublic: true };
      harness.owned.unshift(originalPublic);
      harness.session.boardPath = legacyPath;
      harness.session.createId = testUuid(991);
      const oldSession = { ...harness.session };
      const result = await bootstrapCppScenario(harness.options);
      expect(result.blockers).toEqual([]);
      expect(result.scenario?.cpp?.scenes.queue).toMatchObject({ boardId: primary.uuid, sessionId: testUuid(991) });
      expect(harness.operations.find((operation) => operation.name === 'CreateSession')?.variables).toMatchObject({
        input: {
          boardPath: '/b/owned-primary/40',
          boardIds: [primary.boardId],
          isPublic: false,
          isPermanent: true,
          discoverable: true,
          audience: 'invite_only',
        },
      });
      expect(harness.join).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: testUuid(991), boardPath: '/b/owned-primary/40' }),
      );
      expect(harness.options.checkpoint.sessionReplacements).toEqual([
        { target: 'kilter', previousSessionId: oldSession.id, newSessionId: testUuid(991), reason: 'board-identity' },
      ]);
      expect(originalPublic.isPublic).toBe(true);
      expect(
        harness.operations.every(
          (operation) =>
            !['SetSessionBoardPath', 'EndSession', 'DeleteSession', 'UpdateBoard'].includes(operation.name),
        ),
      ).toBe(true);
      await bootstrapCppScenario(harness.options);
      expect(harness.operations.filter((operation) => operation.name === 'CreateSession')).toHaveLength(1);
    },
  );

  it.each(['missing-slug', 'other-uuid', 'foreign-owner', 'public', 'geometry'] as const)(
    'rejects a %s named-board identity before any metadata, tick or queue write',
    async (failure) => {
      const harness = manufacturerHarness();
      harness.options.apply = true;
      const primary = harness.owned[0];
      if (failure === 'missing-slug') primary.slug = undefined;
      const request = harness.options.transport.request;
      harness.options.transport.request = async <T>(
        query: string,
        variables: Record<string, unknown> = {},
      ): Promise<T> => {
        if (getOperationAST(parse(query))?.name?.value === 'GetBoardBySlug') {
          const namedBoard = { ...primary };
          if (failure === 'other-uuid') namedBoard.uuid = testUuid(989);
          if (failure === 'foreign-owner') namedBoard.ownerId = testUuid(989);
          if (failure === 'public') namedBoard.isPublic = true;
          if (failure === 'geometry') namedBoard.sizeId += 1;
          return { boardBySlug: namedBoard } as T;
        }
        return request<T>(query, variables);
      };
      const result = await bootstrapCppScenario(harness.options);
      expect(result.scenario).toBeUndefined();
      expect(result.blockers).toContainEqual(expect.stringContaining('PRIMARY_BOARD_SLUG_'));
      expect(
        harness.operations.some((operation) =>
          ['CppBootstrapProfile', 'UpdateProfile', 'CreateBoard', 'UpdateBoard', 'SaveTick', 'CreateSession'].includes(
            operation.name,
          ),
        ),
      ).toBe(false);
      expect(harness.join).not.toHaveBeenCalled();
      expect(harness.save).not.toHaveBeenCalled();
    },
  );

  it('retains a migrated named-session checkpoint when queue initialization fails and resumes without a duplicate', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.session.boardPath = '/kilter/1/10/1,20/40';
    harness.session.createId = testUuid(991);
    harness.join.mockRejectedValueOnce(new Error('Join interrupted'));
    await expect(bootstrapCppScenario(harness.options)).rejects.toThrow('Join interrupted');
    expect(harness.options.checkpoint.sessions.kilter).toBe(testUuid(991));
    const resumed = await bootstrapCppScenario(harness.options);
    expect(resumed.blockers).toEqual([]);
    expect(harness.operations.filter((operation) => operation.name === 'CreateSession')).toHaveLength(1);
  });

  it('rejects actual spray geometry drift even when a slug still resolves the same owned UUID', async () => {
    const harness = manufacturerHarness();
    Object.assign(harness.options, { target: 'spray', apply: true });
    const primary = harness.owned[0];
    Object.assign(primary, { boardType: 'spray', layoutId: 47, sizeId: 47, setIds: '1' });
    harness.options.bindings = { 'spray-liz': primary.uuid };
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      const operation = getOperationAST(parse(query))?.name?.value;
      if (operation === 'GetMySprayWallLifecycle') return { mySprayWalls: [] } as T;
      if (operation === 'GetBoardBySlug') return { boardBySlug: { ...primary, sizeId: 48 } } as T;
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('PRIMARY_BOARD_SLUG_CONFIGURATION_MISMATCH'));
    expect(harness.operations.some((operation) => operation.name === 'CppBootstrapProfile')).toBe(false);
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.join).not.toHaveBeenCalled();
  });

  it('rereads persisted named path and refuses queue setup when creation stored a different angle', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.session.boardPath = '/kilter/1/10/1,20/40';
    harness.session.createId = testUuid(991);
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      const response = await request<T>(query, variables);
      if (getOperationAST(parse(query))?.name?.value === 'CreateSession')
        harness.session.boardPath = '/b/owned-primary/0';
      return response;
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.scenario).toBeUndefined();
    expect(result.blockers).toContainEqual(
      expect.stringContaining('created session failed persisted verification (reason=BOARD_CONFIGURATION_MISMATCH'),
    );
    expect(harness.options.checkpoint.sessions.kilter).toBe(testUuid(991));
    expect(harness.join).not.toHaveBeenCalled();
    await bootstrapCppScenario(harness.options);
    expect(harness.operations.filter((operation) => operation.name === 'CreateSession')).toHaveLength(1);
  });

  it.each(['missing', 'foreign', 'configuration', 'public', 'unavailable'] as const)(
    'diagnoses a %s saved binding without creating a replacement',
    async (failure) => {
      const harness = manufacturerHarness();
      harness.options.apply = true;
      if (failure === 'missing') harness.session.listed = false;
      if (failure === 'foreign') harness.session.createdByUserId = testUuid(900);
      if (failure === 'configuration') harness.session.boardPath = '/kilter/1/10/1,20/0';
      if (failure === 'public') harness.session.isPublic = true;
      if (failure === 'unavailable') harness.session.status = null;
      const result = await bootstrapCppScenario(harness.options);
      expect(result.scenario).toBeUndefined();
      expect(result.blockers).toContainEqual(expect.stringContaining('saved session binding rejected (reason='));
      expect(result.blockers).toContainEqual(
        expect.stringContaining('checkpoint retained and no replacement session created'),
      );
      expect(harness.operations.some((operation) => operation.name === 'CppBootstrapSessionStatus')).toBe(true);
      expect(harness.operations.some((operation) => operation.name === 'CreateSession')).toBe(false);
      expect(
        harness.operations.some((operation) =>
          ['CppBootstrapProfile', 'UpdateProfile', 'UpdateBoard', 'CreateBoard', 'SaveTick'].includes(operation.name),
        ),
      ).toBe(false);
      expect(harness.options.checkpoint.sessions.kilter).toBe(SESSION);
      expect(harness.join).not.toHaveBeenCalled();
    },
  );

  it('creates a fresh permanent session for an ended checkpoint absent from the recent listing without claiming old ownership', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    Object.assign(harness.session, { listed: false, status: 'ended', createId: testUuid(990) });
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(result.scenario?.sharedSessionId).toBe(testUuid(990));
    expect(harness.options.checkpoint.sessionReplacements).toEqual([
      { target: 'kilter', previousSessionId: SESSION, newSessionId: testUuid(990), reason: 'ended-checkpoint' },
    ]);
    expect(harness.operations.filter((operation) => operation.name === 'CreateSession')).toHaveLength(1);
    expect(harness.operations.every((operation) => !['EndSession', 'DeleteSession'].includes(operation.name))).toBe(
      true,
    );
  });

  it('never replaces an unrelated live nonpermanent session', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.options.checkpoint.sessions = {};
    harness.session.isPermanent = false;
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('reason=SESSION_NOT_PERMANENT'));
    expect(harness.operations.some((operation) => operation.name === 'CreateSession')).toBe(false);
    expect(harness.join).not.toHaveBeenCalled();
  });

  it('rereads actual permanence after creation and leaves queue untouched when HTTP only echoed it', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.session.status = 'ended';
    harness.session.createId = testUuid(990);
    harness.session.persistPermanent = false;
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(
      expect.stringContaining('created session failed persisted verification (reason=SESSION_NOT_PERMANENT'),
    );
    expect(harness.options.checkpoint.sessions.kilter).toBe(testUuid(990));
    expect(result.scenario).toBeUndefined();
    expect(harness.join).not.toHaveBeenCalled();
  });

  it('requires the exact verified board geometry for both tuple and named session paths', () => {
    const harness = manufacturerHarness();
    const board = { ...harness.owned[0], slug: 'owned-primary' };
    for (const path of [
      '/kilter/1/17/1,20/40',
      '/kilter/1/10/1,20/0',
      '/tension/1/10/1,20/40',
      '/b/someone-elses-board/40',
      '/b/owned-primary/0',
      '/b/owned-primary',
      '/kilter/1/10/1,20/40/arbitrary',
    ]) {
      expect(sessionPathMatchesBoard(path, board)).toBe(false);
    }
  });

  it('keeps verified real board names distinct when two configured boards share a first-climb title', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const seven = harness.owned[1];
    const ten = harness.owned[2];
    seven.name = "Alex's Kilter Homewall 7×10";
    ten.name = "Alex's Kilter Homewall 10×10";
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'SearchClimbs') {
        const input = variables.input as { boardName: string; layoutId: number; sizeId: number };
        const actual = [seven, ten].find(
          (board) =>
            board.boardType === input.boardName && board.layoutId === input.layoutId && board.sizeId === input.sizeId,
        );
        if (actual) {
          validateActualInput('SearchClimbs', variables);
          return {
            searchClimbs: {
              climbs: [
                { ...genuineClimb(actual), name: 'Moon Landing' },
                {
                  ...genuineClimb(actual),
                  uuid: testUuid(actual.sizeId + 400),
                  name: `Real alternative ${actual.sizeId}`,
                },
              ],
            },
          } as T;
        }
      }
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    const variants = readCppPage('kilter').heroBoards;
    expect(result.scenario?.cpp?.boardReadyText[variants[1].id]).toBe('Moon Landing');
    expect(result.scenario?.cpp?.boardReadyText[variants[2].id]).toBe('Moon Landing');
    expect(result.scenario?.cpp?.boardNames).toMatchObject({
      [variants[1].id]: seven.name,
      [variants[2].id]: ten.name,
    });
    expect(result.scenario?.cpp?.boardIds).toMatchObject({ [variants[1].id]: seven.uuid, [variants[2].id]: ten.uuid });
    expect(result.scenario?.cpp?.boardNames?.[variants[1].id]).not.toBe(variants[1].selector);
    expect(result.scenario?.cpp?.boardNames?.[variants[2].id]).not.toBe(variants[2].selector);
  });

  it('preserves the genuine Aurora compact first-climb identifier for tablet status proof', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const actualPrimary = harness.owned[0];
    const recordedAuroraId = 'D0E5387D5B974D38B4E93FC4DFD61EF6';
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      const input = variables.input as { boardName?: string; layoutId?: number; sizeId?: number } | undefined;
      if (
        getOperationAST(parse(query))?.name?.value === 'SearchClimbs' &&
        input?.boardName === actualPrimary.boardType &&
        input.layoutId === actualPrimary.layoutId &&
        input.sizeId === actualPrimary.sizeId
      )
        return {
          searchClimbs: {
            climbs: [
              { ...genuineClimb(actualPrimary), uuid: recordedAuroraId },
              { ...genuineClimb(actualPrimary), uuid: testUuid(7999), name: 'Actual accessory problem' },
            ],
          },
        } as T;
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(result.scenario?.cpp?.scenes.status.climbId).toBe(recordedAuroraId);
    expect(result.scenario?.cpp?.scenes.status.climbId).not.toBe(recordedAuroraId.toLowerCase());
    expect(result.scenario?.cpp?.scenes.status.readyText).toBe(genuineClimb(actualPrimary).name);
  });

  it('resumes checkpoint-owned session initialization after a failed queue join', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.join.mockRejectedValueOnce(new Error('Join interrupted'));
    await expect(bootstrapCppScenario(harness.options)).rejects.toThrow('Join interrupted');
    expect(harness.options.checkpoint.sessions.kilter).toBe(SESSION);
    const result = await bootstrapCppScenario(harness.options);
    expect(result.scenario?.cpp?.scenes.queue.sessionId).toBe(SESSION);
    expect(harness.operations.filter((operation) => operation.name === 'CreateSession')).toHaveLength(0);
    expect(harness.join).toHaveBeenLastCalledWith(expect.objectContaining({ initializeEmpty: true }));
  });

  it('refuses an empty existing queue instead of emitting a fabricated gate', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.options.checkpoint.sessions = {};
    harness.join.mockResolvedValue({ queue: [] });
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('actual shared session queue'));
    expect(result.scenario).toBeUndefined();
    expect(harness.join).toHaveBeenCalledWith(expect.objectContaining({ initializeEmpty: false }));
  });

  it('writes illustrative attempts only with explicit seed flag and only-me privacy', async () => {
    const harness = manufacturerHarness();
    Object.assign(harness.options, { testRecordedAscent: false });
    harness.options.apply = true;
    let result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('no genuine rendered logbook representative'));
    expect(harness.operations.some((operation) => operation.name === 'SaveTick')).toBe(false);
    harness.options.seedDemoContent = true;
    result = await bootstrapCppScenario(harness.options);
    const tick = harness.operations.find((operation) => operation.name === 'SaveTick')!;
    expect(tick.variables.input).toMatchObject({
      status: 'attempt',
      privacy: { audience: 'only_me', privacyRevision: 7 },
      comment: expect.stringContaining('example attempt'),
    });
    expect(result.blockers).toEqual([]);
    expect(result.scenario?.cpp?.scenes.logbook.ascentId).toBe((tick.variables.input as { uuid: string }).uuid);
  });

  it('refuses to invent fields missing from the real queue climb', () => {
    const { owned } = manufacturerHarness();
    expect(queueClimb(genuineClimb(owned[0]))).toMatchObject({
      uuid: genuineClimb(owned[0]).uuid,
      boardType: 'kilter',
    });
    expect(() => queueClimb({ ...genuineClimb(owned[0]), stars: undefined } as unknown as ClimbInput)).toThrow(
      'refusing invented fields',
    );
  });
});

describe('genuine grouped logbook coverage', () => {
  it('uses the older flash UUID that native renders instead of a newer attempt UUID', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const board = harness.owned[0];
    const flash = genuineAscent(board, { uuid: testUuid(911), status: 'flash', climbedAt: '2026-10-12T09:00:00' });
    const attempt = genuineAscent(board, { uuid: testUuid(912), status: 'attempt', climbedAt: '2026-10-12T11:00:00' });
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'GetUserGroupedAscentsFeed') {
        expect(validate(API_SCHEMA, parse(query))).toEqual([]);
        validateActualInput('GetUserGroupedAscentsFeed', variables);
        expect(variables).toEqual({
          userId: ACCOUNT,
          input: {
            boardType: 'kilter',
            statusMode: 'both',
            flashOnly: false,
            sortBy: 'recent',
            sortOrder: 'desc',
            limit: 20,
            offset: 0,
          },
        });
        return { userGroupedAscentsFeed: { groups: [{ items: [attempt, flash] }] } } as T;
      }
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toEqual([]);
    expect(result.scenario?.cpp?.scenes.logbook).toMatchObject({ ascentId: flash.uuid, readyText: flash.climbName });
    expect(result.scenario?.cpp?.scenes.logbook.ascentId).not.toBe(attempt.uuid);
  });

  it('keeps graded-over-ungraded and time tie-breaks from the shared native picker', () => {
    const board = manufacturerHarness().owned[0];
    const newestUngraded = genuineAscent(board, {
      uuid: testUuid(913),
      status: 'send',
      climbedAt: '2026-10-12T12:00:00',
    });
    const olderGraded = genuineAscent(board, {
      uuid: testUuid(914),
      status: 'send',
      difficulty: 17,
      climbedAt: '2026-10-12T09:00:00',
    });
    const newerGraded = genuineAscent(board, {
      uuid: testUuid(915),
      status: 'send',
      difficulty: 17,
      climbedAt: '2026-10-12T10:00:00',
    });
    expect(selectCppLogbookAscent([{ items: [newestUngraded, olderGraded, newerGraded] }], board)?.uuid).toBe(
      newerGraded.uuid,
    );
  });

  it('selects a genuine superset-best row across backend UTC days so local-day boundaries cannot hide it', () => {
    const board = manufacturerHarness().owned[0];
    const flash = genuineAscent(board, { uuid: testUuid(916), status: 'flash', climbedAt: '2026-10-11T23:30:00' });
    const attempt = genuineAscent(board, { uuid: testUuid(917), climbedAt: '2026-10-12T01:00:00' });
    expect(selectCppLogbookAscent([{ items: [attempt] }, { items: [flash] }], board)?.uuid).toBe(flash.uuid);
  });

  it('preserves mirror and angle bucket identities before choosing primary geometry', () => {
    const board = manufacturerHarness().owned[0];
    const primary = genuineAscent(board, { uuid: testUuid(918) });
    const mirrored = genuineAscent(board, {
      uuid: testUuid(919),
      isMirror: true,
      status: 'flash',
      climbedAt: '2026-10-11T10:00:00',
    });
    const differentAngle = genuineAscent(board, {
      uuid: testUuid(920),
      angle: 50,
      status: 'flash',
      climbedAt: '2026-10-12T12:00:00',
    });
    expect(selectCppLogbookAscent([{ items: [differentAngle, primary, mirrored] }], board)?.uuid).toBe(primary.uuid);
  });

  it('does not invent a preferred primary row by dropping the better entry on another configuration', () => {
    const board = manufacturerHarness().owned[0];
    const primaryAttempt = genuineAscent(board, { uuid: testUuid(921) });
    const otherSizeFlash = genuineAscent(board, {
      uuid: testUuid(922),
      status: 'flash',
      renderBoard: { sizeId: 999, setIds: [1, 20] },
    });
    expect(selectCppLogbookAscent([{ items: [primaryAttempt, otherSizeFlash] }], board)).toBeUndefined();
  });

  it('does not seed a needless attempt when real primary rows exist but the rendered global winner is another size', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.options.seedDemoContent = true;
    const primaryAttempt = genuineAscent(harness.owned[0], { uuid: testUuid(923) });
    const otherSizeFlash = genuineAscent(harness.owned[0], {
      uuid: testUuid(924),
      status: 'flash',
      renderBoard: { sizeId: 999, setIds: [1, 20] },
    });
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'GetUserGroupedAscentsFeed')
        return { userGroupedAscentsFeed: { groups: [{ items: [primaryAttempt, otherSizeFlash] }] } } as T;
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(
      expect.stringContaining('primary logbook entries exist but have no guaranteed rendered representative'),
    );
    expect(harness.operations.some((operation) => operation.name === 'SaveTick')).toBe(false);
    expect(harness.options.checkpoint.demoTicks).toBeUndefined();
    expect(result.scenario).toBeUndefined();
    harness.options.checkpoint.demoTicks = { kilter: primaryAttempt.uuid };
    const resumed = await bootstrapCppScenario(harness.options);
    expect(resumed.blockers).toContainEqual(
      expect.stringContaining(`checkpointed demo attempt ${primaryAttempt.uuid}`),
    );
    expect(harness.operations.some((operation) => operation.name === 'SaveTick')).toBe(false);
    expect(resumed.actions.some((action) => action.includes('created one'))).toBe(false);
    expect(harness.options.checkpoint.demoTicks.kilter).toBe(primaryAttempt.uuid);
  });

  it('resumes a saved-before-write UUID without claiming a fresh creation when its grouped readback stays unavailable', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    harness.options.seedDemoContent = true;
    const demoId = testUuid(925);
    harness.options.checkpoint.demoTicks = { kilter: demoId };
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'GetUserGroupedAscentsFeed')
        return { userGroupedAscentsFeed: { groups: [] } } as T;
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining(`checkpointed demo attempt ${demoId}`));
    expect(result.actions).toContainEqual(expect.stringContaining('resumed checkpointed private example attempt'));
    expect(result.actions.some((action) => action.includes('created one'))).toBe(false);
    expect(harness.operations.find((operation) => operation.name === 'SaveTick')?.variables.input).toMatchObject({
      uuid: demoId,
    });
    expect(harness.options.checkpoint.demoTicks.kilter).toBe(demoId);
    expect(result.scenario).toBeUndefined();
  });

  it('blocks a missing first-page primary representative and never fabricates an ascent ID', async () => {
    const harness = manufacturerHarness();
    harness.options.apply = true;
    const request = harness.options.transport.request;
    harness.options.transport.request = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<T> => {
      if (getOperationAST(parse(query))?.name?.value === 'GetUserGroupedAscentsFeed')
        return {
          userGroupedAscentsFeed: {
            groups: [{ items: [genuineAscent(harness.owned[0], { renderBoard: { sizeId: 999, setIds: [1, 20] } })] }],
          },
        } as T;
      return request<T>(query, variables);
    };
    const result = await bootstrapCppScenario(harness.options);
    expect(result.blockers).toContainEqual(expect.stringContaining('first grouped family page'));
    expect(result.scenario).toBeUndefined();
    expect(harness.operations.some((operation) => operation.name === 'SaveTick')).toBe(false);
  });

  it('rejects a malformed API ascent UUID and deduplicates repeated real entries', () => {
    const board = manufacturerHarness().owned[0];
    const invalid = genuineAscent(board, { uuid: 'fabricated-id' });
    expect(selectCppLogbookAscent([{ items: [invalid] }], board)).toBeUndefined();
    const genuine = genuineAscent(board);
    expect(selectCppLogbookAscent([{ items: [genuine] }, { items: [genuine] }], board)?.uuid).toBe(genuine.uuid);
  });
});

describe('real spray-photo provenance', () => {
  it('uses the original photo and real detector result through version/hold/publish APIs', async () => {
    const harness = manufacturerHarness();
    const variant = readCppPage('spray').heroBoards[1];
    const original = readFileSync(variant.photo!);
    const sourceSha256 = createHash('sha256').update(original).digest('hex');
    const wall = {
      uuid: testUuid(700),
      board: { ...harness.owned[0], uuid: testUuid(700), boardType: 'spray' },
      currentVersion: null,
      holdCount: 0,
    };
    const photoSize = await sharp(original).metadata();
    const version = {
      id: '40',
      number: 1,
      status: 'DRAFT',
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      photo: { url: 'https://photo.example.test/original', width: photoSize.width!, height: photoSize.height! },
    };
    const detection = {
      id: 'detector-job',
      status: 'done',
      error: null,
      result: {
        width: photoSize.width!,
        height: photoSize.height!,
        candidates: [{ cx: 100.2, cy: 200.3, r: 15.1, confidence: 0.96 }],
      },
    };
    const writes: Array<{ name: string; variables: Record<string, unknown> }> = [];
    harness.options.apply = true;
    harness.options.checkpoint.boards[variant.id] = { uuid: wall.uuid };
    harness.options.transport = {
      ...harness.options.transport,
      upload: vi.fn(async (_uuid, bytes) => {
        expect(bytes).toEqual(original);
        return { photoId: testUuid(702) };
      }),
      bytes: vi.fn(async () => original),
      async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
        expect(validate(API_SCHEMA, parse(query))).toEqual([]);
        const name = getOperationAST(parse(query))?.name?.value ?? '';
        validateActualInput(name, variables);
        writes.push({ name, variables });
        let response: unknown;
        switch (name) {
          case 'GetSprayWallWithVersions':
            response = { sprayWall: { ...wall, versions: [] } };
            break;
          case 'CreateSprayWallVersion':
            response = { createSprayWallVersion: version };
            break;
          case 'SprayDetection':
            response = { sprayWallDetectionForVersion: null };
            break;
          case 'RequestSprayDetection':
            response = { requestSprayWallDetection: detection };
            break;
          case 'GetSprayWallDraftRenderData':
            response = { sprayWallRenderData: { holds: [] } };
            break;
          case 'UpsertSprayWallHolds':
            response = { upsertSprayWallHolds: [{ id: 7 }] };
            break;
          case 'PublishSprayWallVersion':
            response = { publishSprayWallVersion: { ...version, status: 'PUBLISHED' } };
            break;
          default:
            throw new Error(`Unexpected operation ${name}`);
        }
        return response as T;
      },
    };
    expect(await ensureSprayPhoto(harness.options, variant, wall, [])).toBeNull();
    expect(writes.find((entry) => entry.name === 'CreateSprayWallVersion')?.variables.input).toEqual({
      wallUuid: wall.uuid,
      photoId: testUuid(702),
    });
    expect(writes.find((entry) => entry.name === 'UpsertSprayWallHolds')?.variables.input).toMatchObject({
      wallUuid: wall.uuid,
      versionId: version.id,
      holds: [{ cx: 100, cy: 200, r: 15, source: 'AUTO', confidence: 0.96 }],
    });
    expect(writes.at(-1)?.name).toBe('PublishSprayWallVersion');
    expect(harness.options.checkpoint.boards[variant.id]).toMatchObject({
      sourceSha256,
      photoId: testUuid(702),
      versionId: '40',
    });
  });

  it('records explicit visual acceptance separately from byte identity and never replaces a published photo', async () => {
    const harness = manufacturerHarness();
    const variant = readCppPage('spray').heroBoards[0];
    const source = readFileSync(variant.photo!);
    const differentStoredBytes = readFileSync(readCppPage('spray').heroBoards[1].photo!);
    const wall = {
      uuid: testUuid(701),
      board: { ...harness.owned[0], uuid: testUuid(701), boardType: 'spray' },
      holdCount: 4,
      currentVersion: {
        id: '1',
        number: 1,
        status: 'PUBLISHED',
        homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        photo: { url: 'https://photo.example.test/liz', width: 100, height: 100 },
      },
    };
    harness.options.apply = true;
    harness.options.transport.bytes = vi.fn(async () => differentStoredBytes);
    harness.options.transport.request = async <T>(query: string): Promise<T> => {
      expect(getOperationAST(parse(query))?.name?.value).toBe('GetSprayWallWithVersions');
      return { sprayWall: wall } as T;
    };
    expect(await ensureSprayPhoto(harness.options, variant, wall, [])).toContain('visually verify');
    expect(harness.save).not.toHaveBeenCalled();
    harness.options.bindings = { [variant.id]: wall.uuid };
    harness.options.acceptSourceBindings = true;
    harness.options.acceptedSourcePhotoSha256 = {
      [variant.id]: createHash('sha256').update(differentStoredBytes).digest('hex'),
    };
    expect(await ensureSprayPhoto(harness.options, variant, wall, [])).toBeNull();
    expect(harness.options.checkpoint.boards[variant.id]).toMatchObject({
      provenance: 'visually-accepted',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      storedPhotoSha256: createHash('sha256').update(differentStoredBytes).digest('hex'),
    });
    expect(harness.operations).toEqual([]);
    expect(harness.options.transport.upload).not.toHaveBeenCalled();
    harness.save.mockClear();
    const changedLivePhoto = readFileSync(readCppPage('spray').heroBoards[2].photo!);
    harness.options.transport.bytes = vi.fn(async () => changedLivePhoto);
    expect(await ensureSprayPhoto(harness.options, variant, wall, [])).toContain('visually verify');
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('recognizes JPEG recompression of the same actual supplied wall without asserting matching byte hashes', async () => {
    const original = readFileSync('app-stores/apple/cpp-source-photos/bowlo.jpg');
    const compressed = await sharp(original)
      .rotate()
      .resize(1024, 1024, { fit: 'inside' })
      .jpeg({ quality: 88 })
      .toBuffer();
    expect(createHash('sha256').update(original).digest('hex')).not.toBe(
      createHash('sha256').update(compressed).digest('hex'),
    );
    expect(await photosMatch(original, compressed)).toBe(true);
  });

  it('rejects two distinct supplied walls', async () => {
    const liz = readFileSync('app-stores/apple/cpp-source-photos/lizfinal.JPG');
    const cherry = readFileSync('app-stores/apple/cpp-source-photos/cherry4.JPG');
    expect(await photosMatch(liz, cherry)).toBe(false);
  });
});
