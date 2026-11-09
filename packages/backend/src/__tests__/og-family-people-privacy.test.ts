/**
 * The profile, setter and recap privacy matrix against the real test Postgres and
 * the real GraphQL schema. Only the renderer, the rate limiter and the avatar
 * fetch are stubbed, so a refused card proves it never reached the byte cache.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { getOperationAST, type DocumentNode } from 'graphql';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext, SessionUser } from '@boardsesh/shared-schema';
import type { OgFamilyCardContent } from '@boardsesh/board-render/og-family';
import { db } from '../db/client';
import { roomManager } from '../services/room-manager';
import type { LoadedOgFamilyCard } from '../services/og-family/card-model';

const { renderFamily, documentsRun, recapReads, fetchImage } = vi.hoisted(() => ({
  renderFamily: vi.fn(),
  documentsRun: [] as string[],
  recapReads: [] as string[],
  fetchImage: vi.fn(),
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
vi.mock('../services/og-family/session-recap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/og-family/session-recap')>();
  return {
    ...actual,
    readSessionRecap: async (sessionId: string) => {
      recapReads.push(sessionId);
      return actual.readSessionRecap(sessionId);
    },
  };
});
vi.mock('../lib/safe-image-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/safe-image-fetch')>()),
  fetchAllowedImage: fetchImage,
}));
vi.mock('../services/board-render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/board-render')>()),
  ensureBoardRendererAvailable: vi.fn(async () => true),
  renderOgFamilyArt: renderFamily,
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => {}) }));

import { handleOgProfile, handleOgSession, handleOgSetter } from '../handlers/og-family';
import { resetOgFamilyLoadCaches } from '../services/og-family/load-cards';
import { RECAP_TICKS_CONSIDERED } from '../services/og-family/session-recap';

const CLIMBER = 'og-people-climber';
const OTHER_CLIMBER = 'og-people-other';
const PRIVATE_CLIMBER = 'og-people-private';
const WALL_OWNER = 'og-people-wall-owner';
const PRIVATE_WALL = 'og-people-private-wall';
const PRIVATE_WALL_LAYOUT_ID = 987;
const PUBLIC_WALL = 'og-people-public-wall';
const PUBLIC_WALL_LAYOUT_ID = 988;

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

function makeReq(): IncomingMessage {
  return { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
}

async function requestProfile(userId: string) {
  const res = makeRes();
  await handleOgProfile(
    makeReq(),
    res as unknown as ServerResponse,
    new URL(`http://localhost/og/profile?user_id=${userId}`),
  );
  return res;
}

async function requestSetter(username: string) {
  const res = makeRes();
  await handleOgSetter(
    makeReq(),
    res as unknown as ServerResponse,
    new URL(`http://localhost/og/setter?username=${encodeURIComponent(username)}`),
  );
  return res;
}

async function requestRecap(sessionId: string, variant?: string) {
  const res = makeRes();
  const query = `sessionId=${encodeURIComponent(sessionId)}${variant ? `&variant=${variant}` : ''}`;
  await handleOgSession(makeReq(), res as unknown as ServerResponse, new URL(`http://localhost/og/session?${query}`));
  return res;
}

const NOT_FOUND_BODY = '{"error":"Not found"}';

function expectIdenticalNotFound(res: MockRes) {
  expect(res.statusCode).toBe(404);
  expect(res.body).toBe(NOT_FOUND_BODY);
  expect(res.headers['Cache-Control']).toBe('no-store');
  expect(renderFamily).not.toHaveBeenCalled();
  expect(fetchImage).not.toHaveBeenCalled();
}

function renderedCard(): LoadedOgFamilyCard & { cacheKey: string } {
  const params = renderFamily.mock.calls.at(-1)?.[0] as {
    art: LoadedOgFamilyCard['art'];
    content: OgFamilyCardContent;
    cacheKey: string;
  };
  return { digest: params.cacheKey, art: params.art, content: params.content, cacheKey: params.cacheKey };
}

function drawnText(content: OgFamilyCardContent): string {
  return [
    content.identity?.name ?? '',
    content.hero.runs.map((run) => run.text).join(''),
    ...content.rows.map((row) => row.runs.map((run) => run.text).join('')),
    content.aside?.eyebrow ?? '',
    content.aside?.title ?? '',
    ...(content.aside?.lines ?? []),
  ].join('\n');
}

async function createClimb(
  uuid: string,
  overrides: Partial<typeof dbSchema.boardClimbs.$inferInsert> = {},
): Promise<void> {
  await db.insert(dbSchema.boardClimbs).values({
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    name: `Climb ${uuid}`,
    isListed: true,
    isDraft: false,
    frames: 'p1140r12p1155r15',
    ...overrides,
  });
}

let tickSequence = 0;
async function createTick(overrides: Partial<typeof dbSchema.boardseshTicks.$inferInsert> & { climbUuid: string }) {
  tickSequence += 1;
  await db.insert(dbSchema.boardseshTicks).values({
    uuid: `og-people-tick-${tickSequence}`,
    userId: CLIMBER,
    boardType: 'kilter',
    angle: 40,
    status: 'send',
    attemptCount: 1,
    difficulty: 20,
    climbedAt: '2026-11-01T12:00:00.000Z',
    ...overrides,
  } as typeof dbSchema.boardseshTicks.$inferInsert);
  return `og-people-tick-${tickSequence}`;
}

async function setClimbStats(
  climbUuid: string,
  angle: number,
  ascensionistCount: number,
  displayDifficulty = 20,
  boardType = 'kilter',
) {
  await db
    .insert(dbSchema.boardClimbStats)
    .values({ boardType, climbUuid, angle, ascensionistCount, displayDifficulty });
}

async function createSession(sessionId: string, boardPath = 'kilter/1/10/1,20/40') {
  await db
    .insert(dbSchema.boardSessions)
    .values({ id: sessionId, boardPath, createdByUserId: CLIMBER, isPublic: true });
}

function rosterUser(overrides: Partial<SessionUser> & { username: string }): SessionUser {
  return { id: overrides.username, isLeader: false, connectionState: 'CONNECTED', ...overrides } as SessionUser;
}

const liveRosters = new Map<string, SessionUser[]>();
const liveBoardPaths = new Map<string, string>();

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values([
      { id: CLIMBER, email: 'og-people-climber@test.com', name: 'Public Climber' },
      { id: OTHER_CLIMBER, email: 'og-people-other@test.com', name: 'Other Climber' },
      { id: PRIVATE_CLIMBER, email: 'og-people-private@test.com', name: 'Private Person' },
      { id: WALL_OWNER, email: 'og-people-wall@test.com', name: 'Wall Owner' },
    ])
    .onConflictDoNothing();
  await db.insert(dbSchema.userProfiles).values({ userId: PRIVATE_CLIMBER, isPrivate: true }).onConflictDoNothing();
  await db.insert(dbSchema.userBoards).values([
    {
      uuid: PRIVATE_WALL,
      slug: PRIVATE_WALL,
      ownerId: WALL_OWNER,
      boardType: 'spray',
      layoutId: PRIVATE_WALL_LAYOUT_ID,
      sizeId: PRIVATE_WALL_LAYOUT_ID,
      setIds: '1',
      name: 'Private wall',
      isPublic: false,
    },
    {
      uuid: PUBLIC_WALL,
      slug: PUBLIC_WALL,
      ownerId: WALL_OWNER,
      boardType: 'spray',
      layoutId: PUBLIC_WALL_LAYOUT_ID,
      sizeId: PUBLIC_WALL_LAYOUT_ID,
      setIds: '1',
      name: 'Public wall',
      isPublic: true,
    },
  ]);
  await db.insert(dbSchema.sprayWalls).values([
    { boardUuid: PRIVATE_WALL, layoutId: PRIVATE_WALL_LAYOUT_ID },
    { boardUuid: PUBLIC_WALL, layoutId: PUBLIC_WALL_LAYOUT_ID },
  ]);
});

beforeEach(async () => {
  resetOgFamilyLoadCaches();
  documentsRun.length = 0;
  recapReads.length = 0;
  fetchImage.mockReset();
  fetchImage.mockRejectedValue(new Error('no avatar in this test'));
  renderFamily.mockReset();
  renderFamily.mockResolvedValue({
    buffer: Buffer.from([0xff, 0xd8]),
    contentType: 'image/jpeg',
    cache: 'miss',
    timings: { wasmMs: 0, planeMs: 0, composeMs: 0 },
  });
  liveRosters.clear();
  liveBoardPaths.clear();
  vi.spyOn(roomManager, 'getSessionUsers').mockImplementation(async (id: string) => liveRosters.get(id) ?? []);
  vi.spyOn(roomManager, 'getSessionById').mockImplementation(
    async (id: string) =>
      (liveBoardPaths.has(id)
        ? {
            id,
            boardPath: liveBoardPaths.get(id)!,
            name: null,
            goal: null,
            notes: null,
            isPublic: true,
            startedAt: new Date(),
            endedAt: null,
            isPermanent: false,
            color: null,
            createdByUserId: CLIMBER,
          }
        : null) as Awaited<ReturnType<typeof roomManager.getSessionById>>,
  );
  // A fresh slate per test: one card must never be able to see another's rows.
  await db.delete(dbSchema.boardseshTicks);
  await db.delete(dbSchema.boardClimbStats);
  await db.delete(dbSchema.boardClimbs);
  await db.delete(dbSchema.contentPrivacy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('profile card gates', () => {
  it('answers 404 for a private account, before stats, frames, avatars or a render', async () => {
    await createClimb('p-private');
    await createTick({ climbUuid: 'p-private', userId: PRIVATE_CLIMBER, difficulty: 28 });

    expectIdenticalNotFound(await requestProfile(PRIVATE_CLIMBER));
    expect(documentsRun).toEqual(['OgProfileGate']);
  });

  it('answers 404 for an account that does not exist', async () => {
    expectIdenticalNotFound(await requestProfile('og-people-nobody'));
    expect(documentsRun).toEqual(['OgProfileGate']);
  });

  it('runs the gate on every request while the stats read is held', async () => {
    await createClimb('p-gate');
    await createTick({ climbUuid: 'p-gate', difficulty: 22 });

    await requestProfile(CLIMBER);
    await requestProfile(CLIMBER);

    expect(documentsRun.filter((name) => name === 'OgProfileGate')).toHaveLength(2);
    expect(documentsRun.filter((name) => name === 'OgProfileStats')).toHaveLength(1);
  });

  it('turns private at the next request, whatever is still held', async () => {
    await createClimb('p-turn-private');
    await createTick({ climbUuid: 'p-turn-private', difficulty: 22 });
    expect((await requestProfile(CLIMBER)).statusCode).toBe(200);
    renderFamily.mockClear();
    fetchImage.mockClear();

    await db
      .insert(dbSchema.userProfiles)
      .values({ userId: CLIMBER, isPrivate: true })
      .onConflictDoUpdate({ target: dbSchema.userProfiles.userId, set: { isPrivate: true } });
    try {
      expectIdenticalNotFound(await requestProfile(CLIMBER));
    } finally {
      await db.update(dbSchema.userProfiles).set({ isPrivate: false }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    }
  });
});

describe('profile hero is the hardest send the logbook shows', () => {
  it('uses the logged grade over a harder consensus', async () => {
    await createClimb('p-logged');
    await setClimbStats('p-logged', 40, 5, 28);
    await createTick({ climbUuid: 'p-logged', difficulty: 26, status: 'flash' });

    await requestProfile(CLIMBER);

    expect(renderedCard().content.hero.runs[0].text).toBe('7c/V9');
  });

  it('falls back to consensus only when no grade was logged', async () => {
    await createClimb('p-consensus');
    await setClimbStats('p-consensus', 40, 5, 25.6);
    await createTick({ climbUuid: 'p-consensus', difficulty: null });

    await requestProfile(CLIMBER);

    expect(renderedCard().content.hero.runs[0].text).toBe('7c/V9');
  });

  it("draws that send's frames on its own board", async () => {
    await createClimb('p-art', { frames: 'p1202r12' });
    await createTick({ climbUuid: 'p-art', difficulty: 24 });

    await requestProfile(CLIMBER);

    const { art } = renderedCard();
    expect(art?.frames).toBe('p1202r12');
    expect(art?.boardName).toBe('kilter');
  });

  it('says no sends logged yet, with the name, for a climber with none', async () => {
    await requestProfile(CLIMBER);

    expect(drawnText(renderedCard().content)).toContain('Public Climber');
    expect(renderedCard().content.hero.runs[0].text).toBe('No sends logged yet');
    expect(renderedCard().art?.frames).toBe('');
  });
});

describe('the hardest send a stranger may see', () => {
  const HARD = 28;
  const SAFE = 20;

  async function seedVisibleSend() {
    await createClimb('p-visible', { frames: 'p1140r12', name: 'Visible climb' });
    await createTick({ climbUuid: 'p-visible', difficulty: SAFE });
  }

  async function expectVisibleSendDrawn(hiddenName: string) {
    await requestProfile(CLIMBER);
    const { content, art } = renderedCard();
    expect(art?.frames).toBe('p1140r12');
    expect(drawnText(content)).not.toContain(hiddenName);
    expect(content.hero.runs[0].text).toBe('6c/V5');
  }

  it('skips a private tick', async () => {
    await seedVisibleSend();
    await createClimb('p-private-tick', { frames: 'p1214r12', name: 'Secret line' });
    const tickUuid = await createTick({ climbUuid: 'p-private-tick', difficulty: HARD });
    await db
      .insert(dbSchema.contentPrivacy)
      .values({ entityType: 'tick', entityId: tickUuid, ownerId: CLIMBER, audience: 'only_me' });

    await expectVisibleSendDrawn('Secret line');
  });

  it('skips a draft climb', async () => {
    await seedVisibleSend();
    await createClimb('p-draft', {
      isDraft: true,
      isListed: false,
      frames: 'p1214r12',
      name: 'Draft line',
      userId: OTHER_CLIMBER,
    });
    await createTick({ climbUuid: 'p-draft', difficulty: HARD });

    await expectVisibleSendDrawn('Draft line');
  });

  it('skips an unlisted climb', async () => {
    await seedVisibleSend();
    await createClimb('p-unlisted', {
      isListed: false,
      frames: 'p1214r12',
      name: 'Unlisted line',
      userId: OTHER_CLIMBER,
    });
    await createTick({ climbUuid: 'p-unlisted', difficulty: HARD });

    await expectVisibleSendDrawn('Unlisted line');
  });

  it('skips a climb the community has hidden, so the next hardest send is drawn', async () => {
    await seedVisibleSend();
    await createClimb('p-hidden', { isHidden: true, frames: 'p1214r12', name: 'Community Hid This' });
    await createTick({ climbUuid: 'p-hidden', difficulty: HARD });

    await expectVisibleSendDrawn('Community Hid This');
  });

  it("keeps a hidden climb in the count and bars, as the public profile's own stats do", async () => {
    await seedVisibleSend();
    await createClimb('p-hidden-counted', { isHidden: true, name: 'Hidden But Sent' });
    await createTick({ climbUuid: 'p-hidden-counted', difficulty: HARD });

    await requestProfile(CLIMBER);

    const { content } = renderedCard();
    expect(drawnText(content)).toContain('Hardest of 2 climbs sent on Kilter');
    expect(content.bars?.filter((bar) => bar.value > 0)).toHaveLength(2);
  });

  it('skips a climb on a private spray wall', async () => {
    await seedVisibleSend();
    await createClimb('p-spray-private', {
      boardType: 'spray',
      layoutId: PRIVATE_WALL_LAYOUT_ID,
      frames: 'p1r12',
      name: 'Wall secret',
      userId: WALL_OWNER,
    });
    await createTick({ climbUuid: 'p-spray-private', boardType: 'spray', difficulty: HARD });

    await expectVisibleSendDrawn('Wall secret');
  });
});

describe('profile avatars', () => {
  async function seedWithAvatar(avatarUrl: string | null) {
    await db
      .insert(dbSchema.userProfiles)
      .values({ userId: CLIMBER, avatarUrl })
      .onConflictDoUpdate({ target: dbSchema.userProfiles.userId, set: { avatarUrl } });
    await createClimb('p-avatar');
    await createTick({ climbUuid: 'p-avatar', difficulty: 22 });
  }

  it('draws the monogram and still answers 200 when the avatar will not load', async () => {
    await seedWithAvatar('https://media.boardsesh.com/avatars/x.jpg');

    const res = await requestProfile(CLIMBER);

    expect(res.statusCode).toBe(200);
    expect(renderedCard().content.identity?.avatar).toMatchObject({ kind: 'monogram', letter: 'P' });
  });

  it('fetches nothing for a private profile, even with an avatar set', async () => {
    await db
      .insert(dbSchema.userProfiles)
      .values({ userId: PRIVATE_CLIMBER, isPrivate: true, avatarUrl: 'https://media.boardsesh.com/avatars/p.jpg' })
      .onConflictDoUpdate({
        target: dbSchema.userProfiles.userId,
        set: { avatarUrl: 'https://media.boardsesh.com/avatars/p.jpg' },
      });

    expectIdenticalNotFound(await requestProfile(PRIVATE_CLIMBER));
  });
});

describe('setter card gates and totals', () => {
  const SETTER = 'og-people-setter';

  async function setterClimb(uuid: string, overrides: Partial<typeof dbSchema.boardClimbs.$inferInsert> = {}) {
    await createClimb(uuid, { setterUsername: SETTER, ...overrides });
  }

  it('answers 404 for a setter with no visible climbs', async () => {
    await setterClimb('s-draft-only', { isDraft: true, isListed: false });

    expectIdenticalNotFound(await requestSetter(SETTER));
    // The refusal is the one bounded row: nothing about the setter was read.
    expect(documentsRun).toEqual([]);
  });

  it('sums each listable climb at its best angle, not across angles', async () => {
    await setterClimb('s-popular', { frames: 'p1140r12', name: 'Top Line' });
    await setClimbStats('s-popular', 40, 100);
    await setClimbStats('s-popular', 45, 50);
    await setterClimb('s-second', { name: 'Second Line' });
    await setClimbStats('s-second', 30, 10);

    await requestSetter(SETTER);

    const { content, art } = renderedCard();
    expect(content.hero.runs.map((run) => run.text).join('')).toBe('110 sends');
    expect(drawnText(content)).toContain('on 2 climbs they set');
    expect(drawnText(content)).toContain('Most sent: Top Line');
    expect(art?.frames).toBe('p1140r12');
  });

  it('leaves hidden, draft, unlisted and private-wall climbs out of the total and the art', async () => {
    await setterClimb('s-visible', { frames: 'p1140r12', name: 'Listed Line' });
    await setClimbStats('s-visible', 40, 40);
    await setterClimb('s-hidden', { isHidden: true, frames: 'p1214r12', name: 'Hidden Line' });
    await setClimbStats('s-hidden', 40, 9000);
    await setterClimb('s-draft', { isDraft: true, isListed: false, frames: 'p1214r12', name: 'Draft Line' });
    await setClimbStats('s-draft', 40, 9000);
    await setterClimb('s-unlisted', { isListed: false, frames: 'p1214r12', name: 'Unlisted Line' });
    await setClimbStats('s-unlisted', 40, 9000);
    await setterClimb('s-spray', {
      boardType: 'spray',
      layoutId: PRIVATE_WALL_LAYOUT_ID,
      frames: 'p1r12',
      name: 'Wall Line',
      userId: WALL_OWNER,
    });
    await setClimbStats('s-spray', 40, 9000, 20, 'spray');

    await requestSetter(SETTER);

    const { content, art } = renderedCard();
    expect(content.hero.runs.map((run) => run.text).join('')).toBe('40 sends');
    expect(art?.frames).toBe('p1140r12');
    expect(drawnText(content)).not.toMatch(/Hidden Line|Draft Line|Unlisted Line|Wall Line/);
  });

  it('gives the hero to the climb count under ten sends', async () => {
    await setterClimb('s-tiny', { name: 'Tiny Line' });
    await setClimbStats('s-tiny', 40, 3);

    await requestSetter(SETTER);

    expect(
      renderedCard()
        .content.hero.runs.map((run) => run.text)
        .join(''),
    ).toBe('1 climb');
  });

  it('keeps the card with no climbs when every climb is hidden: the page still exists', async () => {
    await setterClimb('s-all-hidden', { isHidden: true });

    const res = await requestSetter(SETTER);

    expect(res.statusCode).toBe(200);
    expect(renderedCard().art).toBeNull();
  });

  it('changes the digest when the sends change, unlike the old constant token', async () => {
    await setterClimb('s-digest');
    await setClimbStats('s-digest', 40, 1000);
    await requestSetter(SETTER);
    const firstKey = renderedCard().cacheKey;

    resetOgFamilyLoadCaches();
    await requestSetter(SETTER);
    expect(renderedCard().cacheKey).toBe(firstKey);

    await db
      .update(dbSchema.boardClimbStats)
      .set({ ascensionistCount: 2000 })
      .where(eq(dbSchema.boardClimbStats.climbUuid, 's-digest'));
    resetOgFamilyLoadCaches();
    await requestSetter(SETTER);
    expect(renderedCard().cacheKey).not.toBe(firstKey);
  });

  it('holds the summary, total and top climb across requests', async () => {
    await setterClimb('s-cached');
    await setClimbStats('s-cached', 40, 500);

    await requestSetter(SETTER);
    await requestSetter(SETTER);

    expect(documentsRun.filter((name) => name === 'OgSetterSummary')).toHaveLength(1);
    expect(documentsRun.filter((name) => name === 'OgSetterTotalAscents')).toHaveLength(1);
    expect(documentsRun.filter((name) => name === 'OgSetterTopClimb')).toHaveLength(1);
  });

  it('stops at the gate on the next request once no climb is visible, whatever is held', async () => {
    await setterClimb('s-withdrawn');
    await setClimbStats('s-withdrawn', 40, 500);
    expect((await requestSetter(SETTER)).statusCode).toBe(200);
    renderFamily.mockClear();
    fetchImage.mockClear();

    await db.update(dbSchema.boardClimbs).set({ isDraft: true }).where(eq(dbSchema.boardClimbs.uuid, 's-withdrawn'));

    expectIdenticalNotFound(await requestSetter(SETTER));
  });

  it('drops a held top climb on the very next request once it is hidden', async () => {
    await setterClimb('s-stays', { frames: 'p1140r12', name: 'Stays Listed' });
    await setClimbStats('s-stays', 40, 20);
    await setterClimb('s-gets-hidden', { frames: 'p1214r12', name: 'Gets Hidden' });
    await setClimbStats('s-gets-hidden', 40, 900);
    await requestSetter(SETTER);
    expect(renderedCard().art?.frames).toBe('p1214r12');

    await db.update(dbSchema.boardClimbs).set({ isHidden: true }).where(eq(dbSchema.boardClimbs.uuid, 's-gets-hidden'));
    await requestSetter(SETTER);

    const { content, art } = renderedCard();
    expect(art?.frames).toBe('p1140r12');
    expect(drawnText(content)).toContain('Most sent: Stays Listed');
    expect(drawnText(content)).not.toContain('Gets Hidden');
  });

  it('answers the same 404 for a NUL in the name, without touching the database', async () => {
    expectIdenticalNotFound(await requestSetter('abc\u0000def'));
    expect(documentsRun).toEqual([]);
  });
});

describe('recap gates', () => {
  it('answers 404 for a session nobody may open, reading no ticks', async () => {
    await createSession('r-invite');
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'session', resourceId: 'r-invite', ownerId: CLIMBER, audience: 'invite_only' });
    await createClimb('r-invite-climb');
    await createTick({ climbUuid: 'r-invite-climb', sessionId: 'r-invite' });

    expectIdenticalNotFound(await requestRecap('r-invite'));
    expect(recapReads).toEqual([]);
  });

  it('answers 404 for a session with no ticks a stranger may see', async () => {
    await createSession('r-empty');

    expectIdenticalNotFound(await requestRecap('r-empty'));
  });

  it('checks access on every request while the rollup is held', async () => {
    await createSession('r-cached');
    await createClimb('r-cached-climb');
    await createTick({ climbUuid: 'r-cached-climb', sessionId: 'r-cached' });

    await requestRecap('r-cached');
    await db
      .insert(dbSchema.resourcePrivacy)
      .values({ kind: 'session', resourceId: 'r-cached', ownerId: CLIMBER, audience: 'invite_only' });
    renderFamily.mockClear();

    expectIdenticalNotFound(await requestRecap('r-cached'));
    expect(recapReads).toEqual(['r-cached']);
  });

  it.each(['recap', 'join2', 'JOIN'])('answers 404 for the unknown variant %s', async (variant) => {
    await createSession('r-variant');
    await createClimb('r-variant-climb');
    await createTick({ climbUuid: 'r-variant-climb', sessionId: 'r-variant' });

    expectIdenticalNotFound(await requestRecap('r-variant', variant));
  });

  it('serves the recap, never Join, for an invite to a session that has ended', async () => {
    await createSession('r-ended');
    await createClimb('r-ended-climb', { name: 'Ended Line' });
    await createTick({ climbUuid: 'r-ended-climb', sessionId: 'r-ended', difficulty: 22 });

    const res = await requestRecap('r-ended', 'join');

    expect(res.statusCode).toBe(200);
    expect(drawnText(renderedCard().content)).not.toContain('Join');
    expect(renderedCard().content.hero.runs[0].text).toBe('7a/V6');
  });

  it('still says Join for a live session', async () => {
    await createSession('r-live');
    liveBoardPaths.set('r-live', 'kilter/1/10/1,20/40');
    liveRosters.set('r-live', [rosterUser({ username: 'Alex', userId: CLIMBER, isLeader: true })]);

    const res = await requestRecap('r-live', 'join');

    expect(res.statusCode).toBe(200);
    expect(renderedCard().content.pill?.text).toBe('JOIN');
  });
});

describe('recap draws only what a stranger may see', () => {
  const SESSION = 'r-visible';

  async function seedVisibleSend() {
    await createSession(SESSION);
    await createClimb('r-visible-climb', { frames: 'p1140r12', name: 'Visible Line' });
    await createTick({ climbUuid: 'r-visible-climb', sessionId: SESSION, difficulty: 20, status: 'flash' });
  }

  async function expectOnlyVisibleSend(hiddenName: string) {
    await requestRecap(SESSION);
    const { content, art } = renderedCard();
    expect(art?.frames).toBe('p1140r12');
    expect(content.hero.runs[0].text).toBe('6c/V5');
    expect(drawnText(content)).toContain('Flashed it');
    expect(drawnText(content)).not.toContain(hiddenName);
  }

  it('leaves a private tick out of the hardest send and the count', async () => {
    await seedVisibleSend();
    await createClimb('r-private-tick', { frames: 'p1214r12', name: 'Secret Line' });
    const tickUuid = await createTick({ climbUuid: 'r-private-tick', sessionId: SESSION, difficulty: 28 });
    await db
      .insert(dbSchema.contentPrivacy)
      .values({ entityType: 'tick', entityId: tickUuid, ownerId: CLIMBER, audience: 'only_me' });

    await expectOnlyVisibleSend('Secret Line');
  });

  it('leaves a draft climb out', async () => {
    await seedVisibleSend();
    await createClimb('r-draft', {
      isDraft: true,
      isListed: false,
      frames: 'p1214r12',
      name: 'Draft Line',
      userId: OTHER_CLIMBER,
    });
    await createTick({ climbUuid: 'r-draft', sessionId: SESSION, difficulty: 28 });

    await expectOnlyVisibleSend('Draft Line');
  });

  it('leaves an unlisted climb out', async () => {
    await seedVisibleSend();
    await createClimb('r-unlisted', {
      isListed: false,
      frames: 'p1214r12',
      name: 'Unlisted Line',
      userId: OTHER_CLIMBER,
    });
    await createTick({ climbUuid: 'r-unlisted', sessionId: SESSION, difficulty: 28 });

    await expectOnlyVisibleSend('Unlisted Line');
  });

  it('leaves a private spray wall climb out', async () => {
    await seedVisibleSend();
    await createClimb('r-spray-private', {
      boardType: 'spray',
      layoutId: PRIVATE_WALL_LAYOUT_ID,
      frames: 'p1r12',
      name: 'Wall Line',
      userId: WALL_OWNER,
    });
    await createTick({ climbUuid: 'r-spray-private', sessionId: SESSION, boardType: 'spray', difficulty: 28 });

    await expectOnlyVisibleSend('Wall Line');
  });

  it('never features a climb the community has hidden, and draws the next hardest send', async () => {
    await seedVisibleSend();
    await createClimb('r-hidden', { isHidden: true, frames: 'p1214r12', name: 'Community Hid This' });
    await createTick({ climbUuid: 'r-hidden', sessionId: SESSION, difficulty: 28, status: 'send' });

    await requestRecap(SESSION);

    const { content, art } = renderedCard();
    expect(art?.frames).toBe('p1140r12');
    expect(content.hero.runs[0].text).toBe('6c/V5');
    expect(drawnText(content)).not.toContain('Community Hid This');
    // Still a send, as it is on the session page.
    expect(drawnText(content)).toContain('2 sends, 1 flashed');
  });

  it('still answers for a session whose only sends are on hidden climbs, featuring none of them', async () => {
    await createSession('r-all-hidden');
    await createClimb('r-all-hidden-climb', { isHidden: true, name: 'Community Hid This' });
    await createTick({ climbUuid: 'r-all-hidden-climb', sessionId: 'r-all-hidden', difficulty: 28, status: 'flash' });

    const res = await requestRecap('r-all-hidden');

    expect(res.statusCode).toBe(200);
    const { content, art } = renderedCard();
    expect(art).toBeNull();
    expect(content.aside).toBeUndefined();
    expect(drawnText(content)).not.toContain('Community Hid This');
  });

  it('does not put an attempt forward as the hardest send when every send is hidden', async () => {
    await createSession('r-hidden-plus-attempt');
    await createClimb('r-hidden-send', { isHidden: true, name: 'Community Hid This' });
    await createClimb('r-attempted', { name: 'Only Tried This', frames: 'p1214r12' });
    await createTick({
      climbUuid: 'r-hidden-send',
      sessionId: 'r-hidden-plus-attempt',
      difficulty: 28,
      status: 'send',
    });
    await createTick({
      climbUuid: 'r-attempted',
      sessionId: 'r-hidden-plus-attempt',
      difficulty: 20,
      status: 'attempt',
      attemptCount: 2,
    });

    await requestRecap('r-hidden-plus-attempt');

    const { content, art } = renderedCard();
    expect(art).toBeNull();
    expect(content.aside).toBeUndefined();
    expect(drawnText(content)).not.toContain('Only Tried This');
  });

  it('never credits a climber whose ticks are private, and counts only what is shown', async () => {
    await seedVisibleSend();
    await createClimb('r-other-private', { name: 'Other Line' });
    await createTick({ climbUuid: 'r-other-private', sessionId: SESSION, userId: PRIVATE_CLIMBER, difficulty: 28 });

    await requestRecap(SESSION);

    const { content } = renderedCard();
    expect(content.identity?.name).toBe('Public Climber');
    expect(drawnText(content)).not.toContain('Private Person');
    expect(drawnText(content)).toContain('Flashed it');
  });
});

describe('recap names only who a stranger may see', () => {
  it('says A climber when the only participant stays anonymous on a board that is not theirs', async () => {
    await createSession('r-anon');
    await db
      .insert(dbSchema.userProfiles)
      .values({ userId: OTHER_CLIMBER, anonymousOnForeignBoards: true })
      .onConflictDoUpdate({ target: dbSchema.userProfiles.userId, set: { anonymousOnForeignBoards: true } });
    await createClimb('r-anon-climb');
    await createTick({
      climbUuid: 'r-anon-climb',
      sessionId: 'r-anon',
      userId: OTHER_CLIMBER,
      status: 'flash',
      difficulty: 22,
    });

    try {
      await requestRecap('r-anon');
    } finally {
      await db
        .update(dbSchema.userProfiles)
        .set({ anonymousOnForeignBoards: false })
        .where(eq(dbSchema.userProfiles.userId, OTHER_CLIMBER));
    }

    expect(renderedCard().content.identity?.name).toBe('A climber');
    expect(drawnText(renderedCard().content)).not.toContain('Other Climber');
    expect(renderedCard().content.aside?.lines[0]).toBe('Flashed');
  });

  it('counts a masked crew member but neither names nor credits them', async () => {
    await createSession('r-crew-masked');
    await db
      .insert(dbSchema.userProfiles)
      .values({ userId: OTHER_CLIMBER, anonymousOnForeignBoards: true })
      .onConflictDoUpdate({ target: dbSchema.userProfiles.userId, set: { anonymousOnForeignBoards: true } });
    await createClimb('r-crew-masked-a');
    await createTick({
      climbUuid: 'r-crew-masked-a',
      sessionId: 'r-crew-masked',
      userId: OTHER_CLIMBER,
      status: 'flash',
      difficulty: 28,
    });
    await createTick({
      climbUuid: 'r-crew-masked-a',
      sessionId: 'r-crew-masked',
      userId: CLIMBER,
      status: 'send',
      difficulty: 20,
    });

    try {
      await requestRecap('r-crew-masked');
    } finally {
      await db
        .update(dbSchema.userProfiles)
        .set({ anonymousOnForeignBoards: false })
        .where(eq(dbSchema.userProfiles.userId, OTHER_CLIMBER));
    }

    const { content } = renderedCard();
    expect(content.identity?.name).toBe('Public Climber + 1 other');
    expect(content.aside?.lines[0]).toBe('Flashed');
    expect(drawnText(content)).not.toContain('Other Climber');
  });

  it('reads a crew session as one person plus the rest', async () => {
    await createSession('r-crew');
    await createClimb('r-crew-a');
    await createClimb('r-crew-b');
    await createTick({
      climbUuid: 'r-crew-a',
      sessionId: 'r-crew',
      userId: OTHER_CLIMBER,
      status: 'flash',
      difficulty: 22,
    });
    await createTick({
      climbUuid: 'r-crew-b',
      sessionId: 'r-crew',
      userId: OTHER_CLIMBER,
      status: 'flash',
      difficulty: 18,
    });
    await createTick({ climbUuid: 'r-crew-a', sessionId: 'r-crew', userId: CLIMBER, status: 'send', difficulty: 20 });

    await requestRecap('r-crew');

    const { content } = renderedCard();
    expect(content.identity?.name).toBe('Other Climber + 1 other');
    expect(drawnText(content)).toContain('3 sends, 2 flashed');
    expect(content.aside?.lines[0]).toBe('Flashed by Other Climber');
  });

  it('draws one dot per send and keeps a +N honest past the card', async () => {
    await createSession('r-many');
    await createClimb('r-many-climb');
    for (let index = 0; index < 25; index++) {
      await createTick({ climbUuid: 'r-many-climb', sessionId: 'r-many', status: 'flash', difficulty: 20 });
    }

    await requestRecap('r-many');

    const { content } = renderedCard();
    expect(content.dots?.total).toBe(25);
    expect(content.dots?.dots).toHaveLength(25);
  });

  it('shows rings and the attempt count for a session of no sends', async () => {
    await createSession('r-project');
    await createClimb('r-project-climb', { name: 'The Project' });
    await createTick({
      climbUuid: 'r-project-climb',
      sessionId: 'r-project',
      status: 'attempt',
      attemptCount: 3,
      difficulty: 23,
    });

    await requestRecap('r-project');

    const { content } = renderedCard();
    expect(drawnText(content)).toContain('Still projecting');
    expect(content.hero.runs[0].text).toBe('7a+/V7');
    expect(content.dots?.dots.every((dot) => !dot.filled)).toBe(true);
    expect(content.dots?.label).toBe('3 attempts');
    expect(content.aside?.eyebrow).toBe('THE PROJECT');
  });
});

describe('recap bounds', () => {
  it('reads no more than the bounded window and says so', async () => {
    expect(RECAP_TICKS_CONSIDERED).toBeGreaterThan(0);
    await createSession('r-bounded');
    await createClimb('r-bounded-climb');
    const rows = Array.from({ length: RECAP_TICKS_CONSIDERED + 3 }, (_, index) => ({
      uuid: `r-bounded-${index}`,
      userId: CLIMBER,
      climbUuid: 'r-bounded-climb',
      boardType: 'kilter',
      angle: 40,
      status: 'send' as const,
      attemptCount: 1,
      difficulty: 20,
      climbedAt: new Date(Date.UTC(2026, 10, 1, 12, 0, index % 60, index % 1000)).toISOString(),
      sessionId: 'r-bounded',
    }));
    await db.insert(dbSchema.boardseshTicks).values(rows as Array<typeof dbSchema.boardseshTicks.$inferInsert>);

    await requestRecap('r-bounded');

    expect(drawnText(renderedCard().content)).toContain(
      `${RECAP_TICKS_CONSIDERED.toLocaleString('en-US')}+ sends logged`,
    );
  });
});
