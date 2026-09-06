import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';

// The catalog check is observation only, so what we assert is the OBSERVATION:
// which calls fire the counter and which don't. Mock the analytics module (the
// counter) and let everything else run against the worker DB.
// Typed structurally rather than off captureBackendEvent's own signature —
// vi.hoisted runs before imports, so the real type isn't reachable here.
type CapturedEventOptions = {
  distinctId: string;
  properties?: Record<string, string | number | boolean | null | undefined>;
  processPersonProfile?: boolean;
};
const { captureBackendEventMock } = vi.hoisted(() => ({
  captureBackendEventMock: vi.fn((_eventName: string, _options: CapturedEventOptions) => true),
}));
vi.mock('../services/analytics/posthog', () => ({
  captureBackendEvent: captureBackendEventMock,
}));

// Side effects saveTick fires after the insert. None of them are under test and
// they'd otherwise pull in Redis / the social event bus.
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => {}),
}));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));

import { db } from '../db/client';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

const USER_ID = 'u-catalog-check';
const BOARD = 'kilter';

// Prefixed so the cleanup below can't touch a neighbouring test's fixtures —
// board_climb_aliases is NOT in the shared TRUNCATE list other suites use.
const PREFIX = 'CATCHK-';
const CATALOG_CLIMB = `${PREFIX}IN-CATALOG`;
const ALIAS_CLIMB = `${PREFIX}ALIAS-ONLY`;
const CANONICAL_CLIMB = `${PREFIX}CANONICAL`;
const UNKNOWN_CLIMB = `${PREFIX}NEVER-HEARD-OF-IT`;

function authCtx(): ConnectionContext {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId: USER_ID,
  } as ConnectionContext;
}

function tickInput(climbUuid: string) {
  return {
    boardType: BOARD,
    climbUuid,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: null,
    difficulty: 17,
    isBenchmark: false,
    comment: '',
    climbedAt: new Date().toISOString(),
  };
}

async function tickCountFor(climbUuid: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM boardsesh_ticks WHERE climb_uuid = ${climbUuid}
  `)) as unknown as Array<{ n: number }>;
  const [row] = Array.isArray(rows) ? rows : (rows as { rows: Array<{ n: number }> }).rows;
  return Number(row.n);
}

function unknownCatalogEvents() {
  return captureBackendEventMock.mock.calls.filter((call) => call[0] === 'Tick Climb Not In Catalog');
}

describe('saveTick climb-catalog check (#3528, log-only)', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();

    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${USER_ID}, ${`${USER_ID}@test.com`}, 'Cat Alog', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    for (const uuid of [CATALOG_CLIMB, CANONICAL_CLIMB]) {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
        VALUES (${uuid}, ${BOARD}, 1, 'setter', 'Test Climb', '', 'p1r1', true)
        ON CONFLICT (uuid) DO NOTHING
      `);
    }
    // The deduped-away shape: an alias row and deliberately NO board_climbs row
    // for ALIAS_CLIMB — exactly what the Kilter dedup path produces.
    await db.execute(sql`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES (${BOARD}, ${ALIAS_CLIMB}, ${CANONICAL_CLIMB}, 'kilter')
      ON CONFLICT (board_type, alias_uuid) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  beforeEach(() => {
    captureBackendEventMock.mockClear();
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  });

  it('does not fire the counter for a climb that is in board_climbs', async () => {
    await tickMutations.saveTick(undefined, { input: tickInput(CATALOG_CLIMB) }, authCtx());

    expect(unknownCatalogEvents()).toHaveLength(0);
    expect(await tickCountFor(CATALOG_CLIMB)).toBe(1);
  });

  // The anti-over-rejection test. A deduped Kilter UUID has an alias row and no
  // board_climbs row; the climb is real and the send is real. If the alias arm
  // of the predicate is dropped, this trips the counter — which would poison the
  // observation window #3942 depends on and make the "is it safe to reject?"
  // question unanswerable.
  //
  // The counter deliberately reads the UUID the CLIENT sent, before saveTick
  // resolves it to the canonical: what #3942 has to decide is whether it is safe
  // to reject an incoming UUID, so measuring the resolved one would answer a
  // different question. The row itself lands on CANONICAL_CLIMB — see
  // save-tick-alias-resolution.test.ts.
  it('does not fire the counter for a deduped-away UUID that only board_climb_aliases knows', async () => {
    await tickMutations.saveTick(undefined, { input: tickInput(ALIAS_CLIMB) }, authCtx());

    expect(unknownCatalogEvents()).toHaveLength(0);
    expect(await tickCountFor(ALIAS_CLIMB)).toBe(0);
    expect(await tickCountFor(CANONICAL_CLIMB)).toBe(1);
  });

  it('fires the counter once for a UUID neither table has ever heard of', async () => {
    await tickMutations.saveTick(undefined, { input: tickInput(UNKNOWN_CLIMB) }, authCtx());

    const events = unknownCatalogEvents();
    expect(events).toHaveLength(1);
    // distinctId is the user so the metric can count USERS, not events — one
    // looping client must not read as a fleet-wide problem. climbUuid is what
    // separates "12 phantom climbs" from "one client looping on one UUID", which
    // is the distinction #3942 has to make.
    expect(events[0][1]).toMatchObject({
      distinctId: USER_ID,
      properties: { boardType: BOARD, angle: 40, climbUuid: UNKNOWN_CLIMB },
    });
  });

  // board_climbs.uuid alone is the primary key, so it is tempting to read the
  // board_type predicate as a redundant filter and drop it. It isn't: a tick
  // names a (boardType, climbUuid) PAIR and board_climb_stats is keyed on that
  // pair, so a Kilter UUID arriving under boardType 'tension' names a climb
  // that does not exist. Without this test, dropping the predicate would go
  // unnoticed.
  it('fires the counter for a UUID that exists only under a DIFFERENT board type', async () => {
    await tickMutations.saveTick(
      undefined,
      { input: { ...tickInput(CATALOG_CLIMB), boardType: 'tension' } },
      authCtx(),
    );

    const events = unknownCatalogEvents();
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      properties: { boardType: 'tension', climbUuid: CATALOG_CLIMB },
    });
  });

  // The whole point of the log-only ruling: observing must never cost a send.
  it('still saves the tick when the climb is unknown', async () => {
    const result = await tickMutations.saveTick(undefined, { input: tickInput(UNKNOWN_CLIMB) }, authCtx());

    expect(result).toBeTruthy();
    expect(await tickCountFor(UNKNOWN_CLIMB)).toBe(1);
  });
});
