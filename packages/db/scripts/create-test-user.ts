import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';
import { users } from '../src/schema/auth/users.js';
import { userCredentials, userProfiles } from '../src/schema/auth/credentials.js';
import { playlists, playlistOwnership, userPlaylistPins } from '../src/schema/app/playlists.js';
import { seedPlaylistClimbs } from './seed-playlist-climbs.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_USER_EMAIL = 'test@boardsesh.com';
const TEST_USER_NAME = 'test';
const TEST_USER_DISPLAY_NAME = 'Test User';

// Pre-computed bcrypt hash of "test" with 12 rounds.
// Generated with: bcrypt.hash('test', 12)
const TEST_PASSWORD_HASH = '$2b$12$ICPPBhOLDExMf2JX88WhCOz8wbvGHn0VuA5MI1F1bm1kDewpD1/GC';

// Deterministic playlist seed for the test user. Spread across boards and a
// mix of layoutIds (including `null`, which is what Aurora-synced circuits
// look like in the DB) so QA can exercise the BoardFilterStrip and the
// `layoutId IS NULL` branch in the user-playlists resolver.
//
// 40 playlists total: 22 Kilter + 12 Tension + 6 Aurora-synced (null layout).
// Three are pinned at seed time so the new "Pinned" grid is non-empty out of
// the box without having to click around.
const PLAYLIST_COLORS = [
  '#06B6D4', // cyan
  '#A855F7', // purple
  '#22C55E', // green
  '#F59E0B', // amber
  '#EC4899', // pink
  '#EF4444', // red
];

// playlists.icon stores raw emoji characters (rendered verbatim by
// PlaylistPreviewSquare). Don't put MUI component names here — they show
// up as literal text on the cards.
const PLAYLIST_ICONS = ['⭐', '🔥', '📈', '🔖', '🚩', '🧗', '💪', '🎯'];

type PlaylistSeed = {
  uuid: string;
  boardType: string;
  layoutId: number | null;
  name: string;
  isPublic: boolean;
  pin: boolean;
};

function makePlaylistSeeds(): PlaylistSeed[] {
  const seeds: PlaylistSeed[] = [];

  // Kilter — Original 12x12 (layoutId=1)
  // Projects 3/6/9 are public (i % 3 === 0). Kilter layoutId 1 is a
  // well-populated layout in the dev DB, so these public playlists get real
  // climbs and surface in Discover for screenshots.
  for (let i = 1; i <= 10; i++) {
    seeds.push({
      uuid: `00000000-0000-4000-8000-000000000${(100 + i).toString().padStart(3, '0')}`,
      boardType: 'kilter',
      layoutId: 1,
      name: `Kilter Original Project ${i}`,
      isPublic: i % 3 === 0,
      pin: i === 1, // pin one
    });
  }

  // Kilter — Homewall (layoutId=8)
  for (let i = 1; i <= 7; i++) {
    seeds.push({
      uuid: `00000000-0000-4000-8000-000000000${(120 + i).toString().padStart(3, '0')}`,
      boardType: 'kilter',
      layoutId: 8,
      name: `Kilter Homewall V${i}+`,
      isPublic: false,
      pin: false,
    });
  }

  // Kilter — 10x10 (layoutId=12)
  for (let i = 1; i <= 5; i++) {
    seeds.push({
      uuid: `00000000-0000-4000-8000-000000000${(130 + i).toString().padStart(3, '0')}`,
      boardType: 'kilter',
      layoutId: 12,
      name: `Kilter 10x10 Warmup ${i}`,
      isPublic: false,
      pin: i === 2,
    });
  }

  // Tension — Original (layoutId=1)
  for (let i = 1; i <= 7; i++) {
    seeds.push({
      uuid: `00000000-0000-4000-8000-000000000${(140 + i).toString().padStart(3, '0')}`,
      boardType: 'tension',
      layoutId: 1,
      name: `Tension Original Spray ${i}`,
      isPublic: i === 1,
      pin: false,
    });
  }

  // Tension — TB2 (layoutId=10)
  // #1 is public. TB2 (layoutId 10) is a confirmed-populated Tension layout
  // (it backs the recommendation cohorts), so this guarantees Discover has at
  // least one climb-filled public Tension playlist even if the legacy Tension
  // Original layout (layoutId 1) is sparse in the dev DB.
  for (let i = 1; i <= 5; i++) {
    seeds.push({
      uuid: `00000000-0000-4000-8000-000000000${(150 + i).toString().padStart(3, '0')}`,
      boardType: 'tension',
      layoutId: 10,
      name: `TB2 Crimps & Pinches ${i}`,
      isPublic: i === 1,
      pin: i === 3,
    });
  }

  // Aurora-synced shape: layoutId = null. Simulates circuits pulled from the
  // Aurora `/sync` endpoint, which is the case Annette reported in #1592.
  for (let i = 1; i <= 6; i++) {
    seeds.push({
      uuid: `00000000-0000-4000-8000-000000000${(160 + i).toString().padStart(3, '0')}`,
      boardType: i <= 4 ? 'kilter' : 'tension',
      layoutId: null,
      name: `Aurora Circuit ${i}`,
      isPublic: false,
      pin: false,
    });
  }

  return seeds;
}

