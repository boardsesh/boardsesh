import { eq, sql, and } from 'drizzle-orm';
import { faker } from '@faker-js/faker';

import { users } from '../src/schema/auth/users.js';
import { userProfiles } from '../src/schema/auth/credentials.js';
import { userFollows } from '../src/schema/app/follows.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { userBoards, boardFollows } from '../src/schema/app/boards.js';
import { boardSessions } from '../src/schema/app/sessions.js';
import { boardClimbs, boardClimbStats, boardDifficultyGrades } from '../src/schema/boards/unified.js';
import { notifications } from '../src/schema/app/notifications.js';
import { comments, votes } from '../src/schema/app/social.js';
import { feedItems } from '../src/schema/app/feed.js';
import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';
import { pickTickComment, pickSocialComment, pickThread, type TickStatus } from './fixtures/comment-templates.js';
import {
  FIXTURE_USERS,
  FIXTURE_TICKS,
  FIXTURE_CONVERSATIONS,
  FIXTURE_VOTES,
  FIXTURE_BASE_TIMESTAMP,
} from './fixtures/deterministic-social.js';

// =============================================================================
// Constants
// =============================================================================

const FAKE_EMAIL_DOMAIN = 'fake.boardsesh.com';
const NUM_FAKE_USERS = 40;
const BATCH_SIZE = 100;
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_TICKS_PER_BOARD = 2000;

const CLIMBING_NICKNAMES = [
  'CrimpKing',
  'BetaMaster',
  'DynoQueen',
  'SloperSlayer',
  'PinchPro',
  'FlashFred',
  'ProjectPaula',
  'CampusCrusher',
  'HeelHookHero',
  'ToeHookTina',
  'SendTrain',
  'ChalkBoss',
  'WallRider',
  'GripStrength',
  'MoonCatcher',
  'RoofRunner',
  'AreteAce',
  'CrackClimber',
  'VolumeViper',
  'PocketRocket',
  'EdgeLord',
  'MantelMaster',
  'FlagQueen',
  'GastonGuru',
  'UnderclingKing',
  'KneeBarNinja',
  'DropKneeDoug',
  'CutLooseCarl',
  'CompClimber',
  'BoardBeast',
];

