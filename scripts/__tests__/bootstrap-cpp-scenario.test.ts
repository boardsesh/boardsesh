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
  queueClimb,
  type BootstrapBoard,
  type BootstrapCheckpoint,
  type BootstrapOptions,
  type BootstrapTransport,
} from '../bootstrap-cpp-scenario';
import { readCppPage } from '../lib/screenshot-cpp';
import { typeDefs } from '../../packages/shared-schema/src/schema';
import type { ClimbInput } from '../../packages/shared-schema/src/generated/types';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPSTREAM = 'https://backend.example.test';
const API_SCHEMA = buildSchema(typeDefs.join('\n'));

function genuineClimb(board: BootstrapBoard): ClimbInput {
  return {
    uuid: `climb-${board.uuid}`,
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
    uuid: `owned-board-${index}`,
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
  const join = vi.fn(async () => ({ queue: [{ uuid: 'real-queue-item', climb: genuineClimb(owned[0]) }] }));
  const transport: BootstrapTransport = {
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      expect(validate(API_SCHEMA, parse(query))).toEqual([]);
      const name = getOperationAST(parse(query))?.name?.value ?? '';
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

describe('CPP account/bootstrap safety', () => {
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
      comment: expect.stringContaining('not a physical ascent'),
    });
    expect(result.blockers).toEqual([]);
    expect(result.scenario).toBeDefined();
  });

  it('refuses to invent fields missing from the real queue climb', () => {
    const { owned } = manufacturerHarness();
    expect(queueClimb(genuineClimb(owned[0]))).toMatchObject({ uuid: `climb-${owned[0].uuid}`, boardType: 'kilter' });
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
      uuid: 'our-new-wall',
      board: { ...harness.owned[0], uuid: 'our-new-wall', boardType: 'spray' },
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
        return { photoId: 'original-upload' };
      }),
      bytes: vi.fn(async () => original),
      async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
        expect(validate(API_SCHEMA, parse(query))).toEqual([]);
        const name = getOperationAST(parse(query))?.name?.value ?? '';
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
      photoId: 'original-upload',
    });
    expect(writes.find((entry) => entry.name === 'UpsertSprayWallHolds')?.variables.input).toMatchObject({
      wallUuid: wall.uuid,
      versionId: version.id,
      holds: [{ cx: 100, cy: 200, r: 15, source: 'AUTO', confidence: 0.96 }],
    });
    expect(writes.at(-1)?.name).toBe('PublishSprayWallVersion');
    expect(harness.options.checkpoint.boards[variant.id]).toMatchObject({
      sourceSha256,
      photoId: 'original-upload',
      versionId: '40',
    });
  });

  it('records explicit visual acceptance separately from byte identity and never replaces a published photo', async () => {
    const harness = manufacturerHarness();
    const variant = readCppPage('spray').heroBoards[0];
    const source = readFileSync(variant.photo!);
    const differentStoredBytes = readFileSync(readCppPage('spray').heroBoards[1].photo!);
    const wall = {
      uuid: 'approved-existing-liz',
      board: { ...harness.owned[0], uuid: 'approved-existing-liz', boardType: 'spray' },
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
