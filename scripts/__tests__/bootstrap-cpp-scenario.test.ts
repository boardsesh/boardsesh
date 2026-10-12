import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse, getOperationAST, buildSchema, validate } from 'graphql';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  boardMatchesConfig,
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
  GetUserAscentsFeed: AscentFeedInputSchema,
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
    difficulty: '17',
    difficulty_error: '0',
    quality_average: '3',
    stars: 3,
  };
}

function manufacturerHarness(): {
  options: BootstrapOptions;
  owned: BootstrapBoard[];
  operations: Array<{ name: string; variables: Record<string, unknown> }>;
  join: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
} {
  const page = readCppPage('kilter');
  const owned = [...page.heroBoards, ...page.otherBoards].map((variant, index): BootstrapBoard => ({
    uuid: testUuid(index + 1),
    name: `My actual ${variant.selector}`,
    ownerId: ACCOUNT,
    canEdit: true,
    boardId: index + 1,
    boardType: variant.boardType,
    layoutId: variant.layoutId!,
    sizeId: variant.sizeId!,
    setIds: variant.setIds!.join(','),
    angle: variant.angle!,
  }));
  const operations: Array<{ name: string; variables: Record<string, unknown> }> = [];
  let recordedAscent = true;
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
        case 'GetMyBoards':
          response = { myBoards: { boards: owned, hasMore: false } };
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
          response = { searchClimbs: { climbs: [genuineClimb(board)] } };
          break;
        }
        case 'GetUserAscentsFeed':
          response = {
            userAscentsFeed: {
              items: recordedAscent
                ? [
                    {
                      climbName: genuineClimb(owned[0]).name,
                      boardType: owned[0].boardType,
                      layoutId: owned[0].layoutId,
                      angle: owned[0].angle,
                      renderBoard: { sizeId: owned[0].sizeId, setIds: owned[0].setIds.split(',').map(Number) },
                    },
                  ]
                : [],
            },
          };
          break;
        case 'BoardLiveSessions':
          response = { boardLiveSessions: [{ sessionId: SESSION, host: { userId: ACCOUNT } }] };
          break;
        case 'CppBootstrapSessionStatus':
          response = { sessionStatus: 'active' };
          break;
        case 'CreateSession':
          response = { createSession: { id: SESSION } };
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
            uuid: testUuid(500),
            ownerId: ACCOUNT,
            canEdit: true,
            boardId: 500,
          };
          owned.push(board);
          response = { createBoard: board };
          break;
        }
        case 'CppBootstrapOwnedSessions':
          response = {
            mySessions: [{ id: SESSION, boardPath: '/kilter/1/10/1,20/40', createdByUserId: ACCOUNT, isActive: true }],
          };
          break;
        case 'PrivacySettings':
          response = { privacySettings: { enabled: true, privacyRevision: 7 } };
          break;
        case 'SaveTick':
          recordedAscent = true;
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
  return { options, owned, operations, join, save };
}

function sprayRenameHarness(variantIndex = 0) {
  const harness = manufacturerHarness();
  const variant = readCppPage('spray').heroBoards[variantIndex];
  const source = readFileSync(variant.photo!);
  let board: BootstrapBoard = {
    ...harness.owned[0],
    uuid: testUuid(700 + variantIndex),
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
      if (name === 'GetMySprayWallLifecycle')
        return {
          mySprayWalls: sprayBoards.map((board, index) => ({
            uuid: board.uuid,
            archivedAt: index === 8 ? '2026-10-01T00:00:00Z' : null,
            board: { uuid: board.uuid, name: board.name },
          })),
        } as T;
      if (name === 'GetSprayWallWithVersions') return { sprayWall: walls[0] } as T;
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
      if (getOperationAST(parse(query))?.name?.value === 'GetUserAscentsFeed') {
        validateActualInput('GetUserAscentsFeed', variables);
        const board = activePrimary();
        return {
          userAscentsFeed: {
            items: [
              {
                climbName: genuineClimb(board).name,
                boardType: board.boardType,
                layoutId: board.layoutId,
                angle: board.angle,
                renderBoard: { sizeId: board.sizeId, setIds: board.setIds.split(',').map(Number) },
              },
            ],
          },
        } as T;
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
      discoverable: false,
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
    expect(result.blockers).toContainEqual(expect.stringContaining('missing owned board'));
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
    expect(result.scenario?.cpp?.scenes.logbook.readyText).toBe(genuineClimb(harness.owned[0]).name);
    expect(result.scenario?.cpp?.scenes.queue.sessionId).toBe(SESSION);
    expect(result.scenario?.cpp?.scenes.search.readyTextByLocale?.fr).toBeTruthy();
    expect(harness.join).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION, initializeEmpty: true }));
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
    expect(result.blockers).toContainEqual(expect.stringContaining('no logbook entry'));
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
    expect(result.scenario).toBeDefined();
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