const BOARD_CONFIGS = [
  // Kilter Original (Layout 1, Size 7, Sets "1,20")
  { boardType: 'kilter', layoutId: 1, sizeId: 7, setIds: '1,20' },
  // Kilter Homewall variants
  { boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: '26,27,28,29' },
  { boardType: 'kilter', layoutId: 8, sizeId: 21, setIds: '26,27' },
  { boardType: 'kilter', layoutId: 8, sizeId: 23, setIds: '26,27,28,29' },
  // Tension Original (Layout 9)
  { boardType: 'tension', layoutId: 9, sizeId: 1, setIds: '8,9,10,11' },
  // Tension Board 2 Mirror (Layout 10)
  { boardType: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' },
  { boardType: 'tension', layoutId: 10, sizeId: 7, setIds: '12,13' },
  // Tension Board 2 Spray (Layout 11)
  { boardType: 'tension', layoutId: 11, sizeId: 6, setIds: '12,13' },
];

const BOARD_NAMES = [
  'The Crimp Factory',
  'Summit Climbing Gym',
  'Basecamp Boulders',
  'Vertical Limit',
  'Granite Arch',
  'The Pump Station',
  'Overhang Oasis',
  'Pinch Palace',
  'Dyno Den',
  'Send Central',
  'The Beta Cave',
  'Moonrise Gym',
  'Friction Labs HQ',
  'Campus Corner',
  'The Slab Lab',
  'Rooftop Rocks',
  'Urban Ascent',
  'Chalk & Awe',
  'The Proj Wall',
  'Crimp City',
  'Home Wall Heroes',
  'Garage Crushers',
  'Backyard Beta',
];

const BOARD_LOCATIONS = [
  { name: 'Brooklyn, NY', lat: 40.6782, lng: -73.9442 },
  { name: 'Boulder, CO', lat: 40.015, lng: -105.2705 },
  { name: 'Portland, OR', lat: 45.5152, lng: -122.6784 },
  { name: 'Austin, TX', lat: 30.2672, lng: -97.7431 },
  { name: 'San Francisco, CA', lat: 37.7749, lng: -122.4194 },
  { name: 'Seattle, WA', lat: 47.6062, lng: -122.3321 },
  { name: 'Denver, CO', lat: 39.7392, lng: -104.9903 },
  { name: 'Salt Lake City, UT', lat: 40.7608, lng: -111.891 },
  { name: 'Chattanooga, TN', lat: 35.0456, lng: -85.3097 },
  { name: 'Bishop, CA', lat: 37.3636, lng: -118.3951 },
  { name: 'Melbourne, AU', lat: -37.8136, lng: 144.9631 },
  { name: 'Sheffield, UK', lat: 53.3811, lng: -1.4701 },
  { name: 'Fontainebleau, FR', lat: 48.4049, lng: 2.7024 },
  { name: 'Tokyo, JP', lat: 35.6762, lng: 139.6503 },
];

const NUM_BOARDS = 20;

// =============================================================================
// Main seed function
// =============================================================================

async function seedSocialData() {
  const databaseUrl = getScriptDatabaseUrl();
  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] || 'unknown';
  console.info(`Seeding social data to: ${dbHost}`);

  // Use deterministic seed for idempotent output
  faker.seed(42);

  const { db, close } = createScriptDb(databaseUrl);

  try {
    // =========================================================================
    // Step 1: Find existing dev users
    // =========================================================================
    console.info('\n--- Step 1: Finding existing dev users ---');
    const devUsers = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(sql`${users.email} NOT LIKE ${'%@' + FAKE_EMAIL_DOMAIN}`);

    console.info(`Found ${devUsers.length} dev user(s): ${devUsers.map((u) => u.email).join(', ') || '(none)'}`);

    // =========================================================================
    // Step 2: Create fake users
    // =========================================================================
    console.info('\n--- Step 2: Creating fake users ---');
    const fakeUserRecords: (typeof users.$inferInsert)[] = [];

    for (let i = 0; i < NUM_FAKE_USERS; i++) {
      fakeUserRecords.push({
        id: faker.string.uuid(),
        name: faker.person.fullName(),
        email: faker.internet.email({ provider: FAKE_EMAIL_DOMAIN }),
        image: faker.datatype.boolean(0.8) ? faker.image.avatar() : null,
        createdAt: faker.date.past({ years: 1 }),
        updatedAt: new Date(),
      });
    }

    await db.insert(users).values(fakeUserRecords).onConflictDoNothing();
    console.info(`Inserted ${fakeUserRecords.length} fake users`);

    // =========================================================================
    // Step 3: Create profiles
    // =========================================================================
    console.info('\n--- Step 3: Creating user profiles ---');
    const profileRecords: (typeof userProfiles.$inferInsert)[] = [];

    for (let i = 0; i < fakeUserRecords.length; i++) {
      const user = fakeUserRecords[i];
      profileRecords.push({
        userId: user.id!,
        displayName: faker.datatype.boolean(0.7) ? CLIMBING_NICKNAMES[i % CLIMBING_NICKNAMES.length] : null,
        avatarUrl: faker.datatype.boolean(0.8) ? faker.image.avatar() : null,
        instagramUrl: faker.datatype.boolean(0.4) ? `https://instagram.com/${faker.internet.username()}` : null,
      });
    }

    await db.insert(userProfiles).values(profileRecords).onConflictDoNothing();
    console.info(`Inserted ${profileRecords.length} user profiles`);

    // =========================================================================
    // Step 3.5: Insert deterministic fixture users
    // =========================================================================
    console.info('\n--- Step 3.5: Inserting deterministic fixture users ---');

    await db
      .insert(users)
      .values(
        FIXTURE_USERS.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          image: u.image,
          createdAt: new Date('2025-06-01'),
          updatedAt: new Date('2025-06-01'),
        })),
      )
      .onConflictDoNothing();

    await db
      .insert(userProfiles)
      .values(
        FIXTURE_USERS.map((u) => ({
          userId: u.id,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl,
          instagramUrl: u.instagramUrl,
        })),
      )
      .onConflictDoNothing();

    console.info(`Inserted ${FIXTURE_USERS.length} deterministic fixture users`);

    // =========================================================================
    // Step 4: Create follow relationships
    // =========================================================================
    console.info('\n--- Step 4: Creating follow relationships ---');
    const followRecords: (typeof userFollows.$inferInsert)[] = [];
    const followSet = new Set<string>(); // Dedup "followerId:followingId"

    function addFollow(followerId: string, followingId: string) {
      if (followerId === followingId) return; // Respect no_self_follow constraint
      const key = `${followerId}:${followingId}`;
      if (followSet.has(key)) return;
      followSet.add(key);
      followRecords.push({ followerId, followingId });
    }

    const fakeUserIds = fakeUserRecords.map((u) => u.id!);

    // Add fixture users to the pool so they participate in follows, etc.
    const fixtureUserIds = FIXTURE_USERS.map((u) => u.id);
    fakeUserIds.push(...fixtureUserIds);

    // Each dev user gets 10-20 followers from fake users
    for (const devUser of devUsers) {
      const followerCount = faker.number.int({ min: 10, max: Math.min(20, fakeUserIds.length) });
      const shuffledFakes = faker.helpers.shuffle([...fakeUserIds]);
      for (let i = 0; i < followerCount; i++) {
        addFollow(shuffledFakes[i], devUser.id);
      }
    }

    // Each dev user follows 5-15 fake users
    for (const devUser of devUsers) {
      const followingCount = faker.number.int({ min: 5, max: Math.min(15, fakeUserIds.length) });
      const shuffledFakes = faker.helpers.shuffle([...fakeUserIds]);
      for (let i = 0; i < followingCount; i++) {
        addFollow(devUser.id, shuffledFakes[i]);
      }
    }

    // Each fake user follows 3-10 other fake users (random social graph)
    for (const fakeId of fakeUserIds) {
      const followingCount = faker.number.int({ min: 3, max: 10 });
      const otherFakes = fakeUserIds.filter((id) => id !== fakeId);
      const shuffled = faker.helpers.shuffle([...otherFakes]);
      for (let i = 0; i < Math.min(followingCount, shuffled.length); i++) {
        addFollow(fakeId, shuffled[i]);
      }
    }

    // Batch insert follows
    for (let i = 0; i < followRecords.length; i += BATCH_SIZE) {
      const batch = followRecords.slice(i, i + BATCH_SIZE);
      await db.insert(userFollows).values(batch).onConflictDoNothing();
    }
    console.info(`Inserted ${followRecords.length} follow relationships`);

    // =========================================================================
    // Step 5: Create user boards
    // =========================================================================
    console.info('\n--- Step 5: Creating user boards ---');

    function slugify(name: string): string {
      return name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    }

    const boardRecords: (typeof userBoards.$inferInsert)[] = [];
    const usedSlugs = new Set<string>();
    // Track owner+config combos to respect unique constraint
    const usedOwnerConfigs = new Set<string>();

    for (let i = 0; i < NUM_BOARDS; i++) {
      const owner = faker.helpers.arrayElement(fakeUserIds);
      const config = BOARD_CONFIGS[i % BOARD_CONFIGS.length];
      const configKey = `${owner}:${config.boardType}:${config.layoutId}:${config.sizeId}:${config.setIds}`;

      // Skip if this owner already has this config
      if (usedOwnerConfigs.has(configKey)) continue;
      usedOwnerConfigs.add(configKey);

      const name = BOARD_NAMES[i % BOARD_NAMES.length];
      let slug = slugify(name);
      // Ensure unique slug
      if (usedSlugs.has(slug)) {
        slug = `${slug}-${i}`;
      }
      usedSlugs.add(slug);

      const location = BOARD_LOCATIONS[i % BOARD_LOCATIONS.length];
      const isPublic = faker.datatype.boolean(0.85);
      const isOwned = faker.datatype.boolean(0.8);

      boardRecords.push({
        uuid: faker.string.uuid(),
        slug,
        ownerId: owner,
        boardType: config.boardType,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: config.setIds,
        name,
        description: faker.datatype.boolean(0.6) ? faker.lorem.sentences({ min: 1, max: 3 }) : null,
        locationName: location.name,
        latitude: location.lat,
        longitude: location.lng,
        isPublic,
        isOwned,
        createdAt: faker.date.past({ years: 1 }),
        updatedAt: new Date(),
      });
    }

    await db.insert(userBoards).values(boardRecords).onConflictDoNothing();
    console.info(`Inserted ${boardRecords.length} user boards`);

    // We need the actual inserted board IDs for linking ticks later
    const insertedBoards = await db
      .select({
        id: userBoards.id,
        uuid: userBoards.uuid,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
        isPublic: userBoards.isPublic,
      })
      .from(userBoards)
      .where(sql`${userBoards.deletedAt} IS NULL`);

    // =========================================================================
    // Step 6: Create board follows
    // =========================================================================
    console.info('\n--- Step 6: Creating board follows ---');
    const boardFollowRecords: (typeof boardFollows.$inferInsert)[] = [];
    const boardFollowSet = new Set<string>();

    function addBoardFollow(userId: string, boardUuid: string) {
      const key = `${userId}:${boardUuid}`;
      if (boardFollowSet.has(key)) return;
      boardFollowSet.add(key);
      boardFollowRecords.push({ userId, boardUuid });
    }

    const publicBoards = insertedBoards.filter((b) => b.isPublic);

    // Each public board gets 5-15 followers from fake users
    for (const board of publicBoards) {
      const followerCount = faker.number.int({ min: 5, max: Math.min(15, fakeUserIds.length) });
      const shuffledFakes = faker.helpers.shuffle([...fakeUserIds]);
      for (let i = 0; i < followerCount; i++) {
        addBoardFollow(shuffledFakes[i], board.uuid);
      }
    }

    // Dev users follow 3-8 random public boards
    for (const devUser of devUsers) {
      if (publicBoards.length === 0) break;
      const followCount = faker.number.int({ min: 3, max: Math.min(8, publicBoards.length) });
      const shuffledBoards = faker.helpers.shuffle([...publicBoards]);
      for (let i = 0; i < followCount; i++) {
        addBoardFollow(devUser.id, shuffledBoards[i].uuid);
      }
    }

    // Batch insert board follows
    for (let i = 0; i < boardFollowRecords.length; i += BATCH_SIZE) {
      const batch = boardFollowRecords.slice(i, i + BATCH_SIZE);
      await db.insert(boardFollows).values(batch).onConflictDoNothing();
    }
    console.info(`Inserted ${boardFollowRecords.length} board follow relationships`);

    // =========================================================================
    // Step 7: Fetch real climb data
    // =========================================================================
    console.info('\n--- Step 7: Fetching real climb data ---');

    // Get climbs for each board type
    const boardTypes = ['kilter', 'tension', 'moonboard'];
    const climbsByBoard: Record<
      string,
      { uuid: string; boardType: string; angle: number | null; name: string | null }[]
    > = {};
    const gradesByBoard: Record<string, number[]> = {};

    for (const boardType of boardTypes) {
      const climbs = await db
        .select({
          uuid: boardClimbs.uuid,
          boardType: boardClimbs.boardType,
          angle: boardClimbs.angle,
          name: boardClimbs.name,
        })
        .from(boardClimbs)
        .where(and(eq(boardClimbs.boardType, boardType), eq(boardClimbs.isListed, true)))
        .limit(200);

      climbsByBoard[boardType] = climbs;
      console.info(`  ${boardType}: ${climbs.length} climbs`);

      const grades = await db
        .select({ difficulty: boardDifficultyGrades.difficulty })
        .from(boardDifficultyGrades)
        .where(and(eq(boardDifficultyGrades.boardType, boardType), eq(boardDifficultyGrades.isListed, true)));

      gradesByBoard[boardType] = grades.map((g) => g.difficulty);
      console.info(`  ${boardType}: ${grades.length} difficulty grades`);
    }

    // Filter to board types that actually have climbs
    const availableBoardTypes = boardTypes.filter((bt) => climbsByBoard[bt].length > 0);
    if (availableBoardTypes.length === 0) {
      console.info('\nNo climbs found in database. Skipping tick generation.');
      console.info('Run the app sync first to populate board_climbs, then re-run this script.');
      await close();
      process.exit(0);
    }

    console.info(`Available board types with climbs: ${availableBoardTypes.join(', ')}`);

    // Build a lookup from boardType to inserted board IDs for linking ticks
    const boardsByType: Record<string, { id: number; boardType: string }[]> = {};
    for (const board of insertedBoards) {
      if (!boardsByType[board.boardType]) boardsByType[board.boardType] = [];
      boardsByType[board.boardType].push({ id: board.id, boardType: board.boardType });
    }

    // =========================================================================
    // Step 7b: Fetch climbs with difficulty for test user tick generation
    // =========================================================================
    console.info('\n--- Step 7b: Fetching climbs with difficulty for test user ---');

    type ClimbWithDifficulty = { uuid: string; angle: number; difficulty: number };
    const climbsByDifficultyPerBoard: Record<string, Map<number, ClimbWithDifficulty[]>> = {};

    for (const boardType of availableBoardTypes) {
      const climbsWithStats = await db
        .select({
          uuid: boardClimbs.uuid,
          angle: boardClimbStats.angle,
          difficulty: boardClimbStats.displayDifficulty,
        })
        .from(boardClimbs)
        .innerJoin(
          boardClimbStats,
          and(eq(boardClimbs.uuid, boardClimbStats.climbUuid), eq(boardClimbs.boardType, boardClimbStats.boardType)),
        )
        .where(and(eq(boardClimbs.boardType, boardType), eq(boardClimbs.isListed, true)))
        .limit(10000);

      const byDifficulty = new Map<number, ClimbWithDifficulty[]>();
      for (const climb of climbsWithStats) {
        if (climb.difficulty === null) continue;
        const diff = Math.round(climb.difficulty);
        if (!byDifficulty.has(diff)) {
          byDifficulty.set(diff, []);
        }
        byDifficulty.get(diff)!.push({
          uuid: climb.uuid,
          angle: climb.angle,
          difficulty: diff,
        });
      }

      climbsByDifficultyPerBoard[boardType] = byDifficulty;
      console.info(`  ${boardType}: ${climbsWithStats.length} climbs across ${byDifficulty.size} difficulty levels`);
    }

    // =========================================================================
    // Step 8: Create ascent activity (ticks)
    // =========================================================================
    console.info('\n--- Step 8: Creating ascent ticks ---');
    const tickRecords: (typeof boardseshTicks.$inferInsert)[] = [];
    const now = Date.now();

    // ── Step 8a: Realistic test user ticks (~2000 per board type) ──────────
    // Distribution modeled after a strong V8 climber: bell curve peaking at
    // the most popular grade range, with asymmetric tails (wider on easy side,
    // steep dropoff above V8).
    //
    // Session schedule: ~3 sessions/week over 3 years with occasional rest
    // weeks. Each board type gets its own session pool so ticks are spread
    // evenly across the full time span.
    console.info('  Generating test user ticks...');

    // Pre-generate climbing session dates over the past 3 years.
    // Walk week-by-week: 2-4 sessions per normal week, 0-1 on rest weeks.
    const SESSION_SPAN_DAYS = 3 * 365;
    const sessionDates: Date[] = [];

    for (let weekOffset = 0; weekOffset < Math.ceil(SESSION_SPAN_DAYS / 7); weekOffset++) {
      const weekStartDaysAgo = SESSION_SPAN_DAYS - weekOffset * 7;

      const isRestWeek = faker.datatype.boolean(0.1);
      const sessionsThisWeek = isRestWeek ? faker.number.int({ min: 0, max: 1 }) : faker.number.int({ min: 2, max: 4 });

      for (let s = 0; s < sessionsThisWeek; s++) {
        const dayInWeek = faker.number.int({ min: 0, max: 6 });
        const daysAgo = weekStartDaysAgo - dayInWeek;
        if (daysAgo < 0) continue;
        sessionDates.push(new Date(now - daysAgo * 24 * 60 * 60 * 1000));
      }
    }

    console.info(`    ${sessionDates.length} session dates over ${Math.round(SESSION_SPAN_DAYS / 365)} years`);

    for (const boardType of availableBoardTypes) {
      const byDifficulty = climbsByDifficultyPerBoard[boardType];
      if (!byDifficulty || byDifficulty.size === 0) {
        console.info(`    ${boardType}: skipped (no climbs with stats)`);
        continue;
      }

      const difficulties = Array.from(byDifficulty.keys()).sort((a, b) => a - b);

      // Find the difficulty with the most climbs — this is typically the
      // "popular zone" (V3-V5) and serves as the peak for our distribution.
      let peakDifficulty = difficulties[0];
      let maxClimbCount = 0;
      for (const [diff, climbs] of byDifficulty) {
        if (climbs.length > maxClimbCount) {
          maxClimbCount = climbs.length;
          peakDifficulty = diff;
        }
      }

      // Weight function: asymmetric Gaussian centered on the peak difficulty.
      // - Left (easy) side: sigma=3.5 → wide spread for warm-ups
      // - Right (hard) side: sigma=2.2 → steeper decline toward projects
      // - Extra exponential decay above peak+6 (≈V8 territory)
      function getWeight(difficulty: number): number {
        const dist = difficulty - peakDifficulty;
        const sigma = dist < 0 ? 3.5 : 2.2;
        let w = Math.exp(-(dist * dist) / (2 * sigma * sigma));

        // Steep penalty above the V8 limit (peak + 6 difficulty units)
        if (dist > 6) {
          w *= Math.exp(-(dist - 6) * 2);
        }

        return Math.max(w, 0.001);
      }

      // Calculate target tick counts per difficulty
      const weights = difficulties.map((d) => getWeight(d));
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);

      let boardTickCount = 0;

      for (let gi = 0; gi < difficulties.length; gi++) {
        const difficulty = difficulties[gi];
        const climbs = byDifficulty.get(difficulty)!;
        let targetCount = Math.round((weights[gi] / totalWeight) * TEST_TICKS_PER_BOARD);

        // Ensure at least 1 tick at each available difficulty
        if (targetCount < 1 && climbs.length > 0) targetCount = 1;

        const gradeRank = gi / (difficulties.length - 1);

        for (let i = 0; i < targetCount; i++) {
          const climb = faker.helpers.arrayElement(climbs);

          // Status depends on difficulty relative to the climber's level
          let status: 'flash' | 'send' | 'attempt';
          let attemptCount: number;

          if (gradeRank < 0.3) {
            // Warm-up grades: mostly flashes
            status = faker.datatype.boolean(0.7) ? 'flash' : 'send';
            attemptCount = status === 'flash' ? 1 : faker.number.int({ min: 2, max: 3 });
          } else if (gradeRank > 0.7) {
            // Project grades: fewer flashes, more attempts
            const roll = faker.number.float({ min: 0, max: 1 });
            if (roll < 0.05) {
              status = 'flash';
            } else if (roll < 0.55) {
              status = 'send';
            } else {
              status = 'attempt';
            }
            if (status === 'flash') {
              attemptCount = 1;
            } else if (status === 'send') {
              attemptCount = faker.number.int({ min: 3, max: 20 });
            } else {
              attemptCount = faker.number.int({ min: 1, max: 10 });
            }
          } else {
            // Comfort zone: good mix of flashes and sends
            const roll = faker.number.float({ min: 0, max: 1 });
            if (roll < 0.25) {
              status = 'flash';
            } else if (roll < 0.85) {
              status = 'send';
            } else {
              status = 'attempt';
            }
            if (status === 'flash') {
              attemptCount = 1;
            } else if (status === 'send') {
              attemptCount = faker.number.int({ min: 2, max: 8 });
            } else {
              attemptCount = faker.number.int({ min: 1, max: 5 });
            }
          }

          const quality = status !== 'attempt' ? faker.number.int({ min: 1, max: 5 }) : null;

          // Pick a random session date from the pre-generated schedule
          const climbedAt = faker.helpers.arrayElement(sessionDates);

          const comment = faker.datatype.boolean(0.08) ? pickTickComment(status) : '';

          let boardId: number | null = null;
          const matchingBoards = boardsByType[boardType];
          if (matchingBoards && matchingBoards.length > 0 && faker.datatype.boolean(0.8)) {
            boardId = faker.helpers.arrayElement(matchingBoards).id;
          }

          tickRecords.push({
            uuid: faker.string.uuid(),
            userId: TEST_USER_ID,
            boardType,
            climbUuid: climb.uuid,
            angle: climb.angle,
            isMirror: false,
            status,
            attemptCount,
            quality,
            difficulty,
            isBenchmark: false,
            comment,
            climbedAt: climbedAt.toISOString(),
            boardId,
          });

          boardTickCount++;
        }
      }

      console.info(`    ${boardType}: ${boardTickCount} ticks (peak difficulty: ${peakDifficulty})`);
    }

    function generateTicks(userId: string, count: number) {
      // Cluster ticks into sessions: 3-8 ticks per session, 10-30 min apart.
      // Sessions are separated by 1-7 days.
      let remaining = count;
      let sessionStartDaysAgo = faker.number.float({ min: 0, max: 25 });

      while (remaining > 0) {
        const sessionSize = Math.min(remaining, faker.number.int({ min: 3, max: 8 }));
        const sessionBoardType = faker.helpers.arrayElement(availableBoardTypes);
        const climbs = climbsByBoard[sessionBoardType];
        const grades = gradesByBoard[sessionBoardType];

        if (climbs.length === 0 || grades.length === 0) {
          remaining -= sessionSize;
          continue;
        }

        const sessionBaseTime = now - sessionStartDaysAgo * 24 * 60 * 60 * 1000;

        for (let j = 0; j < sessionSize; j++) {
          const climb = faker.helpers.arrayElement(climbs);

          // Weighted status: flash 20%, send 50%, attempt 30%
          const statusRoll = faker.number.float({ min: 0, max: 1 });
          let status: 'flash' | 'send' | 'attempt';
          if (statusRoll < 0.2) {
            status = 'flash';
          } else if (statusRoll < 0.7) {
            status = 'send';
          } else {
            status = 'attempt';
          }

          // Each tick in the session is 10-30 minutes after the previous
          const minutesIntoSession = j * faker.number.int({ min: 10, max: 30 });
          const climbedAt = new Date(sessionBaseTime + minutesIntoSession * 60 * 1000);

          const difficulty = status !== 'attempt' ? faker.helpers.arrayElement(grades) : null;
          const quality = status !== 'attempt' ? faker.number.int({ min: 1, max: 5 }) : null;
          let attemptCount: number;
          if (status === 'flash') {
            attemptCount = 1;
          } else if (status === 'send') {
            attemptCount = faker.number.int({ min: 2, max: 15 });
          } else {
            attemptCount = faker.number.int({ min: 1, max: 5 });
          }

          const comment = faker.datatype.boolean(0.3) ? pickTickComment(status) : '';

          // ~60% of ticks get linked to a matching board (if any exist for this boardType)
          let boardId: number | null = null;
          const matchingBoards = boardsByType[sessionBoardType];
          if (matchingBoards && matchingBoards.length > 0 && faker.datatype.boolean(0.6)) {
            boardId = faker.helpers.arrayElement(matchingBoards).id;
          }

          tickRecords.push({
            uuid: faker.string.uuid(),
            userId,
            boardType: sessionBoardType,
            climbUuid: climb.uuid,
            angle: climb.angle ?? 40,
            isMirror: false,
            status,
            attemptCount,
            quality,
            difficulty,
            isBenchmark: false,
            comment,
            climbedAt: climbedAt.toISOString(),
            boardId,
          });
        }

        remaining -= sessionSize;
        // Next session is 1-7 days earlier
        sessionStartDaysAgo += faker.number.float({ min: 1, max: 7 });
      }
    }

    // 10-30 ticks per fake user (enough for 2-5 sessions)
    for (const fakeId of fakeUserIds) {
      const tickCount = faker.number.int({ min: 10, max: 30 });
      generateTicks(fakeId, tickCount);
    }

    // 2-5 ticks per dev user (skip test user — already generated above)
    for (const devUser of devUsers) {
      if (devUser.id === TEST_USER_ID) continue;
      const tickCount = faker.number.int({ min: 2, max: 5 });
      generateTicks(devUser.id, tickCount);
    }

    // Batch insert ticks
    for (let i = 0; i < tickRecords.length; i += BATCH_SIZE) {
      const batch = tickRecords.slice(i, i + BATCH_SIZE);
      await db.insert(boardseshTicks).values(batch).onConflictDoNothing();
      process.stdout.write(`\r  Ticks: ${Math.min(i + BATCH_SIZE, tickRecords.length)}/${tickRecords.length}`);
    }
    console.info('');

    // =========================================================================
    // Step 8.5: Insert deterministic fixture ticks
    // =========================================================================
    console.info('\n  Inserting deterministic fixture ticks...');

    const DAY_MS = 24 * 60 * 60 * 1000;
    const fixtureTickRecords: (typeof boardseshTicks.$inferInsert)[] = [];

    // Group fixture ticks by user so we can cluster them into sessions.
    // Each user's ticks are grouped into sessions with 15-minute spacing
    // between ticks. Sessions are separated by 2 days.
    const fixtureTicksByUser = new Map<string, typeof FIXTURE_TICKS>();
    for (const tick of FIXTURE_TICKS) {
      const existing = fixtureTicksByUser.get(tick.userId) ?? [];
      existing.push(tick);
      fixtureTicksByUser.set(tick.userId, existing);
    }

    let userSessionDay = 0;
    for (const [, userTicks] of fixtureTicksByUser) {
      // Split user's ticks into sessions of 3-4 ticks each
      const SESSION_SIZE = 3;
      for (let si = 0; si < userTicks.length; si++) {
        const sessionIndex = Math.floor(si / SESSION_SIZE);
        const tickInSession = si % SESSION_SIZE;
        const sessionBase = FIXTURE_BASE_TIMESTAMP + (userSessionDay + sessionIndex * 2) * DAY_MS;
        // Each tick in session is 15 minutes after previous
        const climbedAt = new Date(sessionBase + tickInSession * 15 * 60 * 1000);
        const tick = userTicks[si];

        const bt = climbsByBoard[tick.boardType]?.length ? tick.boardType : availableBoardTypes[0];
        const climbs = climbsByBoard[bt];
        if (!climbs || climbs.length === 0) continue;

        const climb = climbs[tick.globalIndex % climbs.length];

        fixtureTickRecords.push({
          uuid: tick.uuid,
          userId: tick.userId,
          boardType: bt,
          climbUuid: climb.uuid,
          angle: tick.angle,
          isMirror: tick.isMirror,
          status: tick.status,
          attemptCount: tick.attemptCount,
          quality: tick.quality,
          difficulty: null,
          isBenchmark: false,
          comment: tick.comment,
          climbedAt: climbedAt.toISOString(),
          boardId: null,
        });
      }
      // Offset each user by a few days so sessions don't all start at the same time
      userSessionDay += 1;
    }

    for (let i = 0; i < fixtureTickRecords.length; i += BATCH_SIZE) {
      const batch = fixtureTickRecords.slice(i, i + BATCH_SIZE);
      await db.insert(boardseshTicks).values(batch).onConflictDoNothing();
    }
    console.info(`  Fixture ticks: ${fixtureTickRecords.length}`);

    // =========================================================================
    // Step 8.55: Seed party mode sessions (real sessions with multiple users)
    // =========================================================================
    console.info('\n  Seeding party mode sessions...');

    const SESSION_NAMES = [
      'Friday Night Sesh',
      'Morning Crush',
      'Project Time',
      'Comp Training',
      'Team Practice',
      'Saturday Send Train',
      'Moonboard Monday',
      null,
      null,
    ];
    const SESSION_GOALS = ['Send V7', 'Flash V5', 'Work on crimps', 'Practice volumes', null, null, null];

    let partySessions = 0;
    let partyTicks = 0;

    // Create 6 party mode sessions with 2-4 participants each
    for (let si = 0; si < 6; si++) {
      const sessionId = `fx-party-session-${String(si + 1).padStart(3, '0')}`;
      const daysAgo = si * 3 + faker.number.int({ min: 0, max: 2 });
      const sessionBaseTime = now - daysAgo * DAY_MS;
      const sessionBoardType = availableBoardTypes[si % availableBoardTypes.length];
      const climbs = climbsByBoard[sessionBoardType];
      const grades = gradesByBoard[sessionBoardType];

      if (!climbs || climbs.length === 0 || !grades || grades.length === 0) continue;

      // Pick 2-4 participants from fixture users
      const numParticipants = faker.number.int({ min: 2, max: 4 });
      const participantIds = faker.helpers.shuffle(FIXTURE_USERS.map((u) => u.id)).slice(0, numParticipants);

      const sessionName = faker.helpers.arrayElement(SESSION_NAMES);
      const sessionGoal = faker.helpers.arrayElement(SESSION_GOALS);

      // Insert the board_session
      await db
        .insert(boardSessions)
        .values({
          id: sessionId,
          boardPath: `/${sessionBoardType}/1/1/1/40`,
          createdAt: new Date(sessionBaseTime),
          lastActivity: new Date(sessionBaseTime + 2 * 60 * 60 * 1000),
          status: 'ended',
          createdByUserId: participantIds[0],
          name: sessionName,
          goal: sessionGoal,
          isPublic: true,
          startedAt: new Date(sessionBaseTime),
          endedAt: new Date(sessionBaseTime + 2 * 60 * 60 * 1000),
        })
        .onConflictDoNothing();

      partySessions++;

      // Generate 4-8 ticks per participant
      for (const participantId of participantIds) {
        const ticksForUser = faker.number.int({ min: 4, max: 8 });
        for (let ti = 0; ti < ticksForUser; ti++) {
          const climb = faker.helpers.arrayElement(climbs);
          const statusRoll = faker.number.float({ min: 0, max: 1 });
          let status: 'flash' | 'send' | 'attempt';
          if (statusRoll < 0.2) {
            status = 'flash';
          } else if (statusRoll < 0.7) {
            status = 'send';
          } else {
            status = 'attempt';
          }

          const minutesIntoSession = ti * faker.number.int({ min: 8, max: 20 });
          const climbedAt = new Date(sessionBaseTime + minutesIntoSession * 60 * 1000);

          const difficulty = status !== 'attempt' ? faker.helpers.arrayElement(grades) : null;
          const quality = status !== 'attempt' ? faker.number.int({ min: 1, max: 5 }) : null;
          let attemptCount: number;
          if (status === 'flash') {
            attemptCount = 1;
          } else if (status === 'send') {
            attemptCount = faker.number.int({ min: 2, max: 10 });
          } else {
            attemptCount = faker.number.int({ min: 1, max: 5 });
          }

          await db
            .insert(boardseshTicks)
            .values({
              uuid: faker.string.uuid(),
              userId: participantId,
              boardType: sessionBoardType,
              climbUuid: climb.uuid,
              angle: climb.angle ?? 40,
              isMirror: false,
              status,
              attemptCount,
              quality,
              difficulty,
              isBenchmark: false,
              comment: '',
              climbedAt: climbedAt.toISOString(),
              boardId: null,
              sessionId,
            })
            .onConflictDoNothing();

          partyTicks++;
        }
      }
    }

    console.info(`  Party sessions: ${partySessions} (${partyTicks} ticks)`);

    // =========================================================================
    // Step 8.6: Seed feed_items for authenticated activity feed
    // =========================================================================
    console.info('\n--- Step 8.6: Seeding feed_items for activity feed ---');

    // Find which fake users the test user follows
    const testUserFollowing = followRecords.filter((f) => f.followerId === TEST_USER_ID).map((f) => f.followingId);

    // Collect ticks from followed users (flash/send only, matching the trendingFeed filter)
    const followedUserTicks = tickRecords.filter(
      (t) => testUserFollowing.includes(t.userId) && (t.status === 'flash' || t.status === 'send'),
    );

    // Build a profile lookup for metadata
    const profileLookup = new Map<string, { displayName: string | null; avatarUrl: string | null }>();
    for (const p of profileRecords) {
      profileLookup.set(p.userId, {
        displayName: p.displayName ?? null,
        avatarUrl: p.avatarUrl ?? null,
      });
    }
    // Include fixture user profiles
    for (const u of FIXTURE_USERS) {
      profileLookup.set(u.id, {
        displayName: u.displayName ?? null,
        avatarUrl: u.avatarUrl ?? null,
      });
    }

    // Build a climb name lookup
    const climbNameLookup = new Map<string, string>();
    for (const boardType of availableBoardTypes) {
      const climbs = climbsByBoard[boardType];
      for (const c of climbs) {
        climbNameLookup.set(`${c.boardType}:${c.uuid}`, c.name || 'Unknown Climb');
      }
    }

    // Create feed items — take up to 60 ticks so pagination (page size 20) triggers
    const feedItemTicks = faker.helpers.shuffle([...followedUserTicks]).slice(0, 60);
    const feedItemRecords: (typeof feedItems.$inferInsert)[] = [];

    for (const tick of feedItemTicks) {
      const profile = profileLookup.get(tick.userId) || { displayName: null, avatarUrl: null };

      feedItemRecords.push({
        recipientId: TEST_USER_ID,
        actorId: tick.userId,
        type: 'ascent',
        entityType: 'tick',
        entityId: tick.uuid,
        boardUuid: null,
        metadata: {
          actorDisplayName: profile.displayName,
          actorAvatarUrl: profile.avatarUrl,
          climbName: climbNameLookup.get(`${tick.boardType}:${tick.climbUuid}`) || 'Seeded Climb',
          climbUuid: tick.climbUuid,
          boardType: tick.boardType,
          status: tick.status,
          angle: tick.angle,
          isMirror: tick.isMirror ?? false,
          isBenchmark: tick.isBenchmark ?? false,
          difficulty: tick.difficulty,
          quality: tick.quality,
          attemptCount: tick.attemptCount,
          comment: tick.comment || null,
        },
        createdAt: new Date(tick.climbedAt),
      });
    }

    // Batch insert feed items
    for (let i = 0; i < feedItemRecords.length; i += BATCH_SIZE) {
      const batch = feedItemRecords.slice(i, i + BATCH_SIZE);
      await db.insert(feedItems).values(batch).onConflictDoNothing();
    }
    console.info(`Inserted ${feedItemRecords.length} feed items for test user activity feed`);

    // =========================================================================
    // Step 9: Create threaded comments on ticks
    // =========================================================================
    console.info('\n--- Step 9: Creating threaded comments on ticks ---');

    // Build a fast tick UUID lookup for notification generation
    const allUsers = [...fakeUserIds, ...devUsers.map((u) => u.id)];

    // ── Step 9a: Build parent comment records ────────────────────────────────
    // Pick ~30% of ticks to receive comments
    const ticksForComments = tickRecords.filter(() => faker.datatype.boolean(0.3));

    type ParentRecord = typeof comments.$inferInsert & {
      _tickUuid: string;
      _tickUserId: string;
      _tickStatus: TickStatus;
      _hasThread: boolean;
    };
    type ReplyRecord = typeof comments.$inferInsert & {
      _parentUuid: string;
      _parentUserId: string;
      _tickUuid: string;
      _tickUserId: string;
    };

    const parentRecords: ParentRecord[] = [];

    // For each tick, decide comment structure:
    //   50% → 1-2 standalone comments only
    //   35% → 1 threaded conversation (parent + 1-3 replies)
    //   15% → 1 standalone + 1 thread
    for (const tick of ticksForComments) {
      const tickStatus = (tick.status as TickStatus) ?? 'send';
      const otherUsers = allUsers.filter((id) => id !== tick.userId);
      if (otherUsers.length === 0) continue;

      const roll = faker.number.float({ min: 0, max: 1 });

      if (roll < 0.5) {
        // Standalone comments only (1-2)
        const count = faker.number.int({ min: 1, max: 2 });
        for (let i = 0; i < count; i++) {
          const commenterId = faker.helpers.arrayElement(otherUsers);
          const daysAgo = faker.number.float({ min: 0, max: 14 });
          const commentedAt = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
          parentRecords.push({
            uuid: faker.string.uuid(),
            userId: commenterId,
            entityType: 'tick' as const,
            entityId: tick.uuid,
            body: pickSocialComment(tickStatus),
            createdAt: commentedAt,
            updatedAt: commentedAt,
            _tickUuid: tick.uuid,
            _tickUserId: tick.userId,
            _tickStatus: tickStatus,
            _hasThread: false,
          });
        }
      } else if (roll < 0.85) {
        // 1 threaded conversation
        const commenterId = faker.helpers.arrayElement(otherUsers);
        const daysAgo = faker.number.float({ min: 0.5, max: 14 });
        const commentedAt = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
        const thread = pickThread(tickStatus);
        parentRecords.push({
          uuid: faker.string.uuid(),
          userId: commenterId,
          entityType: 'tick' as const,
          entityId: tick.uuid,
          body: thread.parent,
          createdAt: commentedAt,
          updatedAt: commentedAt,
          _tickUuid: tick.uuid,
          _tickUserId: tick.userId,
          _tickStatus: tickStatus,
          _hasThread: true,
        });
      } else {
        // 1 standalone + 1 thread
        const commenterId1 = faker.helpers.arrayElement(otherUsers);
        const daysAgo1 = faker.number.float({ min: 0.5, max: 14 });
        const commentedAt1 = new Date(now - daysAgo1 * 24 * 60 * 60 * 1000);
        parentRecords.push({
          uuid: faker.string.uuid(),
          userId: commenterId1,
          entityType: 'tick' as const,
          entityId: tick.uuid,
          body: pickSocialComment(tickStatus),
          createdAt: commentedAt1,
          updatedAt: commentedAt1,
          _tickUuid: tick.uuid,
          _tickUserId: tick.userId,
          _tickStatus: tickStatus,
          _hasThread: false,
        });

        const commenterId2 = faker.helpers.arrayElement(otherUsers);
        const daysAgo2 = faker.number.float({ min: 0.5, max: 14 });
        const commentedAt2 = new Date(now - daysAgo2 * 24 * 60 * 60 * 1000);
        const thread = pickThread(tickStatus);
        parentRecords.push({
          uuid: faker.string.uuid(),
          userId: commenterId2,
          entityType: 'tick' as const,
          entityId: tick.uuid,
          body: thread.parent,
          createdAt: commentedAt2,
          updatedAt: commentedAt2,
          _tickUuid: tick.uuid,
          _tickUserId: tick.userId,
          _tickStatus: tickStatus,
          _hasThread: true,
        });
      }
    }

    // ── Step 9b: Insert parent comments (Pass 1) ─────────────────────────────
    // Insert in batches with .returning() to get auto-generated IDs
    const parentIdMap = new Map<string, number>(); // uuid → id

    for (let i = 0; i < parentRecords.length; i += BATCH_SIZE) {
      const batch = parentRecords.slice(i, i + BATCH_SIZE);
      const insertBatch = batch.map(({ _tickUuid, _tickUserId, _tickStatus, _hasThread, ...record }) => record);
      const returned = await db
        .insert(comments)
        .values(insertBatch)
        .onConflictDoNothing()
        .returning({ id: comments.id, uuid: comments.uuid });
      for (const row of returned) {
        parentIdMap.set(row.uuid, row.id);
      }
      process.stdout.write(
        `\r  Parent comments: ${Math.min(i + BATCH_SIZE, parentRecords.length)}/${parentRecords.length}`,
      );
    }
    console.info('');

    // ── Step 9c: Build and insert reply comments (Pass 2) ────────────────────
    const replyRecords: ReplyRecord[] = [];
    const threadParents = parentRecords.filter((p) => p._hasThread);

    for (const parent of threadParents) {
      const parentId = parentIdMap.get(parent.uuid);
      if (!parentId) continue;

      // Pick a thread template matching the tick status for reply bodies
      const thread = pickThread(parent._tickStatus);
      const replyBodies = thread.replies;

      const parentTime = (parent.createdAt as Date).getTime();
      const otherUsers = allUsers.filter((id) => id !== parent.userId);
      if (otherUsers.length === 0) continue;

      for (let r = 0; r < replyBodies.length; r++) {
        // ~30% chance one reply is from the tick owner
        let replyAuthor: string;
        if (r === 0 && faker.datatype.boolean(0.3) && parent._tickUserId !== parent.userId) {
          replyAuthor = parent._tickUserId;
        } else {
          replyAuthor = faker.helpers.arrayElement(otherUsers.filter((id) => id !== parent.userId));
        }

        // Reply timestamps: 5 min to 24 hours after parent
        const replyOffset = faker.number.int({ min: 5 * 60 * 1000, max: 24 * 60 * 60 * 1000 });
        const replyTime = new Date(parentTime + replyOffset * (r + 1));

        replyRecords.push({
          uuid: faker.string.uuid(),
          userId: replyAuthor,
          entityType: 'tick' as const,
          entityId: parent.entityId,
          parentCommentId: parentId,
          body: replyBodies[r],
          createdAt: replyTime,
          updatedAt: replyTime,
          _parentUuid: parent.uuid,
          _parentUserId: parent.userId,
          _tickUuid: parent._tickUuid,
          _tickUserId: parent._tickUserId,
        });
      }
    }

    // Insert replies in batches
    const replyIdMap = new Map<string, number>(); // uuid → id

    for (let i = 0; i < replyRecords.length; i += BATCH_SIZE) {
      const batch = replyRecords.slice(i, i + BATCH_SIZE);
      const insertBatch = batch.map(({ _parentUuid, _parentUserId, _tickUuid, _tickUserId, ...record }) => record);
      const returned = await db
        .insert(comments)
        .values(insertBatch)
        .onConflictDoNothing()
        .returning({ id: comments.id, uuid: comments.uuid });
      for (const row of returned) {
        replyIdMap.set(row.uuid, row.id);
      }
      process.stdout.write(
        `\r  Reply comments: ${Math.min(i + BATCH_SIZE, replyRecords.length)}/${replyRecords.length}`,
      );
    }
    console.info('');

    const parentCount = parentRecords.length;
    const replyCount = replyRecords.length;
    const threadCount = threadParents.length;

    // =========================================================================
    // Step 9.5: Insert deterministic fixture comments & votes
    // =========================================================================
    console.info('\n--- Step 9.5: Inserting deterministic fixture comments ---');

    // Build tick lookup for computing comment timestamps
    const fixtureTickMap = new Map(FIXTURE_TICKS.map((t) => [t.uuid, t]));

    // Flatten all fixture comments with their conversation context
    const allFixtureComments = FIXTURE_CONVERSATIONS.flatMap((conv) =>
      conv.comments.map((c) => ({ comment: c, tickUuid: conv.tickUuid })),
    );

    // Multi-pass insertion: insert comments level by level (parents before children)
    const fixtureCommentIdMap = new Map<string, number>(); // uuid → DB id

    // Level 0: comments with no parent
    let remaining = allFixtureComments;

    while (remaining.length > 0) {
      const canInsert = remaining.filter(
        (fc) => fc.comment.parentCommentUuid === null || fixtureCommentIdMap.has(fc.comment.parentCommentUuid),
      );
      const cantInsert = remaining.filter(
        (fc) => fc.comment.parentCommentUuid !== null && !fixtureCommentIdMap.has(fc.comment.parentCommentUuid),
      );

      if (canInsert.length === 0 && cantInsert.length > 0) {
        console.warn(`  Warning: ${cantInsert.length} fixture comments have broken parent references, skipping`);
        break;
      }

      for (let i = 0; i < canInsert.length; i += BATCH_SIZE) {
        const batch = canInsert.slice(i, i + BATCH_SIZE);
        const insertBatch = batch.map((fc) => {
          const tick = fixtureTickMap.get(fc.tickUuid);
          const tickTime = FIXTURE_BASE_TIMESTAMP + (tick?.globalIndex ?? 0) * DAY_MS;
          const commentTime = new Date(tickTime + fc.comment.minutesAfterTick * 60 * 1000);
          const parentId = fc.comment.parentCommentUuid
            ? (fixtureCommentIdMap.get(fc.comment.parentCommentUuid) ?? null)
            : null;

          return {
            uuid: fc.comment.uuid,
            userId: fc.comment.userId,
            entityType: 'tick' as const,
            entityId: fc.tickUuid,
            parentCommentId: parentId,
            body: fc.comment.body,
            createdAt: commentTime,
            updatedAt: commentTime,
          };
        });

        const returned = await db
          .insert(comments)
          .values(insertBatch)
          .onConflictDoNothing()
          .returning({ id: comments.id, uuid: comments.uuid });
        for (const row of returned) {
          fixtureCommentIdMap.set(row.uuid, row.id);
        }
      }

      remaining = cantInsert;
    }

    const fixtureParentCount = allFixtureComments.filter((fc) => fc.comment.parentCommentUuid === null).length;
    const fixtureReplyCount = allFixtureComments.filter((fc) => fc.comment.parentCommentUuid !== null).length;
    console.info(
      `  Fixture comments: ${fixtureParentCount} parents + ${fixtureReplyCount} replies = ${fixtureCommentIdMap.size} inserted`,
    );

    // Insert fixture votes
    const fixtureVoteRecords = FIXTURE_VOTES.filter((v) => fixtureCommentIdMap.has(v.commentUuid)).map((v) => ({
      userId: v.userId,
      entityType: 'comment' as const,
      entityId: v.commentUuid,
      value: v.value,
    }));

    if (fixtureVoteRecords.length > 0) {
      await db.insert(votes).values(fixtureVoteRecords).onConflictDoNothing();
    }
    console.info(`  Fixture votes: ${fixtureVoteRecords.length}`);

    // =========================================================================
    // Step 10: Create notifications
    // =========================================================================
    console.info('\n--- Step 10: Creating notifications ---');
    const notificationRecords: (typeof notifications.$inferInsert)[] = [];

    // Helper to create a notification with a random timestamp in the last N days
    function createNotification(
      recipientId: string,
      actorId: string,
      type: (typeof notifications.$inferInsert)['type'],
      entityType: (typeof notifications.$inferInsert)['entityType'],
      entityId: string | null,
      commentId: number | null,
      maxDaysAgo: number,
    ) {
      if (recipientId === actorId) return; // No self-notifications

      const daysAgo = faker.number.float({ min: 0, max: maxDaysAgo });
      const createdAt = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
      // ~40% of notifications are read
      const readAt = faker.datatype.boolean(0.4)
        ? new Date(createdAt.getTime() + faker.number.int({ min: 60000, max: 86400000 }))
        : null;

      notificationRecords.push({
        uuid: faker.string.uuid(),
        recipientId,
        actorId,
        type,
        entityType,
        entityId,
        commentId,
        readAt,
        createdAt,
      });
    }

    // 1. new_follower notifications — for a subset of follows targeting dev users
    const devUserIds = new Set(devUsers.map((u) => u.id));
    const followsToDevUsers = followRecords.filter((f) => devUserIds.has(f.followingId));
    // Generate notifications for ~80% of follows to dev users (recent follows)
    for (const follow of followsToDevUsers) {
      if (faker.datatype.boolean(0.8)) {
        createNotification(
          follow.followingId,
          follow.followerId,
          'new_follower',
          'tick', // entity type doesn't matter much for follows
          follow.followerId, // entityId = the follower's userId
          null,
          14,
        );
      }
    }

    // Also generate some new_follower notifications between fake users
    const fakeToFakeFollows = followRecords.filter(
      (f) => !devUserIds.has(f.followingId) && !devUserIds.has(f.followerId),
    );
    for (const follow of faker.helpers.arrayElements(fakeToFakeFollows, Math.min(50, fakeToFakeFollows.length))) {
      createNotification(follow.followingId, follow.followerId, 'new_follower', 'tick', follow.followerId, null, 21);
    }

    // 2. comment_on_tick notifications — from parent comments (not replies)
    for (const parent of parentRecords) {
      const commentId = parentIdMap.get(parent.uuid) ?? null;
      createNotification(parent._tickUserId, parent.userId, 'comment_on_tick', 'tick', parent._tickUuid, commentId, 14);
    }

    // 3. vote_on_tick notifications — for a subset of ticks
    const ticksForVotes = tickRecords.filter(() => faker.datatype.boolean(0.25));
    for (const tick of ticksForVotes) {
      // 1-3 vote notifications per tick
      const voteCount = faker.number.int({ min: 1, max: 3 });
      for (let i = 0; i < voteCount; i++) {
        const otherUsersForVote = allUsers.filter((id) => id !== tick.userId);
        if (otherUsersForVote.length === 0) continue;

        const voterId = faker.helpers.arrayElement(otherUsersForVote);
        createNotification(tick.userId, voterId, 'vote_on_tick', 'tick', tick.uuid, null, 14);
      }
    }

    // 4. vote_on_comment notifications — for a subset of all comments
    const allCommentRecords = [...parentRecords, ...replyRecords];
    const commentsForVotes = allCommentRecords.filter(() => faker.datatype.boolean(0.2));
    for (const comment of commentsForVotes) {
      const otherUsersForVote = allUsers.filter((id) => id !== comment.userId);
      if (otherUsersForVote.length === 0) continue;

      const voterId = faker.helpers.arrayElement(otherUsersForVote);
      createNotification(comment.userId, voterId, 'vote_on_comment', 'comment', comment.uuid, null, 14);
    }

    // 5. comment_reply notifications — from actual reply comments
    for (const reply of replyRecords) {
      const replyId = replyIdMap.get(reply.uuid) ?? null;
      createNotification(reply._parentUserId, reply.userId, 'comment_reply', 'comment', reply._parentUuid, replyId, 10);
    }

    // 6. Fixture comment notifications
    for (const conv of FIXTURE_CONVERSATIONS) {
      const tick = fixtureTickMap.get(conv.tickUuid);
      if (!tick) continue;

      for (const c of conv.comments) {
        const commentId = fixtureCommentIdMap.get(c.uuid) ?? null;

        if (c.parentCommentUuid === null) {
          // Top-level comment → comment_on_tick notification to tick owner
          createNotification(tick.userId, c.userId, 'comment_on_tick', 'tick', conv.tickUuid, commentId, 14);
        } else {
          // Reply → comment_reply notification to parent comment author
          const parentComment = conv.comments.find((pc) => pc.uuid === c.parentCommentUuid);
          if (parentComment) {
            createNotification(
              parentComment.userId,
              c.userId,
              'comment_reply',
              'comment',
              c.parentCommentUuid,
              commentId,
              10,
            );
          }
        }
      }
    }

    // Shuffle notifications so they're not grouped by type when sorted by createdAt
    const shuffledNotifications = faker.helpers.shuffle(notificationRecords);

    // Batch insert notifications
    for (let i = 0; i < shuffledNotifications.length; i += BATCH_SIZE) {
      const batch = shuffledNotifications.slice(i, i + BATCH_SIZE);
      await db.insert(notifications).values(batch).onConflictDoNothing();
      process.stdout.write(
        `\r  Notifications: ${Math.min(i + BATCH_SIZE, shuffledNotifications.length)}/${shuffledNotifications.length}`,
      );
    }
    console.info('');

    const unreadNotifications = notificationRecords.filter((n) => n.readAt == null).length;
    const devUserNotifications = notificationRecords.filter((n) => devUserIds.has(n.recipientId)).length;
    const devUserUnread = notificationRecords.filter((n) => devUserIds.has(n.recipientId) && n.readAt == null).length;

    // =========================================================================
    // Summary
    // =========================================================================
    const ticksWithBoard = tickRecords.filter((t) => t.boardId != null).length;
    const testUserTicks = tickRecords.filter((t) => t.userId === TEST_USER_ID).length;

    console.info('\nSeed completed!');
    console.info(`  Fake users: ${fakeUserRecords.length}`);
    console.info(`  Fixture users: ${FIXTURE_USERS.length}`);
    console.info(`  User profiles: ${profileRecords.length}`);
    console.info(`  Follow relationships: ${followRecords.length}`);
    console.info(`  User boards: ${boardRecords.length}`);
    console.info(`  Board follows: ${boardFollowRecords.length}`);
    console.info(
      `  Ascent ticks: ${tickRecords.length} (${testUserTicks} test user, ${ticksWithBoard} linked to boards)`,
    );
    console.info(`  Fixture ticks: ${fixtureTickRecords.length}`);
    console.info(
      `  Comments: ${parentCount + replyCount} (${parentCount} top-level, ${replyCount} replies in ${threadCount} threads)`,
    );
    console.info(
      `  Fixture comments: ${fixtureCommentIdMap.size} (${fixtureParentCount} parents + ${fixtureReplyCount} replies)`,
    );
    console.info(`  Fixture votes: ${fixtureVoteRecords.length}`);
    console.info(`  Feed items: ${feedItemRecords.length} (for test user activity feed)`);
    console.info(`  Notifications: ${notificationRecords.length} (${unreadNotifications} unread)`);
    console.info(`    Dev user notifications: ${devUserNotifications} (${devUserUnread} unread)`);

    await close();
    process.exit(0);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}

void seedSocialData();
