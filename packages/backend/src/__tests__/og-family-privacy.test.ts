/**
 * The share-card privacy matrix against the real test Postgres and the real
 * GraphQL schema. Only the renderer and the rate limiter are stubbed, so a
 * refused card proves it never reached the byte cache or the render semaphore.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { getOperationAST, print, type DocumentNode } from 'graphql';
import { SignJWT } from 'jose';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext, SessionUser } from '@boardsesh/shared-schema';
import type { OgFamilyCardContent } from '@boardsesh/board-render/og-family';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import { validateToken } from '../middleware/auth';
import { canAccessResource } from '../services/privacy';
import { roomManager } from '../services/room-manager';
import { OG_BOARD_BY_SLUG } from '../services/og-family/documents';

const { renderFamily, documentsRun, contextsUsed, tickReads } = vi.hoisted(() => ({
  renderFamily: vi.fn(),
  documentsRun: [] as string[],
  contextsUsed: [] as unknown[],
  tickReads: [] as string[],
}));
vi.mock('../services/og-family/run-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/og-family/run-document')>();
  return {
    ...actual,
    runOgDocument: async (document: DocumentNode, variables: Record<string, unknown>, context: ConnectionContext) => {
      documentsRun.push(getOperationAST(document)?.name?.value ?? 'anonymous');
      contextsUsed.push(context);
      return actual.runOgDocument(document, variables, context);
    },
  };
});
vi.mock('../services/og-family/latest-session-tick', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/og-family/latest-session-tick')>();
  return {
    ...actual,
    readLatestSessionTickFrames: async (...args: Parameters<typeof actual.readLatestSessionTickFrames>) => {
      tickReads.push(args[0]);
      return actual.readLatestSessionTickFrames(...args);
    },
  };
});
vi.mock('../services/board-render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/board-render')>()),
  ensureBoardRendererAvailable: vi.fn(async () => true),
  renderOgFamilyArt: renderFamily,
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));

import { handleOgPlaylist, handleOgSession } from '../handlers/og-family';
import { resetOgFamilyLoadCaches } from '../services/og-family/load-cards';
import { readLatestSessionTickFrames } from '../services/og-family/latest-session-tick';

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

/** A real bearer token for `userId`, the kind the app sends. */
function signRealToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('boardsesh')
    .setAudience('boardsesh-mobile')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
}

const ownerContext: ConnectionContext = { connectionId: 'og-owner', isAuthenticated: true, userId: OWNER };
const strangerContext: ConnectionContext = { connectionId: 'og-stranger', isAuthenticated: false };

async function createClimb(uuid: string, overrides: { isDraft?: boolean; frames?: string } = {}) {
  await db.insert(dbSchema.boardClimbs).values({
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    name: `Climb ${uuid}`,
    isListed: true,
    isDraft: overrides.isDraft ?? false,
    userId: OWNER,
    frames: overrides.frames ?? 'p1140r12p1155r15',
  });
}

async function addClimbs(playlistId: bigint, climbUuids: string[]) {
  await db
    .insert(dbSchema.playlistClimbs)
    .values(climbUuids.map((climbUuid, position) => ({ playlistId, climbUuid, angle: 40, position })));
}

