/** Local-only, additive fixtures for the iOS performance comparison. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { boardClimbs, playlistClimbs, playlistOwnership, playlists, users } from '../src/schema/index';

async function main() {
  const databaseUrl = process.env.BOARDSESH_PROFILE_DATABASE_URL;
  if (!databaseUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) {
    throw new Error('Set BOARDSESH_PROFILE_DATABASE_URL to the explicitly selected loopback fixture database.');
  }
  const connection = postgres(databaseUrl, { max: 1 });
  const db = drizzle(connection);
  try {
    const [testUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'test@boardsesh.com'));
    if (!testUser) throw new Error('The local test@boardsesh.com fixture account must exist first.');
    const climbs = await db
      .select({ uuid: boardClimbs.uuid, name: boardClimbs.name, layoutId: boardClimbs.layoutId })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.boardType, 'tension'), eq(boardClimbs.isDraft, false), eq(boardClimbs.isListed, true)))
      .orderBy(asc(boardClimbs.uuid))
      .limit(12);
    if (climbs.length < 12) throw new Error('Load the real Tension climb catalogue before seeding.');
    const communityOwnerId = 'ios-performance-community-fixture-v1';
    const fixedTimestamp = new Date('2026-09-08T00:00:00Z');
    const fixtureUuids: string[] = [];
    await db.transaction(async (transaction) => {
      await transaction
        .insert(users)
        .values({
          id: communityOwnerId,
          name: 'Local performance crew',
          email: 'ios-performance-fixture@example.invalid',
          createdAt: fixedTimestamp,
          updatedAt: fixedTimestamp,
        })
        .onConflictDoNothing();
      for (const shelf of ['owned', 'community'] as const) {
        for (let index = 0; index < 200; index++) {
          const ordinal = String(index + 1).padStart(3, '0');
          const uuid = `ios-performance-v1-${shelf}-${ordinal}`;
          fixtureUuids.push(uuid);
          await transaction
            .insert(playlists)
            .values({
              uuid,
              boardType: 'tension',
              layoutId: null,
              name: `Performance ${shelf} ${ordinal}`,
              description: 'Local deterministic fixture with real Tension climbs.',
              isPublic: shelf === 'community',
              createdAt: new Date(fixedTimestamp.getTime() + index * 1000),
              updatedAt: new Date(fixedTimestamp.getTime() + index * 1000),
            })
            .onConflictDoNothing();
          const [playlist] = await transaction
            .select({ id: playlists.id })
            .from(playlists)
            .where(eq(playlists.uuid, uuid));
          if (!playlist) throw new Error(`Fixture insert missing: ${uuid}`);
          await transaction
            .insert(playlistOwnership)
            .values({
              playlistId: playlist.id,
              userId: shelf === 'owned' ? testUser.id : communityOwnerId,
              role: 'owner',
            })
            .onConflictDoNothing();
          await transaction
            .insert(playlistClimbs)
            .values(
              climbs.map((climb, position) => ({
                playlistId: playlist.id,
                climbUuid: climb.uuid,
                angle: 40,
                position,
              })),
            )
            .onConflictDoNothing();
        }
      }
    });
    const seededPlaylists = await db
      .select({ uuid: playlists.uuid })
      .from(playlists)
      .where(inArray(playlists.uuid, fixtureUuids));
    if (seededPlaylists.length !== 400) throw new Error('Incomplete fixture set.');
    const identity = { version: 1, boardType: 'tension', angle: 40, owned: 200, community: 200, climbs, fixtureUuids };
    const artifact = { ...identity, sha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
    const outputDirectory = resolve(process.cwd(), '.boardsesh');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(resolve(outputDirectory, 'ios-performance-fixtures.json'), JSON.stringify(artifact, null, 2));
    console.log(`Local fixture ready: 200 owned + 200 community playlists, 12 real climbs each; ${artifact.sha256}`);
  } finally {
    await connection.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
