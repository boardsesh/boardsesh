/**
 * The share-card privacy matrix against the real test Postgres and the real
 * GraphQL schema. Only the renderer and the rate limiter are stubbed, so a
 * refused card proves it never reached the byte cache or the render semaphore.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { SessionUser } from '@boardsesh/shared-schema';
import type { OgFamilyCardContent } from '@boardsesh/board-render/og-family';
import { db } from '../db/client';
import { roomManager } from '../services/room-manager';

const { renderFamily } = vi.hoisted(() => ({ renderFamily: vi.fn() }));
vi.mock('../services/board-render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/board-render')>()),
  ensureBoardRendererAvailable: vi.fn(async () => true),
  renderOgFamilyArt: renderFamily,
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));

import { handleOgPlaylist, handleOgSession } from '../handlers/og-family';

const OWNER = 'og-family-owner';
const PRIVATE_CLIMBER = 'og-family-private-climber';
const HIDDEN_BOARD_NAME = 'Secret Garage Wall';
const HIDDEN_LOCATION = 'Hidden Street';

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

async function requestPlaylist(uuid: string, headers: Record<string, string> = {}) {
  const res = makeRes();
  await handleOgPlaylist(
    makeReq(headers),
    res as unknown as ServerResponse,
    new URL(`http://localhost/og/playlist?uuid=${uuid}`),
  );
  return res;
}

async function requestJoin(sessionId: string, headers: Record<string, string> = {}) {
  const res = makeRes();
  await handleOgSession(
    makeReq(headers),
    res as unknown as ServerResponse,
    new URL(`http://localhost/og/session?sessionId=${sessionId}&variant=join`),
  );
  return res;
}

const NOT_FOUND_BODY = '{"error":"Not found"}';

function expectIdenticalNotFound(res: MockRes) {
  expect(res.statusCode).toBe(404);
  expect(res.body).toBe(NOT_FOUND_BODY);
  expect(res.headers['Cache-Control']).toBe('no-store');
  // The whole render path, byte cache and semaphore included, lives behind this.
  expect(renderFamily).not.toHaveBeenCalled();
}

function drawnText(content: OgFamilyCardContent): string {
  return [
    content.hero.runs.map((run) => run.text).join(''),
    ...content.rows.map((row) => row.runs.map((run) => run.text).join('')),
    content.pill?.text ?? '',
  ].join('\n');
}

async function createPlaylist(uuid: string, options: { isPublic: boolean; ownerId?: string }) {
  const [playlist] = await db
    .insert(dbSchema.playlists)
    .values({ uuid, boardType: 'kilter', layoutId: 1, name: `Playlist ${uuid}`, isPublic: options.isPublic })
    .returning({ id: dbSchema.playlists.id });
  await db
    .insert(dbSchema.playlistOwnership)
    .values({ playlistId: playlist.id, userId: options.ownerId ?? OWNER, role: 'owner' });
  return playlist.id;
}

const liveRosters = new Map<string, SessionUser[]>();
const liveSessionData = new Map<string, { boardPath: string }>();

function rosterUser(overrides: Partial<SessionUser> & { username: string }): SessionUser {
  return { id: overrides.username, isLeader: false, connectionState: 'CONNECTED', ...overrides } as SessionUser;
}

async function createSession(sessionId: string, boardPath: string, roster: SessionUser[]) {
  await db.insert(dbSchema.boardSessions).values({ id: sessionId, boardPath, createdByUserId: OWNER, isPublic: true });
  liveSessionData.set(sessionId, { boardPath });
  liveRosters.set(sessionId, roster);
}

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values([
      { id: OWNER, email: 'og-family-owner@test.com', name: 'Owner' },
      { id: PRIVATE_CLIMBER, email: 'og-family-private@test.com', name: 'Private Person' },
    ])
    .onConflictDoNothing();
  await db.insert(dbSchema.userProfiles).values({ userId: PRIVATE_CLIMBER, isPrivate: true }).onConflictDoNothing();
});

beforeEach(() => {
  renderFamily.mockReset();
  renderFamily.mockResolvedValue({
    buffer: Buffer.from([0xff, 0xd8]),
    contentType: 'image/jpeg',
    cache: 'miss',
    timings: { wasmMs: 0, planeMs: 0, composeMs: 0 },
  });
  liveRosters.clear();
  liveSessionData.clear();
  vi.spyOn(roomManager, 'getSessionUsers').mockImplementation(
    async (sessionId: string) => liveRosters.get(sessionId) ?? [],
  );
  vi.spyOn(roomManager, 'getSessionById').mockImplementation(
    async (sessionId: string) =>
      (liveSessionData.has(sessionId)
        ? {
            id: sessionId,
            boardPath: liveSessionData.get(sessionId)!.boardPath,
            name: null,
            goal: null,
            notes: null,
            isPublic: true,
            startedAt: new Date(),
            endedAt: null,
            isPermanent: false,
            color: null,
            createdByUserId: OWNER,
          }
        : null) as Awaited<ReturnType<typeof roomManager.getSessionById>>,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('playlist card gates', () => {
  it('serves a public playlist', async () => {
    await createPlaylist('og-card-public', { isPublic: true });

    const res = await requestPlaylist('og-card-public');

    expect(res.statusCode).toBe(200);
    expect(renderFamily).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a playlist that does not exist', async () => {
    expectIdenticalNotFound(await requestPlaylist('og-card-nope'));
  });

  it('answers the same 404 for a private playlist, whoever asks', async () => {
    await createPlaylist('og-card-private', { isPublic: false });

    expectIdenticalNotFound(await requestPlaylist('og-card-private'));
    expectIdenticalNotFound(await requestPlaylist('og-card-private', { authorization: 'Bearer owner-token' }));
  });

  it('answers the same 404 for an only_me playlist, even with isPublic set', async () => {
    await createPlaylist('og-card-only-me', { isPublic: true });
    await db.insert(dbSchema.contentPrivacy).values({
      entityType: 'playlist',
      entityId: 'og-card-only-me',
      ownerId: OWNER,
      audience: 'only_me',
    });

    expectIdenticalNotFound(await requestPlaylist('og-card-only-me'));
  });

  it('never reads the frames of a playlist it refused', async () => {
    await createPlaylist('og-card-private-frames', { isPublic: false });

    await requestPlaylist('og-card-private-frames');

    expect(renderFamily).not.toHaveBeenCalled();
  });
});

describe('playlist grade band drawn from the summary', () => {
  const summaryRow = (playlistId: bigint, p90Difficulty: number) => ({
    playlistId,
    boardType: 'kilter',
    gradedClimbCount: 10,
    minDifficulty: 18,
    p10Difficulty: 20,
    medianDifficulty: 22,
    p90Difficulty,
    maxDifficulty: 24,
  });

  it('draws the band and changes the digest when only the summary moves', async () => {
    const playlistId = await createPlaylist('og-card-band', { isPublic: true });
    await db.insert(dbSchema.playlistGradeSummaries).values(summaryRow(playlistId, 22));

    const first = await requestPlaylist('og-card-band');
    expect(first.statusCode).toBe(200);
    const firstCall = renderFamily.mock.calls[0][0];
    expect(drawnText(firstCall.content)).toContain('V5–V6');

    // The daily refresh moves the summary without touching playlists.updated_at,
    // so the card must not be served from the old bytes.
    await db
      .update(dbSchema.playlistGradeSummaries)
      .set({ p90Difficulty: 24 })
      .where(eq(dbSchema.playlistGradeSummaries.playlistId, playlistId));
    renderFamily.mockClear();

    await requestPlaylist('og-card-band');
    const secondCall = renderFamily.mock.calls[0][0];

    expect(drawnText(secondCall.content)).toContain('V5–V8');
    expect(secondCall.cacheKey).not.toBe(firstCall.cacheKey);
  });

  it('gives the hero to the count with no summary', async () => {
    await createPlaylist('og-card-no-band', { isPublic: true });

    await requestPlaylist('og-card-no-band');

    expect(drawnText(renderFamily.mock.calls[0][0].content).startsWith('0')).toBe(true);
  });
});

describe('invite card gates', () => {
  it('answers 404 for a session with no live roster: an ended session cannot say Join', async () => {
    await createSession('og-join-ended', 'kilter/1/10/1,20/40', []);

    expectIdenticalNotFound(await requestJoin('og-join-ended'));
  });

  it('answers 404 for an unknown session', async () => {
    expectIdenticalNotFound(await requestJoin('og-join-nope'));
  });

  it('answers 404 for an invite-only session, whoever asks', async () => {
    await createSession('og-join-invite', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'session', resourceId: 'og-join-invite', ownerId: OWNER, audience: 'invite_only' });

    expectIdenticalNotFound(await requestJoin('og-join-invite'));
    expectIdenticalNotFound(await requestJoin('og-join-invite', { authorization: 'Bearer owner-token' }));
  });

  it('serves the unlit board for a live session with no ticks', async () => {
    await createSession('og-join-unlit', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);

    const res = await requestJoin('og-join-unlit');

    expect(res.statusCode).toBe(200);
    const params = renderFamily.mock.calls[0][0];
    expect(params.art).toMatchObject({ boardName: 'kilter', layoutId: 1, sizeId: 10, frames: '' });
    expect(drawnText(params.content)).toContain('Join\nAlex');
    expect(drawnText(params.content)).toContain('Kilter at 40°');
  });

  it('draws no art and no board line for a session with no board', async () => {
    await createSession('og-join-noboard', '', [rosterUser({ username: 'Alex', userId: OWNER, isLeader: true })]);

    const res = await requestJoin('og-join-noboard');

    expect(res.statusCode).toBe(200);
    const params = renderFamily.mock.calls[0][0];
    expect(params.art).toBeNull();
    expect(params.content.slot).toBe('none');
    expect(params.content.rows).toHaveLength(0);
  });

  it('lights the latest tick on the session board', async () => {
    await db.insert(dbSchema.boardClimbs).values({
      uuid: 'og-join-tick-climb',
      boardType: 'kilter',
      layoutId: 1,
      name: 'A public climb',
      isListed: true,
      isDraft: false,
      frames: 'p1140r12p1155r15',
    });
    await createSession('og-join-ticks', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await db.insert(dbSchema.boardseshTicks).values({
      uuid: 'og-join-tick',
      userId: OWNER,
      climbUuid: 'og-join-tick-climb',
      boardType: 'kilter',
      angle: 40,
      status: 'send' as const,
      difficulty: 20,
      climbedAt: '2026-11-09T10:00:00Z',
      sessionId: 'og-join-ticks',
    });

    await requestJoin('og-join-ticks');

    expect(renderFamily.mock.calls[0][0].art.frames).toBe('p1140r12p1155r15');
  });
});

describe('invite card names only who a stranger may see', () => {
  it('says "the crew" when the only climber has a private profile', async () => {
    await createSession('og-join-masked', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Private Person', userId: PRIVATE_CLIMBER, isLeader: true }),
    ]);

    await requestJoin('og-join-masked');

    const text = drawnText(renderFamily.mock.calls[0][0].content);
    expect(text).not.toContain('Private Person');
    expect(text.replace('\n', ' ')).toContain('Join the crew');
  });

  it('draws no board name or location on a hideLocation board', async () => {
    await db.insert(dbSchema.userBoards).values({
      uuid: 'og-join-hidden-board',
      slug: 'og-join-hidden-board',
      ownerId: OWNER,
      name: HIDDEN_BOARD_NAME,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      isPublic: true,
      hideLocation: true,
      locationName: HIDDEN_LOCATION,
    });
    await createSession('og-join-hidden', '/b/og-join-hidden-board/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);

    const res = await requestJoin('og-join-hidden');

    expect(res.statusCode).toBe(200);
    const text = drawnText(renderFamily.mock.calls[0][0].content);
    expect(text).not.toContain(HIDDEN_BOARD_NAME);
    expect(text).not.toContain(HIDDEN_LOCATION);
  });
});
