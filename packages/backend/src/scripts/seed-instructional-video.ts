/** Additive fixtures for the dedicated, loopback-only instructional-video DB. */
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hash } from 'bcryptjs';
import sharp from 'sharp';
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { createDb, closePool } from '@boardsesh/db/client';
import * as schema from '@boardsesh/db/schema';
import { allocateWallIds, allocateHoldIds, createSprayWallCatalogueRows } from '@boardsesh/db/queries';
import { MOONBOARD_SIZE, MOONBOARD_SETS, SPRAY_SET, SPRAY_ROLE, spraySizeIdForLayout } from '@boardsesh/board-config';
import { DEFAULT_BOARDSESH_RENDER_SETTINGS } from '@boardsesh/board-look';

const namespace = '63300000-0000-4000-8000-';
const primaryId = '00000000-0000-0000-0000-000000000001';
const crewId = `${namespace}000000000002`;
const sprayUuid = `${namespace}000000000004`;
const photoWidth = 1752;
const photoHeight = 2047;

function assertLocalTarget(): void {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    database.pathname !== '/boardsesh_tutorial' ||
    process.env.BOARDSESH_TUTORIAL_DEMO !== '1'
  ) {
    throw new Error('Tutorial seeding requires the isolated loopback boardsesh_tutorial database');
  }
  const storage = new URL(process.env.PRIVATE_AWS_ENDPOINT_URL ?? '');
  if (
    !['127.0.0.1', 'localhost'].includes(storage.hostname) ||
    storage.protocol !== 'http:' ||
    process.env.PRIVATE_S3_BUCKET_NAME !== 'tutorial-private'
  ) {
    throw new Error('Tutorial storage must be the local Moto tutorial-private bucket');
  }
}

