import crypto from 'crypto';
import { GraphQLError } from 'graphql';
import { and, eq, sql } from 'drizzle-orm';
import {
  type ConnectionContext,
  type SaveClimbResult,
  type UpdateClimbResult,
  SUPPORTED_BOARDS,
  CLIMB_CHARACTERISTICS,
  TOGGLEABLE_CLIMB_CHARACTERISTICS,
  findCharacteristicConflict,
  isNoMatchClimb,
  usesAuroraNoMatchDescription,
  withCharacteristic,
  withNoMatch,
} from '@boardsesh/shared-schema';
import type { BoardName } from '@boardsesh/board-constants';
import { fingerprintFromHolds } from '@boardsesh/kilter-sync/sync';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { recomputeMissingHoldCountForClimb } from '@boardsesh/db/queries';
import { UNIFIED_TABLES, isValidBoardName } from '../../../db/queries/util/table-select';
import { publishSocialEvent } from '../../../events';
import { notifyClimbRevalidated } from '../../../lib/web-revalidate';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdminOrLeader } from '../social/roles';
import { deleteClimbDependentRows } from './climb-cleanup';
import {
  SPRAY_CLIMB_CODES,
  assertSprayAngleMatchesWall,
  assertSprayClimbIsSingleFrame,
  recordRemixLineage,
  populateSprayClimbColumns,
  assertSprayGradeOnPublish,
  assertSprayHoldsAreAlive,
  isSprayBoard,
  requireVisibleSprayWall,
  sprayWallMayAnnounceUnderLock,
  type SprayClimbTarget,
} from './spray-authoring';
import {
  buildMoonBoardClimbHoldRows,
  buildMoonBoardDuplicateError,
  encodeMoonBoardHoldsToFrames,
  findMoonBoardDuplicateMatch,
} from './moonboard-duplicates';
import {
  CLIMB_DUPLICATE_ERROR_CODE,
  buildDuplicateClimbErrorMessage,
  buildHoldSignature,
  buildStoredRuleSignature,
  acquireDuplicateGateLock,
  findExactDuplicateMatch,
  parseFramesToHoldEntries,
} from './climb-similarity';
import {
  WOODS_AUTHORED_REQUIRED_SET_IDS,
  isWoodsBoard,
  requireWoodsSizeId,
  resolveWoodsUpdateSizeId,
  storedWoodsSizeId,
  validateWoodsClimb,
} from './woods-authoring';
import {
  BoardNameSchema,
  ExternalUUIDSchema,
  SaveClimbInputSchema,
  SaveMoonBoardClimbInputSchema,
  UpdateClimbInputSchema,
} from '../../../validation/schemas';

type SaveClimbArgs = { input: unknown };
type DeleteDraftClimbArgs = { uuid: unknown; boardType: unknown };