async function createTick(uuid: string, sessionId: string, climbUuid: string, climbedAt: string) {
  await db.insert(dbSchema.boardseshTicks).values({
    uuid,
    userId: OWNER,
    climbUuid,
    boardType: 'kilter',
    angle: 40,
    status: 'send' as const,
    difficulty: 20,
    climbedAt,
    sessionId,
  });
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
  resetOgFamilyLoadCaches();
  documentsRun.length = 0;
  contextsUsed.length = 0;
  tickReads.length = 0;
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

  it("answers the same 404 for a private playlist, even with its owner's valid token", async () => {
    await createPlaylist('og-card-private', { isPublic: false });
    const token = await signRealToken(OWNER);
    // Both controls have to hold, or the 404 below proves nothing: the token is
    // real, and that owner can read this playlist everywhere else.
    expect((await validateToken(token))?.userId).toBe(OWNER);
    expect(await playlistQueries.playlist(null, { playlistId: 'og-card-private' }, ownerContext)).not.toBeNull();

    expectIdenticalNotFound(await requestPlaylist('og-card-private', { authorization: `Bearer ${token}` }));
    expect(contextsUsed).toHaveLength(1);
    expect(contextsUsed[0]).toMatchObject({ isAuthenticated: false });
    expect((contextsUsed[0] as ConnectionContext).userId).toBeUndefined();
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

  it('answers 404 for a list a stranger can open that is not public', async () => {
    await createPlaylist('og-card-public-audience', { isPublic: false });
    await db.insert(dbSchema.contentPrivacy).values({
      entityType: 'playlist',
      entityId: 'og-card-public-audience',
      ownerId: OWNER,
      audience: 'public',
      publicConsentRevision: 2,
    });
    // Only the card's own isPublic check stands between a stranger and this card.
    expect(
      await playlistQueries.playlist(null, { playlistId: 'og-card-public-audience' }, strangerContext),
    ).not.toBeNull();

    expectIdenticalNotFound(await requestPlaylist('og-card-public-audience'));
  });

  it('reads no climbs or frames for a playlist it refused', async () => {
    await createPlaylist('og-card-private-frames', { isPublic: false });

    await requestPlaylist('og-card-private-frames');

    expect(documentsRun).toEqual(['OgPlaylistGate']);
  });

  it('reads the climbs once it has passed the gate', async () => {
    await createPlaylist('og-card-reads-climbs', { isPublic: true });

    await requestPlaylist('og-card-reads-climbs');

    expect(documentsRun).toEqual(['OgPlaylistGate', 'OgPlaylistClimbs']);
  });

  it('runs the gate on every request, even while the climbs read is held', async () => {
    const playlistId = await createPlaylist('og-card-flips', { isPublic: true });

    expect((await requestPlaylist('og-card-flips')).statusCode).toBe(200);
    documentsRun.length = 0;
    await requestPlaylist('og-card-flips');
    expect(documentsRun).toEqual(['OgPlaylistGate']);

    renderFamily.mockClear();
    await db.update(dbSchema.playlists).set({ isPublic: false }).where(eq(dbSchema.playlists.id, playlistId));

    expectIdenticalNotFound(await requestPlaylist('og-card-flips'));
  });

  it('shares one gate across requests arriving together', async () => {
    await createPlaylist('og-card-burst', { isPublic: true });

    await Promise.all([requestPlaylist('og-card-burst'), requestPlaylist('og-card-burst')]);

    expect(documentsRun.filter((name) => name === 'OgPlaylistGate')).toHaveLength(1);
  });
});

describe('playlist art', () => {
  it('lights one climb, and changes the digest when the first climb changes', async () => {
    const playlistId = await createPlaylist('og-card-first-climb', { isPublic: true });
    await createClimb('og-first-a', { frames: 'p1140r12' });
    await createClimb('og-first-b', { frames: 'p1155r12' });
    await addClimbs(playlistId, ['og-first-a', 'og-first-b']);

    await requestPlaylist('og-card-first-climb');
    const before = renderFamily.mock.calls[0][0];
    expect(before.art.frames).toBe('p1140r12');

    await db
      .update(dbSchema.playlistClimbs)
      .set({ position: 5 })
      .where(eq(dbSchema.playlistClimbs.climbUuid, 'og-first-a'));
    // Past the post-gate hold, which is what a real later request sees.
    resetOgFamilyLoadCaches();
    renderFamily.mockClear();
    await requestPlaylist('og-card-first-climb');
    const after = renderFamily.mock.calls[0][0];

    expect(after.art.frames).toBe('p1155r12');
    expect(after.cacheKey).not.toBe(before.cacheKey);
  });
});

describe('playlist cards draw only what a stranger can see', () => {
  it('counts and lights only the visible climbs, not the drafts', async () => {
    const playlistId = await createPlaylist('og-card-drafts', { isPublic: true });
    await createClimb('og-draft-visible', { frames: 'p1140r12' });
    await createClimb('og-draft-a', { isDraft: true, frames: 'p1155r12' });
    await createClimb('og-draft-b', { isDraft: true, frames: 'p1162r12' });
    await createClimb('og-draft-c', { isDraft: true, frames: 'p1214r12' });
    await addClimbs(playlistId, ['og-draft-a', 'og-draft-b', 'og-draft-c', 'og-draft-visible']);

    await requestPlaylist('og-card-drafts');

    const params = renderFamily.mock.calls[0][0];
    expect(params.art.frames).toBe('p1140r12');
    expect(drawnText(params.content).split('\n')[0]).toBe('1');
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
  it('answers 404 for a session with no live roster and no logged ticks to recap', async () => {
    await createSession('og-join-ended', 'kilter/1/10/1,20/40', []);

    expectIdenticalNotFound(await requestJoin('og-join-ended'));
  });

  it('answers 404 for an unknown session', async () => {
    expectIdenticalNotFound(await requestJoin('og-join-nope'));
  });

  it("answers 404 for an invite-only session, even with its owner's valid token", async () => {
    await createSession('og-join-invite', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'session', resourceId: 'og-join-invite', ownerId: OWNER, audience: 'invite_only' });
    const token = await signRealToken(OWNER);
    expect((await validateToken(token))?.userId).toBe(OWNER);
    expect(await canAccessResource('session', 'og-join-invite', OWNER)).toBe(true);

    expectIdenticalNotFound(await requestJoin('og-join-invite', { authorization: `Bearer ${token}` }));
    expect(documentsRun).toEqual(['OgSessionGate']);
    expect(tickReads).toEqual([]);
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

  it('holds the tick read briefly but still gates every request', async () => {
    await createSession('og-join-held', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);

    await requestJoin('og-join-held');
    await requestJoin('og-join-held');

    expect(tickReads).toHaveLength(1);
    expect(documentsRun).toEqual(['OgSessionGate', 'OgSessionGate']);

    renderFamily.mockClear();
    liveRosters.set('og-join-held', []);
    expectIdenticalNotFound(await requestJoin('og-join-held'));
  });
});

describe('the latest tick a stranger may see', () => {
  const kilter = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,20' };
  const OLDER = '2026-11-09T09:00:00Z';
  const NEWER = '2026-11-09T10:00:00Z';

  it('skips a draft climb for the newest visible tick', async () => {
    await createClimb('og-tick-older', { frames: 'p1140r12' });
    await createClimb('og-tick-draft', { isDraft: true, frames: 'p1155r15' });
    await createSession('og-tick-skip-draft', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await createTick('og-tick-1', 'og-tick-skip-draft', 'og-tick-older', OLDER);
    await createTick('og-tick-2', 'og-tick-skip-draft', 'og-tick-draft', NEWER);

    await requestJoin('og-tick-skip-draft');

    expect(renderFamily.mock.calls[0][0].art.frames).toBe('p1140r12');
  });

  it('draws the unlit board when every tick is on a draft', async () => {
    await createClimb('og-tick-only-draft', { isDraft: true, frames: 'p1155r15' });
    await createSession('og-tick-all-draft', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await createTick('og-tick-3', 'og-tick-all-draft', 'og-tick-only-draft', NEWER);

    await requestJoin('og-tick-all-draft');

    expect(renderFamily.mock.calls[0][0].art.frames).toBe('');
  });

  it('skips a private tick for the newest visible one', async () => {
    await createClimb('og-tick-public-older', { frames: 'p1202r12' });
    await createClimb('og-tick-private-newer', { frames: 'p1214r12' });
    await createSession('og-tick-skip-private', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await createTick('og-tick-4', 'og-tick-skip-private', 'og-tick-public-older', OLDER);
    await createTick('og-tick-5', 'og-tick-skip-private', 'og-tick-private-newer', NEWER);
    await db
      .insert(dbSchema.contentPrivacy)
      .values({ entityType: 'tick', entityId: 'og-tick-5', ownerId: OWNER, audience: 'only_me' });

    await requestJoin('og-tick-skip-private');

    expect(renderFamily.mock.calls[0][0].art.frames).toBe('p1202r12');
  });

  it('skips a tick from another layout', async () => {
    await db.insert(dbSchema.boardClimbs).values({
      uuid: 'og-tick-layout-8',
      boardType: 'kilter',
      layoutId: 8,
      name: 'Other layout',
      isListed: true,
      isDraft: false,
      frames: 'p4146r45',
    });
    await createSession('og-tick-other-layout', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await createTick('og-tick-6', 'og-tick-other-layout', 'og-tick-layout-8', NEWER);

    await requestJoin('og-tick-other-layout');

    expect(renderFamily.mock.calls[0][0].art.frames).toBe('');
  });

  it('considers only the newest 50 ticks, so a long session stays a bounded read', async () => {
    await createClimb('og-tick-window-visible', { frames: 'p1140r12' });
    await createClimb('og-tick-window-draft', { isDraft: true, frames: 'p1155r15' });
    await createSession('og-tick-window', 'kilter/1/10/1,20/40', [
      rosterUser({ username: 'Alex', userId: OWNER, isLeader: true }),
    ]);
    await createTick('og-tick-window-old', 'og-tick-window', 'og-tick-window-visible', OLDER);
    for (let index = 0; index < 50; index++) {
      await createTick(`og-tick-window-${index}`, 'og-tick-window', 'og-tick-window-draft', NEWER);
    }

    await expect(readLatestSessionTickFrames('og-tick-window', kilter)).resolves.toBeNull();
  });

  it('reads nothing for a session a stranger cannot access', async () => {
    await createClimb('og-tick-invite', { frames: 'p1140r12' });
    await createSession('og-tick-invite-only', 'kilter/1/10/1,20/40', []);
    await createTick('og-tick-7', 'og-tick-invite-only', 'og-tick-invite', NEWER);
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'session', resourceId: 'og-tick-invite-only', ownerId: OWNER, audience: 'invite_only' });

    await expect(readLatestSessionTickFrames('og-tick-invite-only', kilter)).resolves.toBeNull();
  });
});

describe('invite card names only who a stranger may see', () => {
  it('names a public climber and masks the same roster slot when the profile is private', async () => {
    const roster = (username: string, userId: string) => [rosterUser({ username, userId, isLeader: true })];
    await createSession('og-join-named', 'kilter/1/10/1,20/40', roster('Public Person', OWNER));
    await createSession('og-join-masked', 'kilter/1/10/1,20/40', roster('Private Person', PRIVATE_CLIMBER));

    await requestJoin('og-join-named');
    const namedText = drawnText(renderFamily.mock.calls[0][0].content);
    renderFamily.mockClear();
    await requestJoin('og-join-masked');
    const maskedText = drawnText(renderFamily.mock.calls[0][0].content);

    // The control: the same code path does draw a name the roster lets through.
    expect(namedText).toContain('Public Person');
    expect(maskedText).not.toContain('Private Person');
    expect(maskedText.replace('\n', ' ')).toContain('Join the crew');
  });

  it("asks for a named board's config only, so its name and location cannot be drawn", () => {
    expect(print(OG_BOARD_BY_SLUG)).not.toMatch(/\b(name|locationName|gymName|latitude|longitude)\b/);
  });

  it('draws the board only as its model and angle on a hideLocation board', async () => {
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

    await requestJoin('og-join-hidden');

    const text = drawnText(renderFamily.mock.calls[0][0].content);
    expect(text).toContain('Kilter at 40°');
    expect(text).not.toContain(HIDDEN_BOARD_NAME);
    expect(text).not.toContain(HIDDEN_LOCATION);
  });
});