async function seedTestUserPlaylists(db: ReturnType<typeof createScriptDb>['db']): Promise<void> {
  const seeds = makePlaylistSeeds();
  let totalClimbs = 0;
  // Stagger timestamps so "ordered by lastAccessedAt desc" yields a
  // predictable order — index 0 is most-recent, last is oldest.
  const baseTimestamp = Date.now();

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const lastAccessedAt = new Date(baseTimestamp - i * 60_000); // 1 minute apart
    const createdAt = new Date(baseTimestamp - (seeds.length + i) * 60_000);

    const color = PLAYLIST_COLORS[i % PLAYLIST_COLORS.length];
    const icon = PLAYLIST_ICONS[i % PLAYLIST_ICONS.length];

    // upsert by uuid so re-running picks up display field changes (icon,
    // color, name) for existing rows. Keeps the same `id`, so prior pins
    // and ownerships survive.
    const [inserted] = await db
      .insert(playlists)
      .values({
        uuid: seed.uuid,
        boardType: seed.boardType,
        layoutId: seed.layoutId,
        name: seed.name,
        description: null,
        isPublic: seed.isPublic,
        color,
        icon,
        createdAt,
        updatedAt: lastAccessedAt,
        lastAccessedAt,
      })
      .onConflictDoUpdate({
        target: playlists.uuid,
        // Include isPublic so re-running against an existing DB converges the
        // visibility flag (e.g. flips the Tension TB2 playlist public) — without
        // it, Discover stays empty on a container built from an older image.
        set: { name: seed.name, color, icon, isPublic: seed.isPublic, updatedAt: lastAccessedAt },
      })
      .returning({ id: playlists.id });

    const playlistId = inserted?.id;
    if (playlistId == null) continue;

    await db
      .insert(playlistOwnership)
      .values({ playlistId, userId: TEST_USER_ID, role: 'owner', createdAt })
      .onConflictDoNothing();

    if (seed.pin) {
      await db.insert(userPlaylistPins).values({ userId: TEST_USER_ID, playlistId, createdAt }).onConflictDoNothing();
    }

    // Fill the playlist with real climbs so Discover and the playlist screens
    // render content (the Discover resolver INNER JOINs playlist_climbs, so an
    // empty public playlist shows nothing). Deterministic + idempotent.
    totalClimbs += await seedPlaylistClimbs(db, { playlistId, boardType: seed.boardType, layoutId: seed.layoutId });
  }

  console.info(
    `Seeded ${seeds.length} playlists for test user (${seeds.filter((seed) => seed.pin).length} pinned, ${totalClimbs} playlist-climbs).`,
  );
}

async function createTestUser() {
  const databaseUrl = getScriptDatabaseUrl();
  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] || 'unknown';
  console.info(`Creating test user on: ${dbHost}`);

  const { db, close } = createScriptDb(databaseUrl);

  try {
    // Insert user
    await db
      .insert(users)
      .values({
        id: TEST_USER_ID,
        name: TEST_USER_NAME,
        email: TEST_USER_EMAIL,
        emailVerified: new Date(),
      })
      .onConflictDoNothing();

    // Insert credentials
    await db
      .insert(userCredentials)
      .values({
        userId: TEST_USER_ID,
        passwordHash: TEST_PASSWORD_HASH,
      })
      .onConflictDoNothing();

    // Insert profile
    await db
      .insert(userProfiles)
      .values({
        userId: TEST_USER_ID,
        displayName: TEST_USER_DISPLAY_NAME,
      })
      .onConflictDoNothing();

    await seedTestUserPlaylists(db);

    console.info(`Test user created: ${TEST_USER_EMAIL} / test`);
    await close();
    process.exit(0);
  } catch (error) {
    console.error('Failed to create test user:', error);
    await close();
    process.exit(1);
  }
}

void createTestUser();
