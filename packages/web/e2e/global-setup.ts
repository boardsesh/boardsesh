import { chromium, type FullConfig } from '@playwright/test';
import { and, asc, eq, sql } from 'drizzle-orm';
import { boardClimbs, boardClimbStats, boardseshTicks, closePool, createDb, users } from '@boardsesh/db';

const BOARD_URL = '/kilter/original/12x12-square/screw_bolt/40/list';
const WARMUP_PATHS = ['/playlists', '/feed'] as const;
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'test';
const GRID_BADGE_BOARD_TYPE = 'kilter';
const GRID_BADGE_LAYOUT_ID = 1;
const GRID_BADGE_SIZE_ID = 10;
const GRID_BADGE_SET_IDS = [1, 20] as const;
const GRID_BADGE_ANGLE = 40;
const LOCAL_E2E_DATABASE_URL = 'postgres://postgres:password@localhost:5432/main';

class SetupError extends Error {
  constructor(message: string, hint?: string) {
    super(hint ? `${message}\n\nHint: ${hint}` : message);
    this.name = 'E2E global-setup failed';
  }
}

async function ensureGridBadgeFixture(): Promise<void> {
  process.env.DATABASE_URL ??= LOCAL_E2E_DATABASE_URL;
  const db = createDb();

  try {
    const [testUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, TEST_USER_EMAIL)).limit(1);
    if (!testUser) {
      throw new SetupError(
        `Test user ${TEST_USER_EMAIL} does not exist in the e2e database.`,
        'Confirm the seeded dev DB image includes the test account before Playwright starts.',
      );
    }

    const fixtureTickUuid = `e2e-grid-badge-${testUser.id}`;
    const [existingFixtureTick] = await db
      .select({ uuid: boardseshTicks.uuid })
      .from(boardseshTicks)
      .where(eq(boardseshTicks.uuid, fixtureTickUuid))
      .limit(1);
    if (existingFixtureTick) return;

    const setIdLiterals = sql.join(
      GRID_BADGE_SET_IDS.map((setId) => sql`${setId}`),
      sql`, `,
    );
    const [targetClimb] = await db
      .select({ uuid: boardClimbs.uuid })
      .from(boardClimbs)
      .innerJoin(
        boardClimbStats,
        and(eq(boardClimbs.uuid, boardClimbStats.climbUuid), eq(boardClimbs.boardType, boardClimbStats.boardType)),
      )
      .where(
        and(
          eq(boardClimbs.boardType, GRID_BADGE_BOARD_TYPE),
          eq(boardClimbs.layoutId, GRID_BADGE_LAYOUT_ID),
          eq(boardClimbs.isListed, true),
          eq(boardClimbs.isDraft, false),
          eq(boardClimbs.framesCount, 1),
          eq(boardClimbStats.angle, GRID_BADGE_ANGLE),
          sql`${GRID_BADGE_SIZE_ID} = ANY(${boardClimbs.compatibleSizeIds})`,
          sql`${boardClimbs.requiredSetIds} <@ ARRAY[${setIdLiterals}]::int[]`,
        ),
      )
      .orderBy(asc(boardClimbs.uuid))
      .limit(1);

    if (!targetClimb) {
      throw new SetupError(
        'No climb matches the grid-mode ascent badge e2e fixture route.',
        'The dev DB image needs at least one listed Kilter original 12x12 screw/bolt climb with stats at 40 degrees.',
      );
    }

    await db.insert(boardseshTicks).values({
      uuid: fixtureTickUuid,
      userId: testUser.id,
      boardType: GRID_BADGE_BOARD_TYPE,
      climbUuid: targetClimb.uuid,
      angle: GRID_BADGE_ANGLE,
      isMirror: false,
      status: 'send',
      attemptCount: 3,
      quality: 4,
      difficulty: null,
      isBenchmark: false,
      comment: '',
      climbedAt: '2026-01-01T00:00:00.000Z',
      boardId: null,
    });
  } finally {
    await closePool();
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  // The expo-web smoke project drives the /app SPA, not the classic Next
  // routes this setup seeds and prewarms — under the expo-web stack the cold
  // classic-route compile can exceed the 30s card timeout and fail the run for
  // surfaces the smoke never visits. scripts/expo-web-e2e.ts sets the skip.
  if (process.env.PLAYWRIGHT_SKIP_CLASSIC_SETUP === '1') {
    console.info('[global-setup] PLAYWRIGHT_SKIP_CLASSIC_SETUP=1 — skipping classic-app fixture seeding and prewarm.');
    return;
  }

  const baseURL = config.projects[0]?.use.baseURL ?? process.env.PLAYWRIGHT_TEST_BASE_URL ?? 'http://localhost:3000';

  await ensureGridBadgeFixture();

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    // 1. Server reachable + board route renders climb cards
    try {
      await page.goto(BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('#onboarding-climb-card, [data-testid="climb-card"]', { timeout: 30_000 });
    } catch (cause) {
      throw new SetupError(
        `Board URL ${BOARD_URL} did not render any climb cards within 30s.`,
        'Confirm the dev server is up at ' +
          baseURL +
          ' and the dev DB image is current (`docker compose down -v && vp run db:up`). ' +
          `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 2. Test user can log in
    try {
      await page.goto(`/auth/login?callbackUrl=${encodeURIComponent('/')}`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(TEST_USER_EMAIL);
      await page.getByLabel('Password').fill(TEST_USER_PASSWORD);
      await page.getByRole('button', { name: 'Login' }).click();
      await page.waitForURL('/', { timeout: 20_000 });
    } catch (cause) {
      throw new SetupError(
        `Test user ${TEST_USER_EMAIL} failed to log in.`,
        'Confirm the seeded dev DB image includes this user (the boardsesh-dev-db image ships ' +
          'test@boardsesh.com / test by default). Set TEST_USER_EMAIL/TEST_USER_PASSWORD if you ' +
          `intend to use a different account. Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    // 3. Pre-warm the SSR routes that queue-persistence and bottom-tab-bar
    //    navigate to. Both call cached GraphQL on the server and trigger
    //    Next.js's compile-on-first-hit in dev. Without this, the first
    //    navigation in a test races a cold backend round-trip against the
    //    per-navigation timeout — the recurring shard-5 / shard-4 flake mode.
    for (const path of WARMUP_PATHS) {
      await page.goto(path, { timeout: 60_000, waitUntil: 'domcontentloaded' }).catch(() => {
        // Soft-fail: warmup is best-effort. If a warmup route is genuinely
        // broken the spec that depends on it will surface the failure.
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }
}
