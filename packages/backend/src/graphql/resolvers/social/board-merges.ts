import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { boardMergeConfigsCompatible } from '@boardsesh/board-config';
import { mergeSerialCluster, lockBoardSerialWrite, type SerialBoardRow } from '@boardsesh/db/queries';
import * as schema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { enrichBoards } from './boards';
import { rolesGrantAdminOrLeader } from './roles';
import { executeRows } from '@boardsesh/db/client';
import { effectiveBoardAudience } from '../../../services/privacy';
import { publishBoardQueuePreviewTombstoneForBoard } from '../../../services/board-queue-preview';
import { queueBoardStatsPublish } from '../board-presence/stats';
import { logger } from '../../../utils/logger';
import { UUIDSchema } from '../../../validation/schemas/primitives';

type Board = typeof schema.userBoards.$inferSelect;
type Request = typeof schema.boardMergeRequests.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<Transaction, 'select'>;
const selectionSchema = z
  .array(UUIDSchema)
  .min(2)
  .max(20)
  .refine((uuids) => new Set(uuids).size === uuids.length, 'Choose distinct boards');
const requestSchema = z.object({
  boardUuids: selectionSchema,
  canonicalBoardUuid: UUIDSchema,
  reason: z.string().trim().min(10).max(1000),
});
const mergeSchema = requestSchema.extend({ version: z.string().min(1).max(100) });
const resolveSchema = z.object({
  requestUuid: UUIDSchema,
  approve: z.boolean(),
  canonicalBoardUuid: UUIDSchema.optional(),
  version: z.string().max(100).optional(),
  reason: z.string().trim().max(1000).optional(),
});
const pageSchema = z.object({
  gymUuid: UUIDSchema.optional(),
  boardType: z.string().max(30).optional(),
  status: z.enum(['open', 'approved', 'rejected', 'superseded']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
const candidateSchema = z.object({
  boardUuid: UUIDSchema.optional(),
  gymUuid: UUIDSchema.optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
function fail(message: string, code = 'BAD_USER_INPUT'): never {
  throw new GraphQLError(message, { extensions: { code } });
}
const signature = (uuids: string[]) =>
  createHash('sha256')
    .update([...uuids].sort().join(','))
    .digest('hex');
async function loadBoards(uuids: string[], reader: Reader = db): Promise<Board[]> {
  const boards = await reader
    .select()
    .from(schema.userBoards)
    .where(and(inArray(schema.userBoards.uuid, uuids), isNull(schema.userBoards.deletedAt)))
    .orderBy(asc(schema.userBoards.id));
  if (boards.length !== uuids.length) fail('One or more boards are no longer available', 'NOT_FOUND');
  return boards;
}
async function checkPublic(boards: Board[], reader: Reader = db) {
  const policies = await reader
    .select()
    .from(schema.resourcePrivacy)
    .where(
      and(
        eq(schema.resourcePrivacy.kind, 'board'),
        inArray(
          schema.resourcePrivacy.resourceId,
          boards.map((board) => board.uuid),
        ),
      ),
    );
  for (const board of boards) {
    const audience = effectiveBoardAudience(
      policies.find((policy) => policy.resourceId === board.uuid)?.audience,
      board,
    );
    if (!board.isPublic || !['public', 'unlisted'].includes(audience) || board.boardType === 'spray')
      fail('Only public catalog boards can be merged');
  }
  return policies;
}
function checkCompatible(boards: Board[]) {
  if (!boards.every((board) => boardMergeConfigsCompatible(boards[0], board)))
    fail('Board configurations differ. Only Tension Board 2 Mirror and Spray layouts are interchangeable.');
}
async function canMergeBoards(boards: Board[], userId: string, reader: Reader = db): Promise<boolean> {
  const roles = await reader
    .select({ role: schema.communityRoles.role, boardType: schema.communityRoles.boardType })
    .from(schema.communityRoles)
    .where(eq(schema.communityRoles.userId, userId));
  const gymIds = boards.flatMap((board) => (board.gymId == null ? [] : [board.gymId]));
  const gyms = gymIds.length
    ? await reader
        .select()
        .from(schema.gyms)
        .where(and(inArray(schema.gyms.id, gymIds), isNull(schema.gyms.deletedAt)))
    : [];
  const members = gymIds.length
    ? await reader
        .select()
        .from(schema.gymMembers)
        .where(
          and(
            inArray(schema.gymMembers.gymId, gymIds),
            eq(schema.gymMembers.userId, userId),
            eq(schema.gymMembers.role, 'admin'),
          ),
        )
    : [];
  return boards.every(
    (board) =>
      rolesGrantAdminOrLeader(roles, board.boardType) ||
      gyms.some(
        (gym) =>
          gym.id === board.gymId && (gym.ownerId === userId || members.some((member) => member.gymId === gym.id)),
      ),
  );
}
async function versionFor(boards: Board[], reader: Reader = db) {
  const policies = await checkPublic(boards, reader);
  return createHash('sha256').update(JSON.stringify({ boards, policies })).digest('hex');
}
async function projectRequest(request: Request, userId: string, reader: Reader = db) {
  const rows = await reader
    .select()
    .from(schema.userBoards)
    .where(
      and(
        inArray(schema.userBoards.uuid, request.boardUuids),
        isNull(schema.userBoards.deletedAt),
        eq(schema.userBoards.isPublic, true),
      ),
    );
  const boards: Board[] = [];
  for (const board of rows) {
    try {
      await checkPublic([board], reader);
      boards.push(board);
    } catch {
      /* A previously public board may have become private. */
    }
  }
  const reports = await reader
    .select({ reason: schema.boardMergeReports.reason, createdAt: schema.boardMergeReports.createdAt })
    .from(schema.boardMergeReports)
    .where(eq(schema.boardMergeReports.requestUuid, request.uuid))
    .orderBy(asc(schema.boardMergeReports.createdAt));
  return {
    ...request,
    createdAt: request.createdAt.toISOString(),
    boards: await enrichBoards(
      boards.map((board) => ({ board })),
      userId,
    ),
    canResolve:
      request.status === 'open' &&
      boards.length === request.boardUuids.length &&
      boards.every((board) => !board.deletedAt && board.isPublic) &&
      (await canMergeBoards(boards, userId, reader)),
    reports: reports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() })),
  };
}
async function lockAuthority(tx: Transaction, boards: Board[], userId: string) {
  // Revocation and reassignment wait until the decision commits.
  await tx
    .select()
    .from(schema.communityRoles)
    .where(eq(schema.communityRoles.userId, userId))
    .for('share', { noWait: true });
  const gymIds = boards.flatMap((board) => (board.gymId == null ? [] : [board.gymId]));
  if (gymIds.length) {
    await tx
      .select()
      .from(schema.gyms)
      .where(inArray(schema.gyms.id, gymIds))
      .orderBy(asc(schema.gyms.id))
      .for('share', { noWait: true });
    await tx
      .select()
      .from(schema.gymMembers)
      .where(and(inArray(schema.gymMembers.gymId, gymIds), eq(schema.gymMembers.userId, userId)))
      .for('share', { noWait: true });
  }
}
async function performMerge(tx: Transaction, input: z.infer<typeof mergeSchema>, userId: string) {
  if (!input.boardUuids.includes(input.canonicalBoardUuid)) fail('The survivor must be one of the selected boards');
  // Serialize online merges with the existing maintenance CLI before locking rows.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:serial-board-dedupe'))`);
  const locked = await tx
    .select()
    .from(schema.userBoards)
    .where(
      or(
        inArray(schema.userBoards.uuid, input.boardUuids),
        inArray(schema.userBoards.mergedIntoBoardUuid, input.boardUuids),
      ),
    )
    .orderBy(asc(schema.userBoards.id))
    .for('update');
  const boards = await loadBoards(input.boardUuids, tx);
  await tx
    .select()
    .from(schema.resourcePrivacy)
    .where(and(eq(schema.resourcePrivacy.kind, 'board'), inArray(schema.resourcePrivacy.resourceId, input.boardUuids)))
    .for('share');
  await lockAuthority(tx, boards, userId);
  if (!(await canMergeBoards(boards, userId, tx))) fail('You must manage every selected board', 'FORBIDDEN');
  checkCompatible(boards);
  if ((await versionFor(boards, tx)) !== input.version)
    fail('These boards changed. Refresh the comparison before merging.', 'BOARD_MERGE_STALE');
  for (const serial of [...new Set(boards.flatMap((board) => (board.serialNumber ? [board.serialNumber] : [])))].sort())
    await lockBoardSerialWrite(tx, serial);
  const canonical = boards.find((board) => board.uuid === input.canonicalBoardUuid)!;
  const clusterRows: SerialBoardRow[] = boards.map((board) => ({
    ...board,
    serialNumber: board.serialNumber ?? '',
    climbEventCount: 0,
    tickCount: 0,
    followCount: 0,
  }));
  const cluster = {
    serial: canonical.serialNumber ?? '',
    boards: clusterRows,
    configKey: 'explicit-review',
    skipReason: null,
  };
  const canonicalRow = clusterRows.find((board) => board.uuid === canonical.uuid)!;
  const loserBoards = boards.filter((board) => board.uuid !== canonical.uuid);
  const loserIds = loserBoards.map((board) => board.id);
  const loserUuids = loserBoards.map((board) => board.uuid);
  const movedRows: Record<string, unknown> = {};
  for (const tableName of ['board_climb_events', 'board_sessions', 'session_boards', 'boardsesh_ticks']) {
    movedRows[tableName] = await executeRows<{ id: string }>(
      tx,
      sql`SELECT id::text FROM ${sql.identifier(tableName)} WHERE board_id = ANY(${sql.param(loserIds)}::bigint[])`,
    );
  }
  movedRows.board_beta_links = await executeRows(
    tx,
    sql`SELECT board_type, climb_uuid, link FROM board_beta_links WHERE board_id = ANY(${sql.param(loserIds)}::bigint[])`,
  );
  for (const tableName of ['board_follows', 'user_board_activity', 'user_board_serials']) {
    movedRows[tableName] = await executeRows<{ id: string }>(
      tx,
      sql`SELECT id::text FROM ${sql.identifier(tableName)} WHERE board_uuid = ANY(${sql.param(loserUuids)}::text[])`,
    );
  }
  for (const tableName of ['comments', 'votes', 'feed_items', 'notifications']) {
    movedRows[tableName] = await executeRows<{ id: string }>(
      tx,
      sql`SELECT id::text FROM ${sql.identifier(tableName)} WHERE entity_type = 'board' AND entity_id = ANY(${sql.param(loserUuids)}::text[])`,
    );
  }
  movedRows.feedBoardUuids = await executeRows<{ id: string }>(
    tx,
    sql`SELECT id::text FROM feed_items WHERE board_uuid = ANY(${sql.param(loserUuids)}::text[])`,
  );
  const counts = await mergeSerialCluster(
    tx,
    cluster,
    canonicalRow,
    locked.filter((board) => board.mergedIntoBoardUuid != null).map((board) => board.id),
    { preserveCanonicalMetadata: true },
  );
  const policies = await checkPublic(boards, tx);
  const mergedAudience = boards.some(
    (board) =>
      effectiveBoardAudience(policies.find((policy) => policy.resourceId === board.uuid)?.audience, board) ===
      'unlisted',
  )
    ? 'unlisted'
    : 'public';
  const locations = new Set(
    boards.map((board) =>
      board.hideLocation
        ? 'only_me'
        : (policies.find((policy) => policy.resourceId === board.uuid)?.locationAudience ?? 'public'),
    ),
  );
  const restrictiveLocations = [...locations].filter((audience) => audience !== 'public');
  const mergedLocationAudience = restrictiveLocations.length > 1 ? 'only_me' : (restrictiveLocations[0] ?? 'public');
  if (policies.length) {
    await tx
      .insert(schema.resourcePrivacy)
      .values({
        kind: 'board',
        resourceId: canonical.uuid,
        ownerId: canonical.ownerId,
        audience: mergedAudience,
        locationAudience: mergedLocationAudience,
      })
      .onConflictDoUpdate({
        target: [schema.resourcePrivacy.kind, schema.resourcePrivacy.resourceId],
        set: {
          audience: mergedAudience,
          locationAudience: mergedLocationAudience,
          revision: sql`${schema.resourcePrivacy.revision} + 1`,
          updatedAt: new Date(),
        },
      });
  }
  if (mergedAudience === 'unlisted')
    await tx.update(schema.userBoards).set({ isUnlisted: true }).where(eq(schema.userBoards.uuid, canonical.uuid));
  await tx
    .update(schema.userBoards)
    .set({ syncFrozenAt: new Date() })
    .where(inArray(schema.userBoards.uuid, input.boardUuids));
  const losers = boards.filter((board) => board.uuid !== canonical.uuid).map((board) => board.uuid);
  // Kiosk layouts are validated JSON: replace aliases, dedupe slots, preserve display options.
  const kiosks = await tx
    .select()
    .from(schema.gymKiosks)
    .where(
      and(
        isNull(schema.gymKiosks.deletedAt),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${schema.gymKiosks.layout}->'boards') slot WHERE slot->>'boardUuid' = ANY(${sql.param(losers)}::text[])) OR ${schema.gymKiosks.layout}->'leaderboard'->>'boardUuid' = ANY(${sql.param(losers)}::text[])`,
      ),
    )
    .orderBy(asc(schema.gymKiosks.id))
    .for('update');
  movedRows.kiosks = kiosks;
  for (const kiosk of kiosks) {
    if (
      !kiosk.layout.boards.some((slot) => losers.includes(slot.boardUuid)) &&
      !losers.includes(kiosk.layout.leaderboard?.boardUuid ?? '')
    )
      continue;
    const seen = new Set<string>();
    const slots = kiosk.layout.boards.flatMap((slot) => {
      if (losers.includes(slot.boardUuid) && kiosk.gymId !== canonical.gymId) return [];
      const boardUuid = losers.includes(slot.boardUuid) ? canonical.uuid : slot.boardUuid;
      if (seen.has(boardUuid)) return [];
      seen.add(boardUuid);
      return [{ ...slot, boardUuid }];
    });
    const leaderboard =
      kiosk.layout.leaderboard && losers.includes(kiosk.layout.leaderboard.boardUuid ?? '')
        ? kiosk.gymId === canonical.gymId
          ? { ...kiosk.layout.leaderboard, boardUuid: canonical.uuid }
          : { ...kiosk.layout.leaderboard, boardUuid: null }
        : kiosk.layout.leaderboard;
    await tx
      .update(schema.gymKiosks)
      .set({ layout: { ...kiosk.layout, boards: slots, leaderboard }, updatedAt: new Date() })
      .where(eq(schema.gymKiosks.id, kiosk.id));
  }
  await tx.insert(schema.boardMergeAudit).values({
    uuid: randomUUID(),
    canonicalBoardUuid: canonical.uuid,
    boardUuids: input.boardUuids,
    performedBy: userId,
    reason: input.reason,
    beforeState: { boards, movedRows },
    movedCounts: counts,
  });
  await tx
    .update(schema.boardMergeRequests)
    .set({
      status: 'superseded',
      resolvedAt: new Date(),
      resolvedBy: userId,
      resolutionReason: 'A selected board was merged',
    })
    .where(
      and(
        eq(schema.boardMergeRequests.status, 'open'),
        sql`${schema.boardMergeRequests.boardUuids} ?| ${sql.param(losers)}::text[]`,
      ),
    );
  return { canonicalBoardUuid: canonical.uuid };
}
async function mergeTransaction<Result>(work: (transaction: Transaction) => Promise<Result>): Promise<Result> {
  try {
    return await db.transaction(work, { isolationLevel: 'read committed' });
  } catch (error) {
    let cause: unknown = error;
    while (cause && typeof cause === 'object') {
      if ('code' in cause && ['55P03', '40P01', '40001'].includes(String(cause.code)))
        fail('These boards are being updated. Refresh the comparison and try again.', 'BOARD_MERGE_BUSY');
      cause = 'cause' in cause ? cause.cause : null;
    }
    throw error;
  }
}
async function afterMerge(uuids: string[], canonicalUuid: string) {
  try {
    const boards = await db.select().from(schema.userBoards).where(inArray(schema.userBoards.uuid, uuids));
    for (const board of boards) {
      if (board.uuid === canonicalUuid) queueBoardStatsPublish(board.id, board.boardType);
      else {
        try {
          await publishBoardQueuePreviewTombstoneForBoard(board.id);
        } catch (error) {
          logger.warn('Could not retract merged board preview', { boardId: board.id, error: String(error) });
        }
      }
    }
  } catch (error) {
    logger.warn('Could not refresh merged board projections', { error: String(error) });
  }
}
export const boardMergeQueries = {
  boardMergeCandidates: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validated = validateInput(candidateSchema, input ?? {}, 'input');
    const [anchor] = validated.boardUuid ? await loadBoards([validated.boardUuid]) : [];
    if (anchor) await checkPublic([anchor]);
    const rows = await db
      .select({ board: schema.userBoards })
      .from(schema.userBoards)
      .leftJoin(schema.gyms, eq(schema.gyms.id, schema.userBoards.gymId))
      .where(
        and(
          isNull(schema.userBoards.deletedAt),
          eq(schema.userBoards.isPublic, true),
          eq(schema.userBoards.isUnlisted, false),
          sql`NOT EXISTS (SELECT 1 FROM resource_privacy policy WHERE policy.kind = 'board' AND policy.resource_id = ${schema.userBoards.uuid} AND policy.audience <> 'public')`,
          sql`${schema.userBoards.boardType} <> 'spray'`,
          validated.gymUuid ? eq(schema.gyms.uuid, validated.gymUuid) : undefined,
          anchor
            ? and(eq(schema.userBoards.boardType, anchor.boardType), eq(schema.userBoards.sizeId, anchor.sizeId))
            : undefined,
          validated.query
            ? or(
                ilike(schema.userBoards.name, `%${validated.query}%`),
                ilike(schema.userBoards.slug, `%${validated.query}%`),
                ilike(schema.gyms.name, `%${validated.query}%`),
              )
            : undefined,
        ),
      )
      .orderBy(asc(schema.userBoards.id))
      .limit(validated.limit + 1)
      .offset(validated.offset);
    return {
      boards: await enrichBoards(rows.slice(0, validated.limit), ctx.userId!),
      hasMore: rows.length > validated.limit,
    };
  },
  boardMergePreview: async (_: unknown, { boardUuids }: { boardUuids: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const uuids = validateInput(selectionSchema, boardUuids, 'boardUuids');
    const boards = await loadBoards(uuids);
    const version = await versionFor(boards);
    const projected = await enrichBoards(
      boards.map((board) => ({ board })),
      ctx.userId!,
    );
    if (projected.length !== boards.length) fail('Board not found', 'NOT_FOUND');
    checkCompatible(boards);
    const reason = null;
    return {
      boards: projected,
      suggestedCanonicalBoardUuid: projected.sort((first, second) => second.followerCount - first.followerCount)[0]
        .uuid,
      canMerge: !reason && (await canMergeBoards(boards, ctx.userId!)),
      version,
      reason,
    };
  },
  boardMergeRequests: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validated = validateInput(pageSchema, input ?? {}, 'input');
    const roles = await db.select().from(schema.communityRoles).where(eq(schema.communityRoles.userId, ctx.userId!));
    const globalRole = roles.some(
      (role) => (role.role === 'admin' || role.role === 'community_leader') && role.boardType == null,
    );
    const scopedTypes = roles
      .filter((role) => role.role === 'admin' || role.role === 'community_leader')
      .flatMap((role) => (role.boardType ? [role.boardType] : []));
    const authorizedBoard = globalRole
      ? sql`TRUE`
      : sql`(b.board_type = ANY(${sql.param(scopedTypes)}::text[]) OR EXISTS (SELECT 1 FROM gyms g WHERE g.id = b.gym_id AND g.deleted_at IS NULL AND (g.owner_id = ${ctx.userId!} OR EXISTS (SELECT 1 FROM gym_members gm WHERE gm.gym_id = g.id AND gm.user_id = ${ctx.userId!} AND gm.role = 'admin'))))`;
    const reviewerScope = sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${schema.boardMergeRequests.boardUuids}) selected(uuid) LEFT JOIN user_boards b ON b.uuid = selected.uuid LEFT JOIN resource_privacy p ON p.kind = 'board' AND p.resource_id = b.uuid WHERE b.uuid IS NULL OR (b.deleted_at IS NOT NULL AND b.merged_into_board_uuid IS NULL) OR (NOT b.is_public AND b.merged_into_board_uuid IS NULL) OR b.board_type = 'spray' OR COALESCE(p.audience, 'public') NOT IN ('public', 'unlisted') OR NOT ${authorizedBoard})`;
    const ownReport = sql`EXISTS (SELECT 1 FROM board_merge_reports report WHERE report.request_uuid = ${schema.boardMergeRequests.uuid} AND report.reporter_id = ${ctx.userId!})`;
    const rows = await db
      .select()
      .from(schema.boardMergeRequests)
      .where(
        and(
          or(ownReport, reviewerScope),
          validated.status ? eq(schema.boardMergeRequests.status, validated.status) : undefined,
          validated.boardType
            ? sql`EXISTS (SELECT 1 FROM user_boards b WHERE b.uuid IN (SELECT jsonb_array_elements_text(${schema.boardMergeRequests.boardUuids})) AND b.board_type = ${validated.boardType})`
            : undefined,
          validated.gymUuid
            ? sql`EXISTS (SELECT 1 FROM user_boards b JOIN gyms g ON g.id = b.gym_id WHERE b.uuid IN (SELECT jsonb_array_elements_text(${schema.boardMergeRequests.boardUuids})) AND g.uuid = ${validated.gymUuid})`
            : undefined,
        ),
      )
      .orderBy(desc(schema.boardMergeRequests.createdAt), desc(schema.boardMergeRequests.uuid))
      .limit(validated.limit + 1)
      .offset(validated.offset);
    return {
      requests: await Promise.all(
        rows.slice(0, validated.limit).map((request) => projectRequest(request, ctx.userId!)),
      ),
      hasMore: rows.length > validated.limit,
    };
  },
};
export const boardMergeMutations = {
  requestBoardMerge: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'requestBoardMerge');
    const validated = validateInput(requestSchema, input, 'input');
    if (!validated.boardUuids.includes(validated.canonicalBoardUuid))
      fail('Choose a survivor from the selected boards');
    const request = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:serial-board-dedupe'))`);
      await tx
        .select()
        .from(schema.userBoards)
        .where(inArray(schema.userBoards.uuid, validated.boardUuids))
        .orderBy(asc(schema.userBoards.id))
        .for('share');
      const boards = await loadBoards(validated.boardUuids, tx);
      await checkPublic(boards, tx);
      checkCompatible(boards);
      const [existing] = await tx
        .select()
        .from(schema.boardMergeRequests)
        .where(
          and(
            eq(schema.boardMergeRequests.signature, signature(validated.boardUuids)),
            eq(schema.boardMergeRequests.status, 'open'),
          ),
        );
      const [created] = existing
        ? [existing]
        : await tx
            .insert(schema.boardMergeRequests)
            .values({
              ...validated,
              uuid: randomUUID(),
              signature: signature(validated.boardUuids),
              proposerId: ctx.userId!,
            })
            .returning();
      await tx
        .insert(schema.boardMergeReports)
        .values({ uuid: randomUUID(), requestUuid: created.uuid, reporterId: ctx.userId!, reason: validated.reason })
        .onConflictDoNothing();
      return created;
    });
    return projectRequest(request, ctx.userId!);
  },
  mergeBoards: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'mergeBoards');
    const validated = validateInput(mergeSchema, input, 'input');
    const result = await mergeTransaction((tx) => performMerge(tx, validated, ctx.userId!));
    await afterMerge(validated.boardUuids, result.canonicalBoardUuid);
    return result;
  },
  resolveBoardMergeRequest: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'resolveBoardMergeRequest');
    const validated = validateInput(resolveSchema, input, 'input');
    const request = await mergeTransaction(async (tx) => {
      // Same outer lock as direct merges avoids request→board vs board→request inversion.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:serial-board-dedupe'))`);
      const [request] = await tx
        .select()
        .from(schema.boardMergeRequests)
        .where(eq(schema.boardMergeRequests.uuid, validated.requestUuid))
        .for('update');
      if (!request) fail('Request not found', 'NOT_FOUND');
      await tx
        .select()
        .from(schema.userBoards)
        .where(
          or(
            inArray(schema.userBoards.uuid, request.boardUuids),
            inArray(schema.userBoards.mergedIntoBoardUuid, request.boardUuids),
          ),
        )
        .orderBy(asc(schema.userBoards.id))
        .for('update');
      const boards =
        request.status === 'open'
          ? await loadBoards(request.boardUuids, tx)
          : await tx.select().from(schema.userBoards).where(inArray(schema.userBoards.uuid, request.boardUuids));
      await lockAuthority(tx, boards, ctx.userId!);
      if (!(await canMergeBoards(boards, ctx.userId!, tx))) fail('You must manage every selected board', 'FORBIDDEN');
      if (request.status !== 'open') return request;
      if (validated.approve) {
        if (!validated.version || !validated.canonicalBoardUuid) fail('Refresh the comparison and choose a survivor');
        await performMerge(
          tx,
          {
            boardUuids: request.boardUuids,
            canonicalBoardUuid: validated.canonicalBoardUuid,
            version: validated.version,
            reason: validated.reason || request.reason,
          },
          ctx.userId!,
        );
      }
      const [resolved] = await tx
        .update(schema.boardMergeRequests)
        .set({
          status: validated.approve ? 'approved' : 'rejected',
          canonicalBoardUuid: validated.approve ? validated.canonicalBoardUuid : request.canonicalBoardUuid,
          resolvedAt: new Date(),
          resolvedBy: ctx.userId!,
          resolutionReason: validated.reason,
        })
        .where(eq(schema.boardMergeRequests.uuid, request.uuid))
        .returning();
      return resolved;
    });
    if (request.status === 'approved') await afterMerge(request.boardUuids, request.canonicalBoardUuid);
    return projectRequest(request, ctx.userId!);
  },
};
