/**
 * The place-card privacy matrix against the real test Postgres and the real
 * GraphQL schema. Only the renderer, the rate limiter, the photo fetch and the
 * media bucket are stubbed, so a refused card proves it never reached the byte
 * cache, the photo host or a read-cap slot.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { getOperationAST, type DocumentNode } from 'graphql';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { OgFamilyCardContent } from '@boardsesh/board-render/og-family';
import { db } from '../db/client';
import type { LoadedOgFamilyCard } from '../services/og-family/card-model';

const { renderFamily, documentsRun, fetchImage, cardReads, photoReads } = vi.hoisted(() => ({
  renderFamily: vi.fn(),
  documentsRun: [] as string[],
  fetchImage: vi.fn(),
  cardReads: { count: 0 },
  photoReads: { count: 0 },
}));
vi.mock('../services/og-family/run-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/og-family/run-document')>();
  return {
    ...actual,
    runOgDocument: async (document: DocumentNode, variables: Record<string, unknown>, context: ConnectionContext) => {
      documentsRun.push(getOperationAST(document)?.name?.value ?? 'anonymous');
      return actual.runOgDocument(document, variables, context);
    },
  };
});
vi.mock('../services/og-family/card-read-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/og-family/card-read-limit')>();
  return {
    ...actual,
    runCardRead: <T>(read: () => Promise<T>) => {
      cardReads.count += 1;
      return actual.runCardRead(read);
    },
    runPhotoRead: <T>(read: () => Promise<T>) => {
      photoReads.count += 1;
      return actual.runPhotoRead(read);
    },
  };
});
vi.mock('../lib/safe-image-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/safe-image-fetch')>()),
  fetchAllowedImage: fetchImage,
}));
vi.mock('../storage/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/s3')>()),
  isS3Configured: () => true,
  getPublicUrl: (_bucket: string, key: string) => `https://media.boardsesh.com/${key}`,
  getMediaPublicBaseUrl: () => 'https://media.boardsesh.com',
}));
vi.mock('../services/board-render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/board-render')>()),
  ensureBoardRendererAvailable: vi.fn(async () => true),
  renderOgFamilyArt: renderFamily,
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));

import { handleOgPlace } from '../handlers/og-family';
import { ensureBoardRendererAvailable } from '../services/board-render';
import { TransientImageFetchError, UnsafeImageHostError } from '../lib/safe-image-fetch';
import { resetOgFamilyLoadCaches } from '../services/og-family/load-cards';

const OWNER = 'og-place-owner';
const KILTER_FRAMES = 'p1140r12p1155r15';
const WALL_FRAMES = 'p9001r1p9002r2';
const NOT_FOUND_BODY = '{"error":"Not found"}';

type MockRes = {
  statusCode: number;
  body: string | Buffer | undefined;
  headers: Record<string, unknown>;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  end: (body?: string | Buffer) => void;
  setHeader: (name: string, value: unknown) => void;
};

function makeRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      if (body !== undefined) this.body = body;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
}

async function requestPlace(query: string, headers: Record<string, string> = {}) {
  const res = makeRes();
  await handleOgPlace(
    makeReq(headers),
    res as unknown as ServerResponse,
    new URL(`http://localhost/og/place?${query}`),
  );
  return res;
}

const requestGym = (slug: string) => requestPlace(`kind=gym&slug=${slug}`);
const requestBoard = (slug: string) => requestPlace(`kind=board&slug=${slug}`);

function expectRefused(res: MockRes) {
  expect(res.statusCode).toBe(404);
  expect(res.body).toBe(NOT_FOUND_BODY);
  expect(res.headers['Cache-Control']).toBe('no-store');
  expect(renderFamily).not.toHaveBeenCalled();
  expect(fetchImage).not.toHaveBeenCalled();
  expect(cardReads.count).toBe(0);
  expect(photoReads.count).toBe(0);
}

function renderedCard(): LoadedOgFamilyCard {
  const params = renderFamily.mock.calls.at(-1)?.[0] as Omit<LoadedOgFamilyCard, 'digest'>;
  return { digest: '', art: params.art, photo: params.photo, content: params.content };
}

function drawnText(content: OgFamilyCardContent): string {
  return [
    content.eyebrow?.runs.map((run) => run.text).join('') ?? '',
    content.hero.runs.map((run) => run.text).join(''),
    ...content.rows.map((row) => row.runs.map((run) => run.text).join('')),
  ].join('\n');
}

let boardSequence = 0;
async function createBoard(
  slug: string,
  overrides: Partial<typeof dbSchema.userBoards.$inferInsert> = {},
): Promise<string> {
  boardSequence += 1;
  const uuid = `og-place-board-${boardSequence}`;
  await db.insert(dbSchema.userBoards).values({
    uuid,
    slug,
    ownerId: OWNER,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: `Board ${slug}`,
    isPublic: true,
    angle: 40,
    ...overrides,
  });
  return uuid;
}

async function setBoardAudience(
  boardUuid: string,
  audience: 'public' | 'unlisted' | 'followers' | 'invite_only' | 'only_me',
) {
  await db.insert(dbSchema.resourcePrivacy).values({
    kind: 'board',
    resourceId: boardUuid,
    ownerId: OWNER,
    audience,
    locationAudience: 'public',
  } as typeof dbSchema.resourcePrivacy.$inferInsert);
}

let wallSequence = 7000;
async function createWall(
  name: string,
  options: {
    wall?: Partial<typeof dbSchema.sprayWalls.$inferInsert>;
    board?: Partial<typeof dbSchema.userBoards.$inferInsert>;
    published?: boolean;
    publicPhotoKey?: string | null;
  } = {},
) {
  wallSequence += 1;
  const layoutId = wallSequence;
  const boardUuid = await createBoard(name, {
    boardType: 'spray',
    layoutId,
    sizeId: layoutId,
    setIds: '1',
    name,
    ...options.board,
  });
  const [wall] = await db
    .insert(dbSchema.sprayWalls)
    .values({
      boardUuid,
      layoutId,
      publicPhotoKey: options.publicPhotoKey === undefined ? `spray-walls/${name}/key.jpg` : options.publicPhotoKey,
      ...options.wall,
    })
    .returning({ id: dbSchema.sprayWalls.id });
  const [version] = await db
    .insert(dbSchema.sprayWallVersions)
    .values({
      wallId: wall.id,
      versionNumber: 1,
      status: options.published === false ? 'draft' : 'published',
      photoKey: `private/${name}.jpg`,
      photoWidth: 800,
      photoHeight: 1200,
    })
    .returning({ id: dbSchema.sprayWallVersions.id });
  await db.insert(dbSchema.sprayWallHolds).values(
    [9001, 9002, 9003].map((holdId, index) => ({
      wallId: wall.id,
      holdId,
      cx: 100 + index * 200,
      cy: 300,
      r: 40,
      installedVersionId: version.id,
    })),
  );
  if (options.published !== false) {
    await db
      .update(dbSchema.sprayWalls)
      .set({ currentVersionId: version.id })
      .where(eq(dbSchema.sprayWalls.id, wall.id));
  }
  return { layoutId, wallId: wall.id, boardUuid };
}

let climbSequence = 0;
async function createClimb(
  overrides: Partial<typeof dbSchema.boardClimbs.$inferInsert> = {},
  ascents = 10,
): Promise<string> {
  climbSequence += 1;
  const uuid = `og-place-climb-${climbSequence}`;
  const boardType = overrides.boardType ?? 'kilter';
  await db.insert(dbSchema.boardClimbs).values({
    uuid,
    boardType,
    layoutId: 1,
    name: `Climb ${uuid}`,
    isListed: true,
    isDraft: false,
    frames: KILTER_FRAMES,
    framesCount: 1,
    compatibleSizeIds: [10],
    requiredSetIds: [1],
    ...overrides,
  });
  await db.insert(dbSchema.boardClimbStats).values({
    boardType,
    climbUuid: uuid,
    angle: 40,
    ascensionistCount: ascents,
    displayDifficulty: 20,
  });
  return uuid;
}

async function photoBytes(): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 700, channels: 3, background: '#335577' } })
    .jpeg()
    .toBuffer();
}

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values([{ id: OWNER, email: 'og-place-owner@test.com', name: 'Place Owner' }])
    .onConflictDoNothing();
});

beforeEach(async () => {
  resetOgFamilyLoadCaches();
  documentsRun.length = 0;
  cardReads.count = 0;
  photoReads.count = 0;
  fetchImage.mockReset();
  fetchImage.mockRejectedValue(new Error('no photo in this test'));
  renderFamily.mockReset();
  renderFamily.mockResolvedValue({
    buffer: Buffer.from([0xff, 0xd8]),
    contentType: 'image/jpeg',
    cache: 'miss',
    timings: { wasmMs: 0, planeMs: 0, composeMs: 0 },
  });
  await db.delete(dbSchema.boardClimbStats);
  await db.delete(dbSchema.boardClimbs);
  await db.delete(dbSchema.resourcePrivacy);
  await db.delete(dbSchema.sprayWallHolds);
  await db.update(dbSchema.sprayWalls).set({ currentVersionId: null });
  await db.delete(dbSchema.sprayWallVersions);
  await db.delete(dbSchema.sprayWalls);
  await db.delete(dbSchema.userBoards);
  await db.delete(dbSchema.gyms);
});

async function createGym(slug: string, overrides: Partial<typeof dbSchema.gyms.$inferInsert> = {}) {
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid: `og-gym-${slug}`, slug, ownerId: OWNER, name: `Gym ${slug}`, isPublic: true, ...overrides })
    .returning({ id: dbSchema.gyms.id });
  return gym.id;
}

describe('route input', () => {
  it.each([
    ['no params', ''],
    ['an unknown kind', 'kind=session&slug=abc'],
    ['no slug', 'kind=gym'],
    ['an empty slug', 'kind=gym&slug='],
    ['upper case', 'kind=gym&slug=ABC'],
    ['a path', 'kind=board&slug=..%2Fsecret'],
    ['a slug past the bound', `kind=gym&slug=${'a'.repeat(121)}`],
  ])('answers the one 404 for %s, before any read', async (_label, query) => {
    const res = await requestPlace(query);

    expectRefused(res);
    expect(documentsRun).toEqual([]);
  });
});

describe('gym gate', () => {
  it('answers the one 404 for a gym that does not exist', async () => {
    const res = await requestGym('og-no-such-gym');

    expectRefused(res);
    expect(documentsRun).toEqual(['OgPlaceGym']);
  });

  it('answers the one 404 for a private gym, reading nothing past the gate', async () => {
    await createGym('og-private', { isPublic: false, imageUrl: '/static/gym-photos/a.jpg?v=1' });

    const res = await requestGym('og-private');

    expectRefused(res);
    expect(documentsRun).toEqual(['OgPlaceGym']);
  });

  it('answers the one 404 for a soft-deleted gym', async () => {
    await createGym('og-deleted', { deletedAt: new Date() });

    expectRefused(await requestGym('og-deleted'));
  });

  it('gives no one a private gym by sending a token', async () => {
    await createGym('og-private-auth', { isPublic: false });

    expectRefused(await requestPlace('kind=gym&slug=og-private-auth', { authorization: 'Bearer anything' }));
  });

  it('still serves a public gym kept out of discovery: a direct link reads it', async () => {
    await createGym('og-unlisted-gym', { isListed: false });

    const res = await requestGym('og-unlisted-gym');

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });
});

describe('gym card', () => {
  it('prints the row name and centres it with no art when it has no boards', async () => {
    await createGym('og-empty', { name: 'Pinnacle 2 Obu' });

    await requestGym('og-empty');

    const { art, photo, content } = renderedCard();
    expect(art).toBeNull();
    expect(photo).toBeNull();
    expect(content.slot).toBe('none');
    expect(drawnText(content)).toContain('Pinnacle 2 Obu');
    expect(drawnText(content)).toContain('No boards here yet');
  });

  it('never reaches gymBoards: the boards line comes off the gate read', async () => {
    const gymId = await createGym('og-with-board', { name: 'Kaserne' });
    await createBoard('og-gym-board', { gymId, angle: 30 });

    await requestGym('og-with-board');

    expect(documentsRun).toEqual(['OgPlaceGym']);
    expect(drawnText(renderedCard().content)).toContain('Kilter 30°');
  });

  it.each<[string, Partial<typeof dbSchema.userBoards.$inferInsert>, 'only_me' | undefined]>([
    ['an Only-me board', {}, 'only_me'],
    ['a board flagged private', { isPublic: false }, undefined],
    ['an Unlisted board', { isUnlisted: true }, undefined],
    ['a soft-deleted board', { deletedAt: new Date() }, undefined],
  ])('never names %s at a public gym', async (_label, boardRow, audience) => {
    const gymId = await createGym('og-hidden-board', { name: 'Public Gym' });
    const boardUuid = await createBoard('og-hidden-board-row', {
      gymId,
      boardType: 'tension',
      layoutId: 10,
      ...boardRow,
    });
    if (audience) await setBoardAudience(boardUuid, audience);

    await requestGym('og-hidden-board');

    const { art, content } = renderedCard();
    expect(art).toBeNull();
    expect(drawnText(content)).not.toContain('Tension');
    expect(drawnText(content)).toContain('No boards here yet');
  });

  // A `public` policy row passes the audience check, so each of these can only be
  // refused by the one condition that names it.
  it.each<[string, Partial<typeof dbSchema.userBoards.$inferInsert>]>([
    ['flagged private', { isPublic: false }],
    ['flagged unlisted', { isUnlisted: true }],
    ['soft-deleted', { deletedAt: new Date() }],
  ])('never names a board %s, even with a public policy row', async (_label, boardRow) => {
    const gymId = await createGym('og-policy-board', { name: 'Policy Gym' });
    const boardUuid = await createBoard('og-policy-board-row', {
      gymId,
      boardType: 'tension',
      layoutId: 10,
      ...boardRow,
    });
    await setBoardAudience(boardUuid, 'public');

    await requestGym('og-policy-board');

    expect(drawnText(renderedCard().content)).toContain('No boards here yet');
  });

  it('names only what a stranger can see when a gym has both', async () => {
    const gymId = await createGym('og-mixed', { name: 'Mixed' });
    await createBoard('og-mixed-open', { gymId, angle: 30 });
    const hidden = await createBoard('og-mixed-closed', { gymId, boardType: 'tension', layoutId: 10 });
    await setBoardAudience(hidden, 'only_me');

    await requestGym('og-mixed');

    expect(drawnText(renderedCard().content)).toContain('Kilter 30°');
    expect(drawnText(renderedCard().content)).not.toContain('Tension');
  });

  it('does not name a spray wall nobody has published', async () => {
    const gymId = await createGym('og-draft-wall', { name: 'Draft Wall' });
    await createWall('og-draft-wall-row', { published: false, board: { gymId } });

    await requestGym('og-draft-wall');

    expect(drawnText(renderedCard().content)).not.toContain('Spray wall');
  });

  it('drops a board within 60 s of it going Only-me, and holds the read until then', async () => {
    const gymId = await createGym('og-goes-private', { name: 'Going' });
    const uuid = await createBoard('og-goes-private-row', { gymId, angle: 30 });
    await requestGym('og-goes-private');
    await setBoardAudience(uuid, 'only_me');

    await requestGym('og-goes-private');
    expect(drawnText(renderedCard().content)).toContain('Kilter 30°');

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await requestGym('og-goes-private');
    clock.mockRestore();

    expect(drawnText(renderedCard().content)).not.toContain('Kilter 30°');
  });

  it('lights a real climb on the type default config, and reads no photo when it has none', async () => {
    const gymId = await createGym('og-climb', { name: 'Lit' });
    await createBoard('og-climb-board', { gymId });
    await createClimb();

    await requestGym('og-climb');

    const { art } = renderedCard();
    expect(art).toMatchObject({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', frames: KILTER_FRAMES });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it.each([
    ['a draft', { isDraft: true, isListed: false }],
    ['an unlisted climb', { isListed: false }],
    ['a community-hidden climb', { isHidden: true }],
  ])('skips %s and lights the next most climbed', async (_label, excluded) => {
    const gymId = await createGym('og-skip', { name: 'Skip' });
    await createBoard('og-skip-board', { gymId });
    await createClimb({ frames: 'p1140r12', ...excluded }, 5000);
    await createClimb({ frames: 'p1155r15' }, 3);

    await requestGym('og-skip');

    expect(renderedCard().art?.frames).toBe('p1155r15');
  });

  it('draws the unlit board when nothing fits it', async () => {
    const gymId = await createGym('og-unlit', { name: 'Unlit' });
    await createBoard('og-unlit-board', { gymId });

    await requestGym('og-unlit');

    expect(renderedCard().art).toMatchObject({ boardName: 'kilter', frames: '' });
  });

  it('draws the photo instead of the board, without a climb read', async () => {
    const gymId = await createGym('og-photo', { name: 'Photo', imageUrl: '/static/gym-photos/a.jpg?v=3' });
    await createBoard('og-photo-board', { gymId });
    fetchImage.mockResolvedValueOnce(await photoBytes());

    await requestGym('og-photo');

    const { art, photo, content } = renderedCard();
    expect(fetchImage).toHaveBeenCalledWith(
      'https://media.boardsesh.com/gym-photos/a.jpg?v=3',
      'place-photo',
      expect.objectContaining({ timeoutMs: 2500 }),
    );
    expect(photoReads.count).toBe(1);
    expect(cardReads.count).toBe(1);
    expect(art).toBeNull();
    expect(photo).toMatchObject({ width: 544, height: 602 });
    expect(content.slot).toBe('full');
    expect(documentsRun).toEqual(['OgPlaceGym']);
  });

  it('needs no WASM for a photo card, so a renderer that failed to boot cannot 503 it', async () => {
    await createGym('og-photo-nowasm', { name: 'Photo', imageUrl: '/static/gym-photos/c.jpg?v=3' });
    fetchImage.mockResolvedValueOnce(await photoBytes());
    vi.mocked(ensureBoardRendererAvailable).mockResolvedValueOnce(false);

    expect((await requestGym('og-photo-nowasm')).statusCode).toBe(200);
    vi.mocked(ensureBoardRendererAvailable).mockReset();
    vi.mocked(ensureBoardRendererAvailable).mockResolvedValue(true);
  });

  it('asks for the photo again after a timeout, and draws it once it arrives', async () => {
    const gymId = await createGym('og-photo-retry', { name: 'Retry', imageUrl: '/static/gym-photos/r.jpg?v=1' });
    await createBoard('og-photo-retry-board', { gymId });
    fetchImage.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    await requestGym('og-photo-retry');
    expect(renderedCard().photo).toBeNull();

    fetchImage.mockResolvedValueOnce(await photoBytes());
    await requestGym('og-photo-retry');

    expect(renderedCard().photo).not.toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('remembers a photo that is really gone, so a dead link costs one fetch', async () => {
    const gymId = await createGym('og-photo-gone', { name: 'Gone', imageUrl: '/static/gym-photos/g.jpg?v=1' });
    await createBoard('og-photo-gone-board', { gymId });
    fetchImage.mockRejectedValue(new UnsafeImageHostError('Image fetch answered 404'));

    await requestGym('og-photo-gone');
    await requestGym('og-photo-gone');

    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('forgets a picked climb within 60 s of the community hiding it', async () => {
    const gymId = await createGym('og-pick-ttl', { name: 'Ttl' });
    await createBoard('og-pick-ttl-board', { gymId });
    const climbUuid = await createClimb({ frames: 'p1140r12' }, 5000);
    await createClimb({ frames: 'p1155r15' }, 3);
    await requestGym('og-pick-ttl');
    expect(renderedCard().art?.frames).toBe('p1140r12');
    await db.update(dbSchema.boardClimbs).set({ isHidden: true }).where(eq(dbSchema.boardClimbs.uuid, climbUuid));

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await requestGym('og-pick-ttl');
    clock.mockRestore();

    expect(renderedCard().art?.frames).toBe('p1155r15');
  });

  it.each([
    ['the fetch fails', async () => Promise.reject(new Error('dns'))],
    ['the bytes are not an image', async () => Buffer.from('this is not an image')],
    ['the image is corrupt', async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])],
  ])('falls back to board art when %s, and still answers 200', async (_label, fetchPhoto) => {
    const gymId = await createGym('og-bad-photo', { name: 'Bad Photo', imageUrl: '/static/gym-photos/b.jpg?v=1' });
    await createBoard('og-bad-photo-board', { gymId });
    await createClimb();
    fetchImage.mockImplementationOnce(fetchPhoto);

    const res = await requestGym('og-bad-photo');

    expect(res.statusCode).toBe(200);
    const { art, photo, content } = renderedCard();
    expect(photo).toBeNull();
    expect(art).toMatchObject({ boardName: 'kilter', frames: KILTER_FRAMES });
    expect(content.slot).toBe('full');
  });
});

describe('board gate', () => {
  it('answers the one 404 for a missing board', async () => {
    expectRefused(await requestBoard('og-no-such-board'));
  });

  it('answers the one 404 for a private board', async () => {
    await createBoard('og-b-private', { isPublic: false });

    expectRefused(await requestBoard('og-b-private'));
  });

  it('answers the one 404 for a soft-deleted board', async () => {
    await createBoard('og-b-deleted', { deletedAt: new Date() });

    expectRefused(await requestBoard('og-b-deleted'));
  });

  it.each(['followers', 'invite_only', 'only_me'] as const)(
    'answers the one 404 for a board whose audience is %s, reading no climb',
    async (audience) => {
      const uuid = await createBoard(`og-b-${audience.replace('_', '-')}`);
      await setBoardAudience(uuid, audience);

      const res = await requestBoard(`og-b-${audience.replace('_', '-')}`);

      expectRefused(res);
      expect(documentsRun).toEqual(['OgPlaceBoard']);
    },
  );
});

describe('board card', () => {
  it('serves an Unlisted home board: its slug is its link', async () => {
    const uuid = await createBoard('og-b-unlisted-audience', { name: 'Shared Link' });
    await setBoardAudience(uuid, 'unlisted');

    const res = await requestBoard('og-b-unlisted-audience');

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(drawnText(renderedCard().content)).toContain('Shared Link');
  });

  it('serves a home board flagged unlisted on its legacy columns', async () => {
    await createBoard('og-b-unlisted-flag', { isPublic: false, isUnlisted: true, name: 'Flagged' });

    expect((await requestBoard('og-b-unlisted-flag')).statusCode).toBe(200);
  });

  it('draws the name, config line and its own config', async () => {
    await createBoard('og-b-home', { name: 'Backspace', locationName: 'Golden, Colorado', angle: 45 });

    const res = await requestBoard('og-b-home');

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    const { art, content } = renderedCard();
    expect(art).toMatchObject({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' });
    const text = drawnText(content);
    expect(text).toContain('Kilter 45°');
    expect(text).toContain('Backspace');
    expect(text).toContain('Golden, Colorado');
  });

  it('draws no location for a hideLocation board', async () => {
    await createBoard('og-b-hidden-place', { name: 'Quiet', locationName: 'My Street 12', hideLocation: true });

    await requestBoard('og-b-hidden-place');

    expect(drawnText(renderedCard().content)).not.toContain('My Street');
  });

  it("strips the config tail from the app's default name", async () => {
    await createBoard('og-b-default', { name: "Kari Kokkonen's Kilter Original 12×12 with kickboard" });

    await requestBoard('og-b-default');

    expect(renderedCard().content.hero.runs[0].text).toBe("Kari Kokkonen's Kilter");
  });

  it('keeps the card and drops the art for a stale config', async () => {
    await createBoard('og-b-stale', { layoutId: 999, sizeId: 999, setIds: '999', name: 'Old Board' });

    const res = await requestBoard('og-b-stale');

    expect(res.statusCode).toBe(200);
    const { art, content } = renderedCard();
    expect(art).toBeNull();
    expect(content.slot).toBe('none');
    expect(documentsRun).toEqual(['OgPlaceBoard']);
  });
});

describe('spray wall gate', () => {
  it.each([
    ['private', { board: { isPublic: false } }],
    ['unlisted', { board: { isPublic: false, isUnlisted: true } }],
    ['admin-hidden', { wall: { hiddenAt: new Date() } }],
    ['unpublished', { published: false }],
    ['without a public photo', { publicPhotoKey: null }],
  ])('answers the one 404 for a wall that is %s, before any photo byte', async (label, options) => {
    await createWall(`og-w-${label.replace(/\W+/g, '-')}`, options);

    expectRefused(await requestBoard(`og-w-${label.replace(/\W+/g, '-')}`));
  });

  it('answers the one 404 for a deleted wall row', async () => {
    const { wallId } = await createWall('og-w-deleted-row');
    await db.update(dbSchema.sprayWalls).set({ deletedAt: new Date() }).where(eq(dbSchema.sprayWalls.id, wallId));

    expectRefused(await requestBoard('og-w-deleted-row'));
  });

  it('answers the one 404 for a soft-deleted board row', async () => {
    await createWall('og-w-deleted-board', { board: { deletedAt: new Date() } });

    expectRefused(await requestBoard('og-w-deleted-board'));
  });

  it('answers the one 404 for a wall whose audience is unlisted', async () => {
    const { boardUuid } = await createWall('og-w-audience-unlisted');
    await setBoardAudience(boardUuid, 'unlisted');

    expectRefused(await requestBoard('og-w-audience-unlisted'));
  });

  it('answers the one 404 when the photo is gone, with no board art to fall back to', async () => {
    await createWall('og-w-dead-photo');
    fetchImage.mockRejectedValueOnce(new UnsafeImageHostError('Image fetch answered 404'));

    const res = await requestBoard('og-w-dead-photo');

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(NOT_FOUND_BODY);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(renderFamily).not.toHaveBeenCalled();
  });

  it.each([
    ['a timeout', () => new DOMException('timed out', 'TimeoutError')],
    ['a server error', () => new TransientImageFetchError('Image fetch answered 503')],
  ])('answers 503 once for %s and draws the card on the next request', async (_label, failure) => {
    await createWall('og-w-transient');
    fetchImage.mockRejectedValueOnce(failure());

    const first = await requestBoard('og-w-transient');

    expect(first.statusCode).toBe(503);
    expect(first.headers['Retry-After']).toBe('5');
    expect(first.headers['Cache-Control']).toBe('no-store');
    expect(renderFamily).not.toHaveBeenCalled();

    fetchImage.mockResolvedValueOnce(await photoBytes());
    expect((await requestBoard('og-w-transient')).statusCode).toBe(200);
  });
});

describe('spray wall photo bytes', () => {
  it('refuses SVG bytes, which sharp would otherwise open', async () => {
    await createWall('og-w-svg');
    fetchImage.mockResolvedValueOnce(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><rect width="90" height="90"/></svg>',
      ),
    );

    const res = await requestBoard('og-w-svg');

    expect(res.statusCode).toBe(404);
    expect(renderFamily).not.toHaveBeenCalled();
  });
});

describe('spray wall card', () => {
  it('draws the public photo, the name and the true hold count, with its most-climbed climb lit', async () => {
    const { layoutId } = await createWall('og-w-public', { board: { name: 'The Fold', angle: 40 } });
    const climbDefaults = { boardType: 'spray', layoutId, compatibleSizeIds: [layoutId], requiredSetIds: [1] };
    await createClimb({ ...climbDefaults, frames: WALL_FRAMES }, 12);
    await createClimb({ ...climbDefaults, frames: 'p9003r3' }, 2);
    fetchImage.mockResolvedValueOnce(await photoBytes());

    const res = await requestBoard('og-w-public');

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(fetchImage).toHaveBeenCalledWith(
      'https://media.boardsesh.com/spray-walls/og-w-public/key.jpg',
      'place-photo',
      expect.objectContaining({ timeoutMs: 8000 }),
    );
    expect(photoReads.count).toBe(1);
    const { art, photo, content } = renderedCard();
    expect(art).toBeNull();
    expect(photo?.bokeh.points).toHaveLength(2);
    expect(content.slot).toBe('full');
    expect(drawnText(content)).toContain('Spraywall · 3 holds');
    expect(drawnText(content)).toContain('The Fold');
  });

  it('never lights a hidden climb on a wall', async () => {
    const { layoutId } = await createWall('og-w-hidden-climb', { board: { name: 'Wall' } });
    const climbDefaults = { boardType: 'spray', layoutId, compatibleSizeIds: [layoutId], requiredSetIds: [1] };
    await createClimb({ ...climbDefaults, frames: WALL_FRAMES, isHidden: true }, 100);
    await createClimb({ ...climbDefaults, frames: 'p9003r3' }, 2);
    fetchImage.mockResolvedValueOnce(await photoBytes());

    await requestBoard('og-w-hidden-climb');

    expect(renderedCard().photo?.bokeh.points).toHaveLength(1);
  });

  it('runs the gates on every request while the art is held', async () => {
    const { wallId } = await createWall('og-w-goes-hidden', { board: { name: 'Going' } });
    fetchImage.mockResolvedValue(await photoBytes());

    expect((await requestBoard('og-w-goes-hidden')).statusCode).toBe(200);
    renderFamily.mockClear();
    fetchImage.mockClear();
    cardReads.count = 0;
    photoReads.count = 0;
    await db.update(dbSchema.sprayWalls).set({ hiddenAt: new Date() }).where(eq(dbSchema.sprayWalls.id, wallId));

    expectRefused(await requestBoard('og-w-goes-hidden'));
  });
});