function generateClimbUuid(): string {
  // Match Aurora-style uppercase UUID without dashes
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

async function getUserProfile(userId: string) {
  const [user] = await db
    .select({
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);

  return {
    displayName: user?.displayName || user?.name || '',
    name: user?.name || '',
    avatarUrl: user?.avatarUrl || user?.image || undefined,
  };
}

async function resolveDifficultyId(boardType: string, grade?: string | null): Promise<number | null> {
  if (!grade) return null;
  const normalizedGrade = grade.trim().toLowerCase();
  const rawFontPart = normalizedGrade.split('/')[0].trim();
  const fontPart = rawFontPart === '5+' ? '5a' : rawFontPart;

  const [row] = await db
    .select({ difficulty: dbSchema.boardDifficultyGrades.difficulty })
    .from(dbSchema.boardDifficultyGrades)
    .where(
      and(
        eq(dbSchema.boardDifficultyGrades.boardType, boardType),
        sql`(
          LOWER(${dbSchema.boardDifficultyGrades.boulderName}) = ${normalizedGrade}
          OR LOWER(SPLIT_PART(${dbSchema.boardDifficultyGrades.boulderName}, '/', 1)) = ${fontPart}
        )`,
      ),
    )
    .orderBy(
      sql`CASE WHEN LOWER(${dbSchema.boardDifficultyGrades.boulderName}) = ${normalizedGrade} THEN 0 ELSE 1 END`,
      dbSchema.boardDifficultyGrades.difficulty,
    )
    .limit(1);

  return row?.difficulty ?? null;
}

export const climbMutations = {
  /**
   * Save a new climb for Aurora-style boards (kilter/tension) via GraphQL.
   * Persists to the unified board_climbs table and publishes a climb.created event.
   */
  saveClimb: async (_: unknown, { input }: SaveClimbArgs, ctx: ConnectionContext): Promise<SaveClimbResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'saveClimb');

    const validated = validateInput(SaveClimbInputSchema, input, 'input');
    const isListed = !validated.isDraft;

    if (!isValidBoardName(validated.boardType)) {
      throw new Error(
        `Invalid board type: ${String(validated.boardType)}. Must be one of ${SUPPORTED_BOARDS.join(', ')}`,
      );
    }
    const boardType = validated.boardType as BoardName;

    // Spray: a `layoutId` is not authorization. Resolve the wall and check the
    // caller can SEE it (view access, not edit — setting a climb on a gym's spray
    // wall is what a gym member is there to do; only the wall's holds are the
    // owner's alone), then hold it for the authoritative denormalised columns and
    // the feed-event decision below. See `./spray-authoring.ts` for all four
    // rules this replaced SW-03's blanket reject-spray gate with.
    const sprayTarget: SprayClimbTarget | null = isSprayBoard(boardType)
      ? await requireVisibleSprayWall(validated.layoutId, ctx.userId!, validated.sprayWallUuid)
      : null;
    if (sprayTarget) {
      // Ahead of every write: a spray wall has no crowd grade to converge on
      // (`crowdGrade: false`), so a published climb with no setter grade would
      // stay ungraded forever.
      assertSprayGradeOnPublish(validated.isDraft, validated.userGrade);
      // A wall's angle is fixed for its life — it is chosen once at creation and
      // `is_angle_adjustable` is false — so an angle that disagrees with the wall
      // is a client bug, and accepting it would scatter the wall's climbs and
      // stats across angles that do not exist. Rejected rather than silently
      // coerced, so the client learns it is sending the wrong number.
      assertSprayAngleMatchesWall(sprayTarget, validated.angle);
      // `multiFrameClimbs: false`, and nothing downstream enforces it — including
      // the duplicate gate, which only fires for a single frame, so a multi-frame
      // spray climb would bypass the per-wall duplicate check entirely.
      assertSprayClimbIsSingleFrame(validated.framesCount, validated.frames);
    }

    // A remix is a spray-wall idea and `spray_climb_lineage` is a spray table, so
    // there is nothing a remix of a Kilter climb could write. Rejected rather than
    // ignored: dropping the field silently would save the climb, report success,
    // and leave the client believing a link exists that never will — and the
    // lineage row can only be written once, with the child.
    if (!sprayTarget && validated.remixOfClimbUuid) {
      throw new GraphQLError('Only spray wall climbs can be remixed', {
        extensions: { code: SPRAY_CLIMB_CODES.remixParentNotFound, boardType },
      });
    }

    // Woods is code-driven: no board_placements to validate a hold against and
    // no board_product_sizes to derive compatibility from, so the shared
    // geometry/role tables are the only schema there is and every rule has to be
    // checked here. Doing it up front also fixes the size for the rest of the
    // resolver — the duplicate key, the denormalised columns and the hold rows
    // all need it.
    const woodsShape = isWoodsBoard(boardType)
      ? validateWoodsClimb({
          layoutId: validated.layoutId,
          sizeId: requireWoodsSizeId(validated.sizeId),
          angle: validated.angle,
          frames: validated.frames,
          framesCount: validated.framesCount,
          framesPace: validated.framesPace,
          isDraft: validated.isDraft,
        })
      : null;

    // Build the row's rules before anything touches the database: they are half
    // the duplicate key now, so the gate below needs them, and a contradictory
    // rule set should be rejected without a round-trip.
    //
    // `noMatch` is explicit and wins outright; when the client omits it (or is an
    // old build that has never heard of the field) we fall back to deriving it
    // from the raw description, which may still carry the Aurora "No match\n"
    // prefix. Without that derivation a climb created with no_match AND a toggle
    // stored characteristics=['no_kickboard'] — non-null, so readers that prefer
    // the array over the description fallback silently dropped the no-match badge
    // until the next edit.
    const noMatch =
      validated.noMatch ?? (usesAuroraNoMatchDescription(boardType) && isNoMatchClimb(validated.description));
    let nextCharacteristics = withCharacteristic(
      validated.characteristics ?? [],
      CLIMB_CHARACTERISTICS.NO_MATCH,
      noMatch,
    );
    nextCharacteristics = withCharacteristic(
      nextCharacteristics,
      CLIMB_CHARACTERISTICS.ANY_FEET,
      validated.anyFeet ?? false,
    );
    const conflict = findCharacteristicConflict(nextCharacteristics);
    if (conflict) {
      throw new GraphQLError(`"${conflict.token}" cannot be combined with "${conflict.conflictsWith}"`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Woods persists `[]` where other boards persist NULL. On Woods a NULL means
    // "rules unknown, waiting on the catalog repair" (the imported catalog has no
    // rule data), so an authored climb that genuinely has no rules must say so
    // explicitly or it reads as an un-repaired import forever.
    const storedDescription = usesAuroraNoMatchDescription(boardType)
      ? withNoMatch(validated.description ?? '', false)
      : (validated.description ?? '');
    const storedCharacteristics =
      woodsShape ||
      nextCharacteristics.length > 0 ||
      (usesAuroraNoMatchDescription(boardType) && isNoMatchClimb(storedDescription))
        ? nextCharacteristics
        : null;

    const now = new Date().toISOString();
    const publishedAt = validated.isDraft ? null : now;
    const { displayName, name, avatarUrl } = await getUserProfile(ctx.userId!);
    const preferredSetter = displayName || name || null;

    const framesCount = validated.framesCount ?? 1;
    const holdEntries = parseFramesToHoldEntries(boardType, validated.frames);
    const uuid = generateClimbUuid();

    // Resolved before the transaction so a grade string the scale does not know
    // fails the write rather than silently landing an ungradeable climb. Null for
    // every other board: their grade comes from ticks or the Aurora sync.
    // Decided inside the transaction, under the wall lock — see
    // `sprayWallMayAnnounceUnderLock`. Seeded from the pre-transaction read so a
    // draft (which never reaches the transaction's spray branch) still has a value.
    let sprayMayAnnounce = sprayTarget?.publishesFeedEvents ?? false;

    const sprayDifficultyId = sprayTarget ? await resolveDifficultyId(boardType, validated.userGrade) : null;
    if (sprayTarget && !validated.isDraft && sprayDifficultyId === null) {
      throw new GraphQLError(`"${validated.userGrade}" is not a grade on the Boardsesh scale`, {
        extensions: { code: SPRAY_CLIMB_CODES.gradeRequired },
      });
    }

    // Atomicity envelope: gate-check, insert, holds seed, and stats seed all
    // run inside one transaction so a half-completed publish can never leave
    // the row visible to search without its supporting holds/stats. The
    // advisory lock taken at the top of the transaction serializes concurrent
    // publishes of the same hold signature, eliminating the gate's TOCTOU
    // race (two callers reading "no match" simultaneously and both writing).
    // Lock is no-op for drafts / multi-frame climbs since the gate doesn't
    // fire there anyway.
    const shouldGate = !validated.isDraft && framesCount === 1;
    const gateSignature = shouldGate ? buildHoldSignature(holdEntries) : '';
    // Derived from what will be STORED, not from the input, so it matches the
    // signature the gate query computes over the rows it reads.
    const gateRuleSignature = buildStoredRuleSignature(boardType, storedCharacteristics, storedDescription);
    const gateSizeId = woodsShape?.sizeId;
    await db.transaction(async (tx) => {
      if (shouldGate) {
        await acquireDuplicateGateLock(tx, boardType, validated.layoutId, gateSignature, {
          ruleSignature: gateRuleSignature,
          sizeId: gateSizeId,
        });
        const existing = await findExactDuplicateMatch({
          boardType,
          layoutId: validated.layoutId,
          signature: gateSignature,
          ruleSignature: gateRuleSignature,
          sizeId: gateSizeId,
          executor: tx,
        });
        if (existing) {
          throw new GraphQLError(buildDuplicateClimbErrorMessage(existing.name), {
            extensions: {
              code: CLIMB_DUPLICATE_ERROR_CODE,
              existingClimbUuid: existing.uuid,
              existingClimbName: existing.name,
            },
          });
        }
      }

      // Inside the transaction so the check and the insert see one snapshot: a
      // reset committing between them would otherwise let a climb through on a
      // hold that had just come off the wall.
      if (sprayTarget) {
        await assertSprayHoldsAreAlive(
          tx,
          sprayTarget,
          holdEntries.map((entry) => entry.holdId),
        );
        // Re-read visibility UNDER THE LOCK — see the helper. The pre-transaction
        // value would let a concurrent public → private flip slip past: its
        // `feed_items` purge runs before this emit, so the row we write afterwards
        // would survive it.
        sprayMayAnnounce = await sprayWallMayAnnounceUnderLock(tx, sprayTarget.wallId);
      }

      await tx.insert(UNIFIED_TABLES.climbs).values({
        boardType: validated.boardType,
        uuid,
        layoutId: validated.layoutId,
        userId: ctx.userId!,
        setterId: null,
        setterUsername: preferredSetter,
        name: validated.name,
        description: storedDescription,
        angle: validated.angle,
        framesCount,
        framesPace: validated.framesPace ?? 0,
        frames: validated.frames,
        isDraft: validated.isDraft,
        isListed,
        createdAt: now,
        publishedAt,
        // Woods climbs are Boardsesh-only: there is no Aurora account to push
        // them to, so `synced: false` would park them in a pending-sync state
        // forever. Every other board still owes Aurora a round-trip.
        synced: !!woodsShape,
        syncError: null,
        characteristics: storedCharacteristics,
        // Woods' denormalised columns can't be re-derived downstream —
        // populateDenormalizedColumns bails out for the board precisely because
        // there are no placements or product sizes behind it — so they are
        // authoritative at write time. The empty required-set array is the honest
        // answer for a board with one synthetic set (`{} <@ anything` is true),
        // and NULL would read as "not backfilled" and drop the row from any
        // set-filtered search.
        ...(woodsShape
          ? {
              compatibleSizeIds: [woodsShape.sizeId],
              requiredSetIds: [...WOODS_AUTHORED_REQUIRED_SET_IDS],
              holdFingerprint: fingerprintFromHolds(holdEntries),
            }
          : {}),
        // Spray, for the same reason as Woods: the values are authoritative at
        // write time. `compatible_size_ids` is the wall's own size and nothing
        // else, `required_set_ids` is the one synthetic "Holds" set, and the
        // fingerprint is written HERE because a wall has no Aurora sync to come
        // back and fill it in — without it the per-wall duplicate gate has
        // nothing to key on. `missing_hold_count` starts at 0, not NULL:
        // `assertSprayHoldsAreAlive` ran a few lines above, inside this same
        // transaction and under the wall lock, and refused every hold that is not
        // on the published generation — so a climb cannot be born broken. A reset
        // is what moves the number, and an edit that changes the frames re-derives
        // it (`recomputeMissingHoldCountForClimb`).
        ...(sprayTarget
          ? {
              compatibleSizeIds: sprayTarget.compatibleSizeIds,
              requiredSetIds: sprayTarget.requiredSetIds,
              holdFingerprint: fingerprintFromHolds(holdEntries),
              missingHoldCount: 0,
            }
          : {}),
      });

      // Aurora's sync-back round-trip eventually populates board_climb_holds for
      // these climbs (via aurora-board-import-helpers), but the latency is
      // open-ended. Seed the rows ourselves so the next call's duplicate gate
      // can see this climb immediately. Aurora's later re-import is idempotent
      // via onConflictDoNothing on the PK (board_type, climb_uuid, hold_id).
      if (holdEntries.length > 0) {
        await tx
          .insert(dbSchema.boardClimbHolds)
          .values(
            holdEntries.map((entry) => ({
              boardType: validated.boardType,
              climbUuid: uuid,
              holdId: entry.holdId,
              frameNumber: entry.frameNumber,
              holdState: entry.holdState,
            })),
          )
          .onConflictDoNothing();
      }

      // The remix link, written with the child rather than after it: a lineage row
      // is the only record of where a remix came from, and a climb that landed
      // without it would look like an original forever.
      if (sprayTarget && validated.remixOfClimbUuid) {
        await recordRemixLineage(tx, sprayTarget, uuid, validated.remixOfClimbUuid);
      }

      // Derive the denormalised columns, then re-assert the spray ones — see
      // `populateSprayClimbColumns` for the INVARIANT and why the order matters.
      await populateSprayClimbColumns(tx, validated.boardType, uuid, sprayTarget);

      // Stats rows used to come exclusively from the Aurora sync pipeline, so
      // Boardsesh-originated climbs had none. The hot search path INNER JOINs
      // board_climb_stats (search-climbs.ts:statsDrivenSearch), which hid these
      // climbs from search until someone synced them. Seed a row at the chosen
      // angle so the climb is discoverable immediately.
      //
      // Skip drafts: search uses LEFT JOIN for drafts and a stats row there would
      // expose the climb to the listed/INNER-JOIN path the moment is_listed flips,
      // before any other write occurs. Matches migration 0096 Step 1, which only
      // backfills rows where is_draft = FALSE, and updateClimb (below) which seeds
      // on draft → publish transition.
      // Spray seeds the SETTER'S grade into the stats row, because there is no
      // other place a spray climb's grade can live: the board has
      // `crowdGrade: false`, so nothing will ever converge on a consensus
      // difficulty, and `board_climb_stats` is the only table the grade-display
      // path reads. Drafts get the row too when a grade is present — exactly the
      // MoonBoard reasoning: `updateClimb`'s publish-time seed has no grade
      // source to reconstruct from, so skipping it here would lose the grade
      // through draft → publish. Search still filters drafts out by
      // `is_draft = false`, so the row is not search-visible early.
      if (sprayTarget && sprayDifficultyId !== null) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: uuid,
            angle: validated.angle,
            displayDifficulty: sprayDifficultyId,
            difficultyAverage: sprayDifficultyId,
            ascensionistCount: 0,
            faUsername: preferredSetter,
          })
          .onConflictDoNothing({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
          });
      } else if (!validated.isDraft) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: uuid,
            angle: validated.angle,
            ascensionistCount: 0,
            faUsername: preferredSetter,
          })
          .onConflictDoNothing({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
          });
      }
    });

    // A feed event carries the climb's name and its wall's layout id to every
    // follower, so firing one for a PRIVATE wall would announce the existence of
    // somebody's home wall to people who cannot open it. Public walls only
    // (epic decision 2026-09-14: private-wall ticks are the owner's logbook).
    const mayAnnounce = !sprayTarget || sprayMayAnnounce;
    if (!validated.isDraft && mayAnnounce) {
      await publishSocialEvent({
        type: 'climb.created',
        actorId: ctx.userId!,
        entityType: 'climb',
        entityId: uuid,
        timestamp: Date.now(),
        metadata: {
          boardType: validated.boardType,
          layoutId: String(validated.layoutId),
          climbName: validated.name,
          climbUuid: uuid,
          angle: String(validated.angle),
          frames: validated.frames,
          setterUsername: preferredSetter || '',
          setterDisplayName: preferredSetter || '',
          setterAvatarUrl: avatarUrl || '',
          // The setter's own grade, which on a spray wall is the ONLY grade the
          // climb will ever have — so a follower's feed row would otherwise show
          // an ungraded climb forever.
          difficultyName: validated.userGrade || '',
        },
      });
    }

    // Mirrors the column: a Woods climb has nowhere to sync to and is already
    // final, so the client shouldn't show it as pending.
    return { uuid, synced: !!woodsShape, createdAt: now, publishedAt };
  },

  /**
   * Save a new MoonBoard climb via GraphQL.
   * Encodes holds to frames, optionally stores grade stats, and publishes climb.created.
   */
  saveMoonBoardClimb: async (
    _: unknown,
    { input }: SaveClimbArgs,
    ctx: ConnectionContext,
  ): Promise<SaveClimbResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'saveMoonBoardClimb');

    const validated = validateInput(SaveMoonBoardClimbInputSchema, input, 'input');
    const isDraft = validated.isDraft ?? false;
    const isListed = !isDraft;

    if (validated.boardType !== 'moonboard') {
      throw new Error('saveMoonBoardClimb is only supported for boardType=moonboard');
    }

    // Benchmarks are a trusted, community-wide signal — only admins and
    // community leaders can flag one at creation. (Changing benchmark status
    // afterwards goes through the community proposals system.) Gate before any
    // work so a non-privileged request is rejected cleanly.
    if (validated.isBenchmark) {
      await requireAdminOrLeader(ctx, 'moonboard');
    }

    // MoonBoard "method" (footless / footless+kickboard / no-kickboard) is stored
    // as a structured characteristic; the default "feet follow hands" is no token.
    const characteristics = validated.method ? withCharacteristic(null, validated.method, true) : null;

    const uuid = generateClimbUuid();
    const now = new Date().toISOString();
    const publishedAt = isDraft ? null : now;
    const { displayName, name, avatarUrl } = await getUserProfile(ctx.userId!);
    const preferredSetter = validated.setter || displayName || name || null;

    // The legacy MoonBoard-specific lookup also covers climbs that have no
    // rows in board_climb_holds and live only as a `frames` text blob (Aurora
    // imports from before the holds table was the authoritative store), so
    // keep it as the gate for this board. Wrap the result in a GraphQLError
    // with the unified CLIMB_IS_DUPLICATE extension so the frontend's
    // duplicate-UX handler can react the same way across boards.
    if (!isDraft) {
      const duplicateMatch = await findMoonBoardDuplicateMatch(validated.layoutId, validated.angle, validated.holds);
      if (duplicateMatch) {
        throw new GraphQLError(buildMoonBoardDuplicateError(duplicateMatch.existingClimbName), {
          extensions: {
            code: CLIMB_DUPLICATE_ERROR_CODE,
            existingClimbUuid: duplicateMatch.existingClimbUuid,
            existingClimbName: duplicateMatch.existingClimbName,
          },
        });
      }
    }

    const frames = encodeMoonBoardHoldsToFrames(validated.holds);

    await db.insert(UNIFIED_TABLES.climbs).values({
      boardType: validated.boardType,
      uuid,
      layoutId: validated.layoutId,
      userId: ctx.userId!,
      setterId: null,
      setterUsername: preferredSetter,
      name: validated.name,
      description: validated.description ?? '',
      angle: validated.angle,
      framesCount: 1,
      framesPace: 0,
      frames,
      isDraft,
      isListed,
      createdAt: now,
      publishedAt,
      synced: false,
      syncError: null,
      characteristics,
    });

    const holdRows = buildMoonBoardClimbHoldRows(uuid, validated.holds);
    if (holdRows.length > 0) {
      await db.insert(dbSchema.boardClimbHolds).values(holdRows).onConflictDoNothing();
    }

    // Seed a stats row so the climb is visible to the global search, which
    // uses an INNER JOIN against board_climb_stats.
    //
    // Drafts: search already filters by `is_draft = false` (create-climb-filters
    // baseConditions), so a stats row on a draft is not directly search-visible.
    // The seed is still important when the user supplied a grade — board_climb_stats
    // is the only place we persist the resolved difficulty, and skipping the row
    // would lose the grade through draft → publish (updateClimb's stats seed has
    // no grade source to reconstruct it from). So:
    //   - draft + grade  → seed the row (preserves grade; search filter masks the draft)
    //   - draft + no grade → skip the seed (matches saveClimb's gate; updateClimb
    //                        will create a barebones row at publish time)
    //   - non-draft + grade → seed with grade (current behaviour)
    //   - non-draft + no grade → seed barebones (current behaviour)
    // The uuid is freshly generated per call, so the inserts can never conflict —
    // both branches use `onConflictDoNothing` for consistency with saveClimb.
    const difficultyId = await resolveDifficultyId(validated.boardType, validated.userGrade);
    if (difficultyId !== null) {
      await db
        .insert(dbSchema.boardClimbStats)
        .values({
          boardType: validated.boardType,
          climbUuid: uuid,
          angle: validated.angle,
          displayDifficulty: difficultyId,
          benchmarkDifficulty: validated.isBenchmark ? difficultyId : null,
          ascensionistCount: 0,
          difficultyAverage: difficultyId,
          qualityAverage: null,
          faUsername: validated.setter || null,
          faAt: null,
        })
        .onConflictDoNothing({
          target: [
            dbSchema.boardClimbStats.boardType,
            dbSchema.boardClimbStats.climbUuid,
            dbSchema.boardClimbStats.angle,
          ],
        });
    } else if (!isDraft) {
      await db
        .insert(dbSchema.boardClimbStats)
        .values({
          boardType: validated.boardType,
          climbUuid: uuid,
          angle: validated.angle,
          ascensionistCount: 0,
          faUsername: validated.setter || null,
        })
        .onConflictDoNothing({
          target: [
            dbSchema.boardClimbStats.boardType,
            dbSchema.boardClimbStats.climbUuid,
            dbSchema.boardClimbStats.angle,
          ],
        });
    }

    if (!isDraft) {
      await publishSocialEvent({
        type: 'climb.created',
        actorId: ctx.userId!,
        entityType: 'climb',
        entityId: uuid,
        timestamp: Date.now(),
        metadata: {
          boardType: validated.boardType,
          layoutId: String(validated.layoutId),
          climbName: validated.name,
          climbUuid: uuid,
          angle: String(validated.angle),
          frames,
          setterUsername: preferredSetter || '',
          setterDisplayName: preferredSetter || '',
          setterAvatarUrl: avatarUrl || '',
          difficultyName: validated.userGrade || '',
        },
      });
    }

    return { uuid, synced: false, createdAt: now, publishedAt };
  },

  /**
   * Update an existing climb in-place. Enforces ownership and a 24h edit
   * window on published climbs. Drafts can be edited indefinitely.
   *
   * A climb can transition from draft → published via `isDraft: false` —
   * that sets `publishedAt` to now and starts the 24h clock. The reverse
   * transition is not allowed (can't un-publish).
   */
  updateClimb: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<UpdateClimbResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'updateClimb');

    const validated = validateInput(UpdateClimbInputSchema, input, 'input');

    if (!isValidBoardName(validated.boardType)) {
      throw new Error(
        `Invalid board type: ${String(validated.boardType)}. Must be one of ${SUPPORTED_BOARDS.join(', ')}`,
      );
    }
    const boardType = validated.boardType as BoardName;

    // Load the existing row and verify ownership + edit window.
    const [existing] = await db
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        userId: dbSchema.boardClimbs.userId,
        isDraft: dbSchema.boardClimbs.isDraft,
        publishedAt: dbSchema.boardClimbs.publishedAt,
        createdAt: dbSchema.boardClimbs.createdAt,
        angle: dbSchema.boardClimbs.angle,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        framesCount: dbSchema.boardClimbs.framesCount,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        characteristics: dbSchema.boardClimbs.characteristics,
        // Needed to reproduce the rule signature the gate query computes over
        // this row: a legacy climb whose no_match lives only in the "No match"
        // description prefix still counts as a no-match climb.
        description: dbSchema.boardClimbs.description,
        // The Woods board size. Immutable, and the only record of which of the
        // two walls the climb's hold ids belong to.
        compatibleSizeIds: dbSchema.boardClimbs.compatibleSizeIds,
      })
      .from(dbSchema.boardClimbs)
      .where(
        and(eq(dbSchema.boardClimbs.uuid, validated.uuid), eq(dbSchema.boardClimbs.boardType, validated.boardType)),
      )
      .limit(1);

    if (!existing) {
      throw new Error('Climb not found');
    }

    if (existing.userId !== ctx.userId!) {
      throw new Error('You can only update your own climbs');
    }

    const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
    const currentlyDraft = existing.isDraft === true;

    if (!currentlyDraft) {
      // Non-draft: only editable within 24h of the first publish.
      if (!existing.publishedAt) {
        throw new Error('This climb can no longer be edited');
      }
      const publishedMs = Date.parse(existing.publishedAt);
      if (!Number.isFinite(publishedMs) || Date.now() - publishedMs > EDIT_WINDOW_MS) {
        throw new Error('The 24 hour edit window has expired');
      }
    }

    // Decide the next draft/publish state. We only honor a transition from
    // draft → published; a publish → draft attempt is silently ignored.
    let nextIsDraft: boolean;
    if (validated.isDraft === undefined) {
      nextIsDraft = existing.isDraft ?? false;
    } else if (currentlyDraft && validated.isDraft === false) {
      nextIsDraft = false;
    } else {
      nextIsDraft = existing.isDraft ?? false;
    }

    const transitioningToPublished = currentlyDraft && validated.isDraft === false;

    // Spray: the same view-access resolve `saveClimb` does. It has to run even on
    // a metadata-only edit — the wall may have been deleted since the climb was
    // set, and an edit to a climb on a wall the caller can no longer see is not an
    // edit they should be making.
    const sprayTarget: SprayClimbTarget | null = isSprayBoard(boardType)
      ? await requireVisibleSprayWall(existing.layoutId, ctx.userId!, validated.sprayWallUuid)
      : null;

    const now = new Date().toISOString();
    const nextPublishedAt = transitioningToPublished ? now : existing.publishedAt;

    // Decide whether this update needs to seed a board_climb_stats row at the
    // climb's resolved angle, and validate the angle up front. Doing this
    // BEFORE the board_climbs UPDATE means a malformed-publish attempt fails
    // cleanly — without it, we'd flip isDraft=false / publishedAt=now and
    // then throw, leaving a published climb with no stats row (exactly the
    // broken state this PR is fixing).
    const resolvedAngle = validated.angle ?? existing.angle;
    const angleChanged = validated.angle !== undefined && validated.angle !== existing.angle;
    const shouldSeedStats = !nextIsDraft && (transitioningToPublished || angleChanged);
    if (shouldSeedStats && resolvedAngle === null) {
      // board_climbs.angle is nullable in the schema but board_climb_stats.angle
      // is NOT NULL. angleChanged can't reach this — validated.angle would be
      // set; this only fires on publish of a draft created without an angle.
      throw new Error('Cannot publish climb without an angle');
    }

    // Decided inside the transaction, under the wall lock — see `saveClimb`.
    let sprayMayAnnounce = sprayTarget?.publishesFeedEvents ?? false;

    // A wall's angle is fixed, so an edit may not move a climb off it either.
    if (sprayTarget && validated.angle !== undefined) {
      assertSprayAngleMatchesWall(sprayTarget, validated.angle);
    }

    // Publishing a spray climb needs a grade, and it may come from EITHER side: the
    // stats row `saveClimb` seeded when the draft carried a grade, or `userGrade`
    // on this call for a draft that did not. Accepting only the stored row is what
    // made an ungraded draft unpublishable forever — `saveClimb` lets a draft
    // through without a grade on purpose, because the grade is the last thing a
    // setter decides.
    let sprayGradeToSeed: number | null = null;
    if (sprayTarget && transitioningToPublished) {
      const [gradedStats] = await db
        .select({ displayDifficulty: dbSchema.boardClimbStats.displayDifficulty })
        .from(dbSchema.boardClimbStats)
        .where(
          and(
            eq(dbSchema.boardClimbStats.boardType, validated.boardType),
            eq(dbSchema.boardClimbStats.climbUuid, validated.uuid),
            eq(dbSchema.boardClimbStats.angle, resolvedAngle!),
          ),
        )
        .limit(1);

      if (gradedStats?.displayDifficulty == null) {
        assertSprayGradeOnPublish(false, validated.userGrade);
        sprayGradeToSeed = await resolveDifficultyId(boardType, validated.userGrade);
        if (sprayGradeToSeed === null) {
          throw new GraphQLError(`"${validated.userGrade}" is not a grade on the Boardsesh scale`, {
            extensions: { code: SPRAY_CLIMB_CODES.gradeRequired },
          });
        }
      }
    }

    // A grade EDIT, as opposed to the publish transition above.
    //
    // `saveClimb` seeds the setter's grade and the transition re-seeds it, but
    // neither covers what the editor's picker actually offers most of the time:
    // reopening a climb inside the edit window and moving the grade. Without this
    // the mutation returned success, the client showed a "published" toast and
    // updated its saved baseline, and the stats row kept the old grade — the
    // climb re-read as whatever it was graded the first time.
    //
    // No extra authorization: `updateClimb` has already refused anyone but
    // `existing.userId`, and on a spray wall the owner of the climb IS its setter.
    if (sprayTarget && sprayGradeToSeed === null && validated.userGrade != null) {
      sprayGradeToSeed = await resolveDifficultyId(boardType, validated.userGrade);
      if (sprayGradeToSeed === null) {
        throw new GraphQLError(`"${validated.userGrade}" is not a grade on the Boardsesh scale`, {
          extensions: { code: SPRAY_CLIMB_CODES.gradeRequired },
        });
      }
    }

    // Atomicity envelope: the gate check, the UPDATE on board_climbs, the
    // denorm column refresh, the holds DELETE+INSERT, and the stats seed all
    // run inside one transaction. Without this a partial failure mid-sequence
    // could leave the row published with stale board_climb_holds (a real
    // data-integrity bug — the search hot path joins against the holds table
    // for filtering, so out-of-sync rows surface as silently-wrong results).
    //
    // The advisory lock taken before the gate read serializes concurrent
    // publishes of the same hold signature so the gate's TOCTOU race
    // disappears: two simultaneous draft→publish attempts whose holds collide
    // now line up behind the lock, and whichever lands second sees the first
    // through the gate and throws cleanly. Multi-frame climbs and pure
    // metadata edits don't take the lock (the gate doesn't fire for them).
    const framesChanged = validated.frames !== undefined && validated.frames !== existing.frames;
    const nextFrames = validated.frames ?? existing.frames ?? '';
    const nextFramesCount = validated.framesCount ?? existing.framesCount ?? 1;
    const nextHoldEntries = parseFramesToHoldEntries(boardType, nextFrames);

    // An edit may not turn a single-frame wall climb into a sequence — same reason
    // as the create path. Placed here because it needs the post-edit shape.
    if (sprayTarget) {
      assertSprayClimbIsSingleFrame(nextFramesCount, nextFrames);
    }

    // Woods: the board size is fixed at creation and is what makes the hold ids
    // mean anything, so it comes from the row rather than the request. Re-run the
    // full rule set over the post-update shape — an edit can add a hold that
    // doesn't exist on this wall, drop the last start hold, or publish a draft
    // that never had a finish. Runs BEFORE the UPDATE for the same reason the
    // angle check does: a rejected edit must leave the row untouched.
    const woodsSizeId = isWoodsBoard(boardType)
      ? resolveWoodsUpdateSizeId({
          storedSizeId: storedWoodsSizeId(existing.compatibleSizeIds),
          requestedSizeId: validated.sizeId,
        })
      : undefined;
    if (woodsSizeId !== undefined) {
      validateWoodsClimb({
        layoutId: existing.layoutId,
        sizeId: woodsSizeId,
        angle: resolvedAngle,
        frames: nextFrames,
        framesCount: nextFramesCount,
        framesPace: validated.framesPace,
        isDraft: nextIsDraft,
      });
    }

    // Build the row's next rule set before the transaction: rules are half the
    // duplicate key, so a rule-only edit has to re-run the gate, and the gate
    // needs the values this update is about to store.
    //
    // Seeded from the row's EFFECTIVE rules (the stored array, or the legacy
    // description-derived no_match when there is no array yet) so writing an
    // explicit array for the first time carries the legacy flag forward instead
    // of quietly dropping it.
    let nextCharacteristics =
      existing.characteristics != null
        ? [...existing.characteristics]
        : usesAuroraNoMatchDescription(boardType) && isNoMatchClimb(existing.description)
          ? [CLIMB_CHARACTERISTICS.NO_MATCH as string]
          : [];
    let characteristicsChanged = false;
    let nextDescription = existing.description ?? '';

    if (validated.description !== undefined) {
      // Derive no_match from the raw incoming description (may still carry the
      // Aurora "No match\n" prefix), then strip the prefix from the stored value
      // so characteristics is the sole source of truth going forward.
      nextDescription = usesAuroraNoMatchDescription(boardType)
        ? withNoMatch(validated.description, false)
        : validated.description;
      // no_match is an Aurora-family concept — never derive it for the
      // code-driven boards, where a description starting with "no match" is just
      // user prose and would otherwise clobber the climb's other tokens.
      if (usesAuroraNoMatchDescription(boardType)) {
        nextCharacteristics = withCharacteristic(
          nextCharacteristics,
          CLIMB_CHARACTERISTICS.NO_MATCH,
          isNoMatchClimb(validated.description),
        );
        characteristicsChanged = true;
      }
    }

    // Explicit flags win over the description derivation above, and null/omitted
    // preserves whatever the row already says — that third state is what stops an
    // old client, which sends neither field, from clearing a rule it has never
    // heard of.
    if (validated.noMatch != null) {
      nextCharacteristics = withCharacteristic(nextCharacteristics, CLIMB_CHARACTERISTICS.NO_MATCH, validated.noMatch);
      characteristicsChanged = true;
    }
    if (validated.anyFeet != null) {
      nextCharacteristics = withCharacteristic(nextCharacteristics, CLIMB_CHARACTERISTICS.ANY_FEET, validated.anyFeet);
      characteristicsChanged = true;
    }
    if (validated.characteristics !== undefined) {
      // Client sends the full desired boolean state of each freely-toggleable
      // token; anything else already on the row (no_match, any_feet, MoonBoard
      // method) is left alone. `null` (both toggles off) is equivalent to `[]`
      // here — the field is nullable because clients send explicit null, not
      // omission, when nothing is toggled on.
      const desiredCharacteristics = validated.characteristics ?? [];
      for (const token of TOGGLEABLE_CLIMB_CHARACTERISTICS) {
        nextCharacteristics = withCharacteristic(nextCharacteristics, token, desiredCharacteristics.includes(token));
      }
      characteristicsChanged = true;
    }

    if (characteristicsChanged) {
      const conflict = findCharacteristicConflict(nextCharacteristics);
      if (conflict) {
        throw new GraphQLError(`"${conflict.token}" cannot be combined with "${conflict.conflictsWith}"`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
    }

    // Woods persists `[]` where other boards persist NULL — see saveClimb.
    const storedCharacteristics =
      woodsSizeId !== undefined ||
      nextCharacteristics.length > 0 ||
      (usesAuroraNoMatchDescription(boardType) && isNoMatchClimb(nextDescription))
        ? nextCharacteristics
        : null;

    // Both signatures are read off the row as it is and as it will be, not off
    // the request: the gate query computes its side from the stored columns, so
    // anything this update doesn't actually write has to be taken from `existing`
    // or the two sides drift apart on the edits that touch neither field.
    const previousRuleSignature = buildStoredRuleSignature(boardType, existing.characteristics, existing.description);
    const nextRuleSignature = buildStoredRuleSignature(
      boardType,
      characteristicsChanged ? storedCharacteristics : existing.characteristics,
      validated.description !== undefined ? nextDescription : existing.description,
    );
    const rulesChanged = nextRuleSignature !== previousRuleSignature;

    // A rule-only edit is a real fork of the climb's identity, so it has to face
    // the gate too: flipping "no match" on can land the climb straight on top of
    // an existing no-match version of the same holds.
    const shouldGate =
      !nextIsDraft && (transitioningToPublished || framesChanged || rulesChanged) && nextFramesCount === 1;
    const gateSignature = shouldGate ? buildHoldSignature(nextHoldEntries) : '';

    await db.transaction(async (tx) => {
      if (shouldGate) {
        await acquireDuplicateGateLock(tx, boardType, existing.layoutId, gateSignature, {
          ruleSignature: nextRuleSignature,
          sizeId: woodsSizeId,
        });
        const existingMatch = await findExactDuplicateMatch({
          boardType,
          layoutId: existing.layoutId,
          signature: gateSignature,
          ruleSignature: nextRuleSignature,
          sizeId: woodsSizeId,
          excludeUuid: validated.uuid,
          executor: tx,
        });
        if (existingMatch) {
          throw new GraphQLError(buildDuplicateClimbErrorMessage(existingMatch.name), {
            extensions: {
              code: CLIMB_DUPLICATE_ERROR_CODE,
              existingClimbUuid: existingMatch.uuid,
              existingClimbName: existingMatch.name,
            },
          });
        }
      }

      // The same snapshot argument as `saveClimb`: inside the transaction, ahead
      // of the write, so a reset committing mid-edit cannot leave the climb
      // pointing at a hold that has come off the wall. Checked on every spray
      // edit, not only a frames change — a metadata-only edit of a climb whose
      // holds went away should not be the thing that quietly re-publishes it.
      if (sprayTarget) {
        await assertSprayHoldsAreAlive(
          tx,
          sprayTarget,
          nextHoldEntries.map((entry) => entry.holdId),
        );
        // Under the lock — same reason as `saveClimb`.
        sprayMayAnnounce = await sprayWallMayAnnounceUnderLock(tx, sprayTarget.wallId);
      }

      // Build the update set from provided fields only.
      const updateSet: Record<string, unknown> = {
        isDraft: nextIsDraft,
        isListed: !nextIsDraft,
        publishedAt: nextPublishedAt,
      };
      if (validated.name !== undefined) updateSet.name = validated.name;
      // The description and the rule array were both resolved above, before the
      // transaction, so the gate could key on them. Write them only when this
      // call actually touched them — a metadata-only edit must not rewrite the
      // characteristics column (and, on MoonBoard, must not disturb the method
      // token it never asked about).
      if (validated.description !== undefined) updateSet.description = nextDescription;
      if (characteristicsChanged) updateSet.characteristics = storedCharacteristics;
      if (validated.frames !== undefined) updateSet.frames = validated.frames;
      if (validated.angle !== undefined) updateSet.angle = validated.angle;
      if (validated.framesCount !== undefined) updateSet.framesCount = validated.framesCount;
      if (validated.framesPace !== undefined) updateSet.framesPace = validated.framesPace;
      // Woods writes its own hold fingerprint (nothing downstream can re-derive
      // it for that board), so an edit that moves the holds has to move it too or
      // it describes the climb the user replaced. Other boards get theirs from
      // the Aurora sync and are left alone here.
      if (woodsSizeId !== undefined && framesChanged) {
        updateSet.holdFingerprint = fingerprintFromHolds(nextHoldEntries);
      }
      // Spray, same reason: nothing downstream can re-derive a wall climb's
      // fingerprint (there is no Aurora sync to come back for it), so an edit that
      // moves the holds has to move the fingerprint too or it describes the climb
      // the user replaced.
      if (sprayTarget && framesChanged) {
        updateSet.holdFingerprint = fingerprintFromHolds(nextHoldEntries);
      }

      await tx
        .update(dbSchema.boardClimbs)
        .set(updateSet)
        .where(
          and(eq(dbSchema.boardClimbs.uuid, validated.uuid), eq(dbSchema.boardClimbs.boardType, validated.boardType)),
        );

      // If frames changed we need to refresh the denormalized edge/set columns
      // so search filters still match, and resync board_climb_holds (which the
      // duplicate gate and similarity queries read from).
      if (validated.frames !== undefined) {
        // See `populateSprayClimbColumns` — same INVARIANT as the create path.
        await populateSprayClimbColumns(tx, validated.boardType, validated.uuid, sprayTarget);

        if (framesChanged) {
          const refreshedHolds = nextHoldEntries;
          await tx
            .delete(dbSchema.boardClimbHolds)
            .where(
              and(
                eq(dbSchema.boardClimbHolds.boardType, validated.boardType),
                eq(dbSchema.boardClimbHolds.climbUuid, validated.uuid),
              ),
            );
          if (refreshedHolds.length > 0) {
            await tx
              .insert(dbSchema.boardClimbHolds)
              .values(
                refreshedHolds.map((entry) => ({
                  boardType: validated.boardType,
                  climbUuid: validated.uuid,
                  holdId: entry.holdId,
                  frameNumber: entry.frameNumber,
                  holdState: entry.holdState,
                })),
              )
              .onConflictDoNothing();
          }

          // The climb just moved under the wall, so its integrity number now
          // describes holds it no longer uses. A climber whose problem lost two
          // holds and who edited it onto two that are still there has fixed it —
          // but nothing else would ever say so: the wall-wide recompute only runs
          // when a reset lands, so until somebody reset that wall again the climb
          // would sit in BROKEN searches wearing a badge for a problem its setter
          // had already dealt with.
          //
          // Inside the same transaction as the hold rewrite it answers, and after
          // it, so the count is read off the rows this edit just wrote. The wall
          // lock is already held: `assertSprayHoldsAreAlive` took it above, before
          // it resolved the published generation these holds were validated
          // against, and `pg_advisory_xact_lock` holds to commit.
          if (sprayTarget) {
            await recomputeMissingHoldCountForClimb(tx, sprayTarget.wallId, validated.uuid);
          }
        }
      }

      // The search hot path INNER JOINs board_climb_stats by (boardType, climbUuid, angle).
      // Make sure a row exists at the resolved angle whenever the climb is, or just became,
      // searchable. The old row at the previous angle is left in place — it's harmless
      // because search filters by exact angle, and removing it would race with concurrent ticks.
      // The combined check also re-narrows `resolvedAngle` to non-null for TS — we threw
      // above on (shouldSeedStats && null) so the second clause is the only path through.
      // The grade this call supplied — either the one the publish needs, or a
      // plain grade edit. `onConflictDoUpdate` rather than `DoNothing`: a draft
      // created without a grade may already HAVE a barebones stats row (a previous
      // angle edit seeds one), and leaving it ungraded would publish a spray climb
      // with no grade after the check above said there was one. The same update is
      // what lets a setter MOVE the grade of a climb that already has stats.
      if (sprayGradeToSeed !== null && resolvedAngle !== null) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: validated.uuid,
            angle: resolvedAngle,
            displayDifficulty: sprayGradeToSeed,
            difficultyAverage: sprayGradeToSeed,
            ascensionistCount: 0,
            faUsername: existing.setterUsername,
          })
          .onConflictDoUpdate({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
            set: { displayDifficulty: sprayGradeToSeed, difficultyAverage: sprayGradeToSeed },
          });
      } else if (shouldSeedStats && resolvedAngle !== null) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: validated.uuid,
            angle: resolvedAngle,
            ascensionistCount: 0,
            faUsername: existing.setterUsername,
          })
          .onConflictDoNothing({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
          });
      }
    });

    // Tell the web app to drop the cached climb-view render so the edit
    // shows up immediately instead of waiting for the 1h TTL.
    void notifyClimbRevalidated(validated.uuid);

    // On a draft → published transition, announce the new climb so follower
    // feeds pick it up, the same way saveClimb does.
    // Public walls only — see the note on `saveClimb`'s event.
    if (transitioningToPublished && (!sprayTarget || sprayMayAnnounce)) {
      const { displayName, name, avatarUrl } = await getUserProfile(ctx.userId);
      const preferredSetter = displayName || name || null;
      await publishSocialEvent({
        type: 'climb.created',
        actorId: ctx.userId,
        entityType: 'climb',
        entityId: validated.uuid,
        timestamp: Date.now(),
        metadata: {
          boardType: validated.boardType,
          // existing.layoutId came from the SELECT extended in this PR for
          // the duplicate gate. Use it so follower feeds get the layout
          // context — the empty-string placeholder was a leftover from
          // before that column was selectable here.
          layoutId: existing.layoutId != null ? String(existing.layoutId) : '',
          climbName: validated.name ?? '',
          climbUuid: validated.uuid,
          angle: validated.angle !== undefined ? String(validated.angle) : '',
          frames: validated.frames ?? '',
          setterUsername: existing.setterUsername ?? preferredSetter ?? '',
          setterDisplayName: preferredSetter || '',
          setterAvatarUrl: avatarUrl || '',
        },
      });
    }

    return {
      uuid: validated.uuid,
      createdAt: existing.createdAt,
      publishedAt: nextPublishedAt,
      isDraft: nextIsDraft,
    };
  },

  /**
   * Delete an unpublished draft climb owned by the current user. This path is
   * intentionally narrower than account deletion: published climbs are never
   * removed here, even if the caller owns them.
   */
  deleteDraftClimb: async (
    _: unknown,
    { uuid, boardType }: DeleteDraftClimbArgs,
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'deleteDraftClimb');

    const validatedUuid = validateInput(ExternalUUIDSchema, uuid, 'uuid');
    const validatedBoardType = validateInput(BoardNameSchema, boardType, 'boardType');

    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          uuid: dbSchema.boardClimbs.uuid,
          userId: dbSchema.boardClimbs.userId,
          isDraft: dbSchema.boardClimbs.isDraft,
        })
        .from(dbSchema.boardClimbs)
        .where(
          and(eq(dbSchema.boardClimbs.uuid, validatedUuid), eq(dbSchema.boardClimbs.boardType, validatedBoardType)),
        )
        .limit(1);

      if (!existing) {
        throw new Error('Climb not found');
      }

      if (existing.userId !== ctx.userId!) {
        throw new Error('You can only delete your own draft climbs');
      }

      if (existing.isDraft !== true) {
        throw new Error('Published climbs cannot be deleted here');
      }

      // Clear the rows that have no FK back to board_climbs before deleting
      // the climb itself, or they strand as orphans (issue #3943).
      await deleteClimbDependentRows(tx, validatedBoardType, [validatedUuid]);

      const deletedRows = await tx
        .delete(dbSchema.boardClimbs)
        .where(
          and(
            eq(dbSchema.boardClimbs.uuid, validatedUuid),
            eq(dbSchema.boardClimbs.boardType, validatedBoardType),
            eq(dbSchema.boardClimbs.userId, ctx.userId!),
            eq(dbSchema.boardClimbs.isDraft, true),
          ),
        )
        .returning({ uuid: dbSchema.boardClimbs.uuid });

      if (deletedRows.length === 0) {
        throw new Error('Draft climb could not be deleted');
      }
    });

    // Bust the climb-view cache so any prerendered draft page 404s on next hit
    // instead of serving stale content from `unstable_cache`.
    void notifyClimbRevalidated(validatedUuid);

    return true;
  },
};