async function main(): Promise<void> {
  assertLocalTarget();
  const root = resolve(process.argv[2] ?? '.');
  const output = resolve(process.argv[3] ?? '.boardsesh/tutorial-demo/seed.json');
  const db = createDb();
  const photo = await readFile(resolve(root, 'marketing/spray-walkthrough/wall-photo.jpg'));
  const holdBytes = await readFile(resolve(root, 'marketing/spray-walkthrough/holds.json'));
  const holdDocument = JSON.parse(holdBytes.toString('utf8')) as { holds: { x: number; y: number; r: number }[] };
  if (
    !Array.isArray(holdDocument.holds) ||
    holdDocument.holds.length < 28 ||
    holdDocument.holds.some(
      ({ x, y, r }) =>
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(r) ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1 ||
        r <= 0 ||
        r > 0.2,
    )
  ) {
    throw new Error('Tutorial hold geometry requires at least 28 normalized manual circles');
  }
  const dimensions = await sharp(photo).metadata();
  if (dimensions.width !== photoWidth || dimensions.height !== photoHeight)
    throw new Error('Tutorial photo dimensions changed; review hold geometry');
  const photoHash = createHash('sha256').update(photo).digest('hex');
  const fixtureFingerprint = createHash('sha256')
    .update(photo)
    .update(holdBytes)
    .update('tutorial-seed-v1')
    .digest('hex');
  const photoKey = `spray-walls/${sprayUuid}/tutorial-${photoHash.slice(0, 16)}.jpg`;
  const storage = new S3Client({
    endpoint: process.env.PRIVATE_AWS_ENDPOINT_URL,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'tutorial-local', secretAccessKey: 'tutorial-local' },
  });
  try {
    await storage.send(new HeadBucketCommand({ Bucket: 'tutorial-private' }));
  } catch {
    await storage.send(new CreateBucketCommand({ Bucket: 'tutorial-private' }));
  }
  await storage.send(
    new PutObjectCommand({ Bucket: 'tutorial-private', Key: photoKey, Body: photo, ContentType: 'image/jpeg' }),
  );
  await storage.send(
    new PutObjectCommand({
      Bucket: 'tutorial-private',
      Key: photoKey.replace(/\.jpg$/, '-full.jpg'),
      Body: photo,
      ContentType: 'image/jpeg',
    }),
  );
  const thumbnail = await sharp(photo).resize(280, 280, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
  await storage.send(
    new PutObjectCommand({
      Bucket: 'tutorial-private',
      Key: `${photoKey}@280.jpg`,
      Body: thumbnail,
      ContentType: 'image/jpeg',
    }),
  );

  await db
    .insert(schema.users)
    .values([
      { id: primaryId, email: 'test@boardsesh.com', name: 'Alex', emailVerified: new Date('2026-01-01') },
      { id: crewId, email: 'sam+tutorial@boardsesh.local', name: 'Sam', emailVerified: new Date('2026-01-01') },
    ])
    .onConflictDoNothing();
  await db
    .insert(schema.userCredentials)
    .values([
      { userId: primaryId, passwordHash: await hash('test', 12) },
      { userId: crewId, passwordHash: await hash('boardsesh-demo', 12) },
    ])
    .onConflictDoNothing();
  for (const profile of [
    { userId: primaryId, displayName: 'Alex', privacyOnboardingVersion: 1 },
    { userId: crewId, displayName: 'Sam', privacyOnboardingVersion: 1 },
  ]) {
    await db
      .insert(schema.userProfiles)
      .values(profile)
      .onConflictDoUpdate({
        target: schema.userProfiles.userId,
        set: { displayName: profile.displayName, privacyOnboardingVersion: 1 },
      });
  }
  await db
    .insert(schema.userFollows)
    .values([
      { followerId: primaryId, followingId: crewId },
      { followerId: crewId, followingId: primaryId },
    ])
    .onConflictDoNothing();

  const boards: {
    uuid: string;
    name: string;
    boardType: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
  }[] = [];
  const configurations = [
    { type: 'kilter', layoutId: 1, preferredSize: 7, name: 'Kilter' },
    { type: 'tension', layoutId: 10, preferredSize: null, name: 'Tension' },
    { type: 'moonboard', layoutId: 2, preferredSize: null, name: 'MoonBoard' },
  ];
  for (const [index, configuration] of configurations.entries()) {
    const joins = await db
      .select()
      .from(schema.boardProductSizesLayoutsSets)
      .where(
        and(
          eq(schema.boardProductSizesLayoutsSets.boardType, configuration.type),
          eq(schema.boardProductSizesLayoutsSets.layoutId, configuration.layoutId),
        ),
      )
      .orderBy(asc(schema.boardProductSizesLayoutsSets.productSizeId));
    const sizeId =
      configuration.type === 'moonboard' ? MOONBOARD_SIZE.id : (configuration.preferredSize ?? joins[0]?.productSizeId);
    const setIds =
      configuration.type === 'moonboard'
        ? MOONBOARD_SETS['moonboard-2016'].map((set) => set.id).join(',')
        : [
            ...new Set(
              joins
                .filter((row) => row.productSizeId === sizeId)
                .map((row) => row.setId)
                .filter((setId): setId is number => setId !== null),
            ),
          ]
            .sort((left, right) => left - right)
            .join(',');
    if (!sizeId || !setIds) throw new Error(`Dev image lacks tutorial ${configuration.type} catalogue`);
    const board = {
      uuid: `${namespace}${String(10 + index).padStart(12, '0')}`,
      name: `Tutorial ${configuration.name}`,
      boardType: configuration.type,
      layoutId: configuration.layoutId,
      sizeId,
      setIds,
      angle: 40,
    };
    await db
      .insert(schema.userBoards)
      .values({
        ...board,
        ownerId: primaryId,
        slug: `tutorial-${configuration.type}`,
        isPublic: true,
        locationName: 'Boardsesh Demo',
        hasLeds: true,
      })
      .onConflictDoUpdate({ target: schema.userBoards.uuid, set: { hasLeds: true } });
    boards.push(board);
  }

  // Manual provenance and catalogue rows stay transactional. Re-running never replaces a wall or its history.
  let [wall] = await db.select().from(schema.sprayWalls).where(eq(schema.sprayWalls.boardUuid, sprayUuid)).limit(1);
  if (!wall) {
    wall = await db.transaction(async (tx) => {
      let wallIds = await allocateWallIds(tx);
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const [existingLayout] = await tx
          .select({ id: schema.boardLayouts.id })
          .from(schema.boardLayouts)
          .where(and(eq(schema.boardLayouts.boardType, 'spray'), eq(schema.boardLayouts.id, wallIds.layoutId)))
          .limit(1);
        const [existingSize] = await tx
          .select({ id: schema.boardProductSizes.id })
          .from(schema.boardProductSizes)
          .where(and(eq(schema.boardProductSizes.boardType, 'spray'), eq(schema.boardProductSizes.id, wallIds.sizeId)))
          .limit(1);
        if (!existingLayout && !existingSize) break;
        wallIds = await allocateWallIds(tx);
        if (attempt === 999) throw new Error('Dev image spray catalogue sequence overlaps more than 1000 layouts');
      }
      const { layoutId, sizeId } = wallIds;
      await createSprayWallCatalogueRows(tx, {
        layoutId,
        name: 'Tutorial Spray Wall',
        referenceWidth: photoWidth,
        referenceHeight: photoHeight,
      });
      await tx.insert(schema.userBoards).values({
        uuid: sprayUuid,
        slug: 'tutorial-spray-wall',
        name: 'Tutorial Spray Wall',
        ownerId: primaryId,
        boardType: 'spray',
        layoutId,
        sizeId,
        setIds: String(SPRAY_SET.id),
        angle: 30,
        isPublic: false,
        isUnlisted: true,
        hasLeds: false,
        isAngleAdjustable: false,
      });
      const [created] = await tx
        .insert(schema.sprayWalls)
        .values({
          boardUuid: sprayUuid,
          layoutId,
          referenceWidth: photoWidth,
          referenceHeight: photoHeight,
          holdCount: holdDocument.holds.length,
          renderSettings: {
            mode: 'aura',
            boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, markStyle: 'outline', holdShape: 'circle' },
            background: 'photo',
          },
        })
        .returning();
      const [version] = await tx
        .insert(schema.sprayWallVersions)
        .values({
          wallId: created.id,
          versionNumber: 1,
          status: 'published',
          photoKey,
          photoWidth,
          photoHeight,
          homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          createdBy: primaryId,
          publishedAt: new Date('2026-10-01'),
        })
        .returning();
      let holdIds = await allocateHoldIds(tx, holdDocument.holds.length);
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const [existingHole] = await tx
          .select({ id: schema.boardHoles.id })
          .from(schema.boardHoles)
          .where(and(eq(schema.boardHoles.boardType, 'spray'), inArray(schema.boardHoles.id, holdIds)))
          .limit(1);
        const [existingPlacement] = await tx
          .select({ id: schema.boardPlacements.id })
          .from(schema.boardPlacements)
          .where(and(eq(schema.boardPlacements.boardType, 'spray'), inArray(schema.boardPlacements.id, holdIds)))
          .limit(1);
        if (!existingHole && !existingPlacement) break;
        holdIds = await allocateHoldIds(tx, holdDocument.holds.length);
        if (attempt === 999) throw new Error('Dev image spray hold sequence overlaps more than 1000 allocation blocks');
      }
      for (const [index, hold] of holdDocument.holds.entries()) {
        const holdId = holdIds[index];
        const cx = Math.round(hold.x * photoWidth);
        const cy = Math.round(hold.y * photoHeight);
        const radius = Math.round(hold.r * photoWidth);
        await tx.insert(schema.boardHoles).values({ boardType: 'spray', id: holdId, productId: null, x: cx, y: cy });
        await tx.insert(schema.boardPlacements).values({
          boardType: 'spray',
          id: holdId,
          layoutId,
          holeId: holdId,
          setId: SPRAY_SET.id,
          defaultPlacementRoleId: null,
        });
        await tx.insert(schema.sprayWallHolds).values({
          wallId: created.id,
          holdId,
          cx,
          cy,
          r: radius,
          source: 'manual',
          outline: null,
          installedVersionId: version.id,
        });
      }
      const [publishedWall] = await tx
        .update(schema.sprayWalls)
        .set({ currentVersionId: version.id })
        .where(eq(schema.sprayWalls.id, created.id))
        .returning();
      return publishedWall;
    });
  }
  const [existingVersion] = await db
    .select()
    .from(schema.sprayWallVersions)
    .where(and(eq(schema.sprayWallVersions.wallId, wall.id), eq(schema.sprayWallVersions.versionNumber, 1)))
    .limit(1);
  if (existingVersion?.photoKey !== photoKey || wall.holdCount !== holdDocument.holds.length)
    throw new Error('Tutorial media changed; add a reviewed fixture revision instead of overwriting the existing wall');
  const holds = await db
    .select()
    .from(schema.sprayWallHolds)
    .where(eq(schema.sprayWallHolds.wallId, wall.id))
    .orderBy(asc(schema.sprayWallHolds.holdId));
  if (
    holds.length !== holdDocument.holds.length ||
    holds.some((hold, index) => {
      const expected = holdDocument.holds[index];
      return (
        hold.cx !== Math.round(expected.x * photoWidth) ||
        hold.cy !== Math.round(expected.y * photoHeight) ||
        hold.r !== Math.round(expected.r * photoWidth) ||
        hold.source !== 'manual'
      );
    })
  )
    throw new Error(
      'Tutorial manual hold geometry changed; add a reviewed fixture revision instead of replacing recorded holds',
    );
  const roleStates = [
    'STARTING',
    'STARTING',
    'HAND',
    'HAND',
    'FINISH',
    'FOOT',
  ] as const satisfies readonly (keyof typeof SPRAY_ROLE)[];
  const roleCodes = roleStates.map((state) => SPRAY_ROLE[state]);
  const spraySizeId = spraySizeIdForLayout(wall.layoutId);
  for (const [index, name] of ['After Work', 'Crew Project', 'One More Go'].entries()) {
    const climbUuid = `${namespace}${String(100 + index).padStart(12, '0')}`;
    const selected = [holds[23], holds[24], holds[22], holds[18 + index], holds[index * 3], holds[25 + index]];
    const frames = selected.map((hold, holdIndex) => `p${hold.holdId}r${roleCodes[holdIndex]}`).join('');
    await db
      .insert(schema.boardClimbs)
      .values({
        uuid: climbUuid,
        boardType: 'spray',
        layoutId: wall.layoutId,
        name,
        userId: primaryId,
        setterUsername: 'Alex',
        isBoardseshAuthored: true,
        angle: 30,
        frames,
        isDraft: false,
        isListed: true,
        requiredSetIds: [SPRAY_SET.id],
        compatibleSizeIds: [spraySizeId],
        missingHoldCount: 0,
        edgeLeft: 0,
        edgeRight: photoWidth,
        edgeBottom: 0,
        edgeTop: photoHeight,
        createdAt: '2026-10-01T12:00:00Z',
        publishedAt: '2026-10-01T12:00:00Z',
      })
      .onConflictDoNothing();
    await db
      .insert(schema.boardClimbHolds)
      .values(
        selected.map((hold, holdIndex) => ({
          boardType: 'spray',
          climbUuid,
          holdId: hold.holdId,
          frameNumber: 0,
          holdState: roleStates[holdIndex],
        })),
      )
      .onConflictDoNothing();
    await db
      .insert(schema.boardClimbStats)
      .values({
        boardType: 'spray',
        climbUuid,
        angle: 30,
        displayDifficulty: 14 + index,
        difficultyAverage: 14 + index,
        qualityAverage: 4,
        ascensionistCount: 1,
        boardseshAscensionistCount: 1,
      })
      .onConflictDoNothing();
  }
  boards.push({
    uuid: sprayUuid,
    name: 'Tutorial Spray Wall',
    boardType: 'spray',
    layoutId: wall.layoutId,
    sizeId: spraySizeId,
    setIds: String(SPRAY_SET.id),
    angle: 30,
  });
  const climbSelections: Record<
    string,
    { uuid: string; name: string | null; frames: string | null; difficulty: number | null }[]
  > = {};
  for (const board of boards) {
    const climbs = await db
      .select({
        uuid: schema.boardClimbs.uuid,
        name: schema.boardClimbs.name,
        frames: schema.boardClimbs.frames,
        difficulty: schema.boardClimbStats.displayDifficulty,
        setterUsername: schema.boardClimbs.setterUsername,
        description: schema.boardClimbs.description,
        ascensionistCount: schema.boardClimbStats.ascensionistCount,
        qualityAverage: schema.boardClimbStats.qualityAverage,
        compatibleSizeIds: schema.boardClimbs.compatibleSizeIds,
      })
      .from(schema.boardClimbs)
      .innerJoin(
        schema.boardClimbStats,
        and(
          eq(schema.boardClimbStats.climbUuid, schema.boardClimbs.uuid),
          eq(schema.boardClimbStats.angle, board.angle),
        ),
      )
      .where(
        and(
          eq(schema.boardClimbs.boardType, board.boardType),
          eq(schema.boardClimbs.layoutId, board.layoutId),
          eq(schema.boardClimbs.isDraft, false),
          eq(schema.boardClimbs.isListed, true),
        ),
      )
      .orderBy(asc(schema.boardClimbs.uuid))
      .limit(16);
    if (climbs.length === 0) throw new Error(`No published tutorial climbs for ${board.boardType}`);
    climbSelections[board.boardType] = climbs;
    const [boardRow] = await db
      .select({ id: schema.userBoards.id })
      .from(schema.userBoards)
      .where(eq(schema.userBoards.uuid, board.uuid));
    for (const [index, climb] of climbs.entries()) {
      await db
        .insert(schema.boardseshTicks)
        .values({
          uuid: `${namespace}${String(1000 + boards.indexOf(board) * 100 + index).padStart(12, '0')}`,
          userId: primaryId,
          boardType: board.boardType,
          climbUuid: climb.uuid,
          angle: board.angle,
          status: index % 5 === 0 ? 'attempt' : index % 3 === 0 ? 'flash' : 'send',
          attemptCount: index % 3 === 0 ? 1 : 3,
          quality: 4,
          difficulty: Math.round(climb.difficulty ?? 14) + (index % 2),
          boardId: boardRow.id,
          climbedAt: new Date(Date.UTC(2026, 8, 1 + index * 2, 18)).toISOString(),
          comment: index === 0 ? 'Try the high foot before the last move.' : '',
        })
        .onConflictDoNothing();
    }
  }
  await db
    .insert(schema.boardFollows)
    .values(boards.map((board) => ({ userId: crewId, boardUuid: board.uuid })))
    .onConflictDoNothing();
  const crewCandidate = await db
    .select({
      uuid: schema.boardClimbs.uuid,
      name: schema.boardClimbs.name,
      frames: schema.boardClimbs.frames,
      setterUsername: schema.boardClimbs.setterUsername,
      difficulty: schema.boardClimbStats.displayDifficulty,
      quality: schema.boardClimbStats.qualityAverage,
      ascents: schema.boardClimbStats.ascensionistCount,
      compatibleSizeIds: schema.boardClimbs.compatibleSizeIds,
    })
    .from(schema.boardClimbs)
    .innerJoin(
      schema.boardClimbStats,
      and(eq(schema.boardClimbStats.climbUuid, schema.boardClimbs.uuid), eq(schema.boardClimbStats.angle, 40)),
    )
    .where(
      and(
        eq(schema.boardClimbs.boardType, 'kilter'),
        eq(schema.boardClimbs.layoutId, 1),
        eq(schema.boardClimbs.isDraft, false),
        eq(schema.boardClimbs.isListed, true),
      ),
    )
    .orderBy(asc(schema.boardClimbs.uuid))
    .limit(20);
  const crewClimbs = crewCandidate
    .filter((climb) => climb.frames && climb.name)
    .map((climb) => ({
      uuid: climb.uuid,
      boardType: 'kilter',
      layoutId: 1,
      setter_username: climb.setterUsername ?? 'Unknown setter',
      name: climb.name!,
      frames: climb.frames!,
      angle: 40,
      ascensionist_count: climb.ascents ?? 0,
      difficulty: String(climb.difficulty ?? 14),
      quality_average: String(climb.quality ?? 4),
      stars: climb.quality ?? 4,
      difficulty_error: '0',
      compatibleSizeIds: climb.compatibleSizeIds,
    }));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify({ fixtureRevision: 1, fixtureFingerprint, photoSha256: photoHash, primaryUserId: primaryId, crewUserId: crewId, crewProfile: { id: crewId, username: 'Sam', avatarUrl: null }, crewClimb: crewClimbs[1], crewClimbs, boards, climbs: climbSelections }, null, 2)}\n`,
  );
  logger.info('[tutorial-demo] Seed ready: four boards, manual spray holds, crew and progress');
  await closePool();
}

main().catch(async (error: unknown) => {
  logger.error('[tutorial-demo] Seed failed', { error });
  await closePool();
  process.exitCode = 1;
});
