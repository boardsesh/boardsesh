import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { accountConsolidationSessionAliases } from '@boardsesh/db/schema/auth';
import { SESSION_GAP_MS } from '@boardsesh/session-inference';
import {
  intersectInferredPrivacy,
  loadInferredPrivacy,
  writeInferredPrivacy,
} from '../../services/inferred-sessions/privacy';
import { parseClimbedAt } from '../../services/inferred-sessions/timestamps';
import type { ConsolidationContext, ConsolidationDomainHandler, ConsolidationTransaction } from './executor';
import type { ConsolidationPreimageArchive } from './profile-handler';
import { ConsolidationError } from './planner';

type Session = typeof schema.boardSessions.$inferSelect;
export type ConsolidationSessionIdentity = Pick<
  Session,
  'id' | 'origin' | 'createdByUserId' | 'userEdited' | 'createdAt' | 'name' | 'goal' | 'notes'
>;
export type SessionMergeInstruction = {
  readonly retainedId: string;
  readonly retiredIds: readonly string[];
  readonly firstTickAt: Date;
  readonly lastTickAt: Date;
};

/** Complete existing inferred runs only; explicit sessions and unassigned ticks are never absorbed. */
export function planConsolidatedInferredSessions(
  sessions: readonly ConsolidationSessionIdentity[],
  ticks: readonly { readonly id: bigint; readonly sessionId: string | null; readonly climbedAt: string }[],
  canonicalUserId: string,
): SessionMergeInstruction[] {
  const inferred = new Map(
    sessions.filter((session) => session.origin === 'inferred').map((session) => [session.id, session]),
  );
  const ordered = ticks
    .filter((tick) => tick.sessionId !== null && inferred.has(tick.sessionId))
    .map((tick) => ({ ...tick, at: parseClimbedAt(tick.climbedAt).getTime() }))
    .sort((left, right) => left.at - right.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (ordered.some((tick) => !Number.isFinite(tick.at))) throw new ConsolidationError('INVALID_EVIDENCE');
  const runs: (typeof ordered)[] = [];
  for (const tick of ordered) {
    const previous = runs[runs.length - 1];
    if (!previous || tick.at - previous[previous.length - 1].at > SESSION_GAP_MS) runs.push([tick]);
    else previous.push(tick);
  }
  const assigned = new Set<string>();
  const instructions: SessionMergeInstruction[] = [];
  for (const run of runs) {
    const identifiers = [...new Set(run.flatMap((tick) => (tick.sessionId ? [tick.sessionId] : [])))];
    if (identifiers.some((identifier) => assigned.has(identifier))) throw new ConsolidationError('UNSAFE_PLAN');
    for (const identifier of identifiers) assigned.add(identifier);
    if (identifiers.length < 2) continue;
    const candidates = identifiers.map((identifier) => inferred.get(identifier)!);
    candidates.sort(
      (left, right) =>
        Number(right.createdByUserId === canonicalUserId) - Number(left.createdByUserId === canonicalUserId) ||
        Number(right.userEdited) - Number(left.userEdited) ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    instructions.push({
      retainedId: candidates[0].id,
      retiredIds: candidates.slice(1).map((session) => session.id),
      firstTickAt: new Date(run[0].at),
      lastTickAt: new Date(run[run.length - 1].at),
    });
  }
  return instructions;
}

/** Original strings survive verbatim; source metadata is appended without truncation. */
export function combineConsolidatedSessionMetadata(
  retained: ConsolidationSessionIdentity,
  retired: readonly ConsolidationSessionIdentity[],
) {
  const additions = [...retired]
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
    .flatMap((session) => {
      const lines = [
        session.name === null ? null : `Session: ${session.name}`,
        session.goal === null ? null : `Goal: ${session.goal}`,
        session.notes,
      ].filter((line): line is string => line !== null);
      return lines.length ? [`[${session.createdAt.toISOString()}]\n${lines.join('\n')}`] : [];
    });
  return {
    name: retained.name,
    goal: retained.goal,
    notes: [retained.notes, ...additions].filter((entry): entry is string => entry !== null).join('\n\n') || null,
    userEdited: retained.userEdited || retired.some((session) => session.userEdited),
  };
}

function bounded(record: unknown) {
  if (
    Buffer.byteLength(
      JSON.stringify(record, (_, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry)),
    ) > 16777216
  )
    throw new ConsolidationError('INPUT_LIMIT');
}

/** Do not silently cascade a future table's data or an unsupported current structure. */
async function assertKnownSessionReferences(transaction: ConsolidationTransaction, sessionIds: readonly string[]) {
  const supported = new Set([
    'public.boardsesh_ticks.session_id',
    'public.board_climb_events.session_id',
    'public.board_session_participants.session_id',
    'public.session_health_kit_workouts.session_id',
    'public.session_boards.session_id',
  ]);
  const references = await transaction.execute<{
    schema: string;
    table: string;
    column: string;
  }>(sql`SELECT DISTINCT namespace.nspname::text AS schema,relation.relname::text AS table,column_row.attname::text AS column
    FROM pg_catalog.pg_constraint constraint_row JOIN pg_catalog.pg_class relation ON relation.oid=constraint_row.conrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.unnest(constraint_row.conkey) referenced(attnum)
    JOIN pg_catalog.pg_attribute column_row ON column_row.attrelid=constraint_row.conrelid AND column_row.attnum=referenced.attnum
    WHERE constraint_row.contype='f' AND constraint_row.confrelid='public.board_sessions'::pg_catalog.regclass AND constraint_row.conparentid=0 LIMIT 1001`);
  if (references.length > 1000) throw new ConsolidationError('INPUT_LIMIT');
  for (const reference of references) {
    if (supported.has(`${reference.schema}.${reference.table}.${reference.column}`)) continue;
    const [rows] = await transaction.execute<{ found: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM ${sql.identifier(reference.schema)}.${sql.identifier(reference.table)} WHERE ${sql.identifier(reference.column)} IN (${sql.join(
        sessionIds.map((sessionId) => sql`${sessionId}`),
        sql`, `,
      )})) AS found`,
    );
    if (rows?.found !== false) throw new ConsolidationError('UNSAFE_PLAN');
  }
  // This polymorphic reference has no FK. External exports cannot be merged locally without provider-specific reconciliation.
  const exports = await transaction
    .select({ id: schema.integrationExports.id })
    .from(schema.integrationExports)
    .where(inArray(schema.integrationExports.sessionId, [...sessionIds]))
    .limit(1);
  if (exports.length) throw new ConsolidationError('UNSAFE_PLAN');
}

async function mergeOneSession(
  transaction: ConsolidationTransaction,
  context: ConsolidationContext,
  instruction: SessionMergeInstruction,
  sessions: readonly Session[],
  archive: ConsolidationPreimageArchive,
) {
  const ids = [instruction.retainedId, ...instruction.retiredIds];
  await assertKnownSessionReferences(transaction, instruction.retiredIds);
  const retained = sessions.find((session) => session.id === instruction.retainedId)!;
  const retired = sessions.filter((session) => instruction.retiredIds.includes(session.id));
  const members = [context.survivorUserId, ...context.sourceUserIds];
  const allTicks = await transaction
    .select({ id: schema.boardseshTicks.id, userId: schema.boardseshTicks.userId })
    .from(schema.boardseshTicks)
    .where(inArray(schema.boardseshTicks.sessionId, ids))
    .limit(100001);
  if (allTicks.length > 100000 || allTicks.some((tick) => !members.includes(tick.userId)))
    throw new ConsolidationError('UNSAFE_PLAN');
  const comments = await transaction
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.entityType, 'session'), inArray(schema.comments.entityId, ids)))
    .limit(100001)
    .for('update');
  const votes = await transaction
    .select()
    .from(schema.votes)
    .where(and(eq(schema.votes.entityType, 'session'), inArray(schema.votes.entityId, ids)))
    .limit(100001)
    .for('update');
  const counts = await transaction
    .select()
    .from(schema.voteCounts)
    .where(and(eq(schema.voteCounts.entityType, 'session'), inArray(schema.voteCounts.entityId, ids)))
    .limit(100001)
    .for('update');
  const feed = await transaction
    .select()
    .from(schema.feedItems)
    .where(and(eq(schema.feedItems.entityType, 'session'), inArray(schema.feedItems.entityId, ids)))
    .limit(100001)
    .for('update');
  const notifications = await transaction
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.entityType, 'session'), inArray(schema.notifications.entityId, ids)))
    .limit(100001)
    .for('update');
  const participants = await transaction
    .select()
    .from(schema.boardSessionParticipants)
    .where(inArray(schema.boardSessionParticipants.sessionId, ids))
    .limit(100001)
    .for('update');
  const health = await transaction
    .select()
    .from(schema.sessionHealthKitWorkouts)
    .where(inArray(schema.sessionHealthKitWorkouts.sessionId, ids))
    .limit(100001)
    .for('update');
  const boards = await transaction
    .select()
    .from(schema.sessionBoards)
    .where(inArray(schema.sessionBoards.sessionId, ids))
    .limit(100001)
    .for('update');
  const privacy = await transaction
    .select()
    .from(schema.contentPrivacy)
    .where(and(eq(schema.contentPrivacy.entityType, 'session'), inArray(schema.contentPrivacy.entityId, ids)))
    .limit(100001)
    .for('update');
  const resourcePrivacy = await transaction
    .select()
    .from(schema.resourcePrivacy)
    .where(and(eq(schema.resourcePrivacy.kind, 'session'), inArray(schema.resourcePrivacy.resourceId, ids)))
    .limit(100001)
    .for('update');
  const grants = await transaction
    .select()
    .from(schema.resourceGrants)
    .where(and(eq(schema.resourceGrants.kind, 'session'), inArray(schema.resourceGrants.resourceId, ids)))
    .limit(100001)
    .for('update');
  const preimages = {
    sessions: [retained, ...retired],
    comments,
    votes,
    counts,
    feed,
    notifications,
    participants,
    health,
    boards,
    privacy,
    resourcePrivacy,
    grants,
  };
  if (Object.values(preimages).some((rows) => rows.length > 100000)) throw new ConsolidationError('INPUT_LIMIT');
  bounded(preimages);
  await archive(context, 'sessions', preimages);
  const policies = await loadInferredPrivacy(transaction, ids);
  const intersection = intersectInferredPrivacy([...policies.values()]);
  // New follower unions must never widen old metadata access, even for legacy session policies.
  if (
    intersection.audience === 'followers' ||
    intersection.inheritFollowers ||
    privacy.some((policy) => policy.audience !== 'public')
  ) {
    intersection.audience = 'only_me';
    intersection.inheritFollowers = false;
    intersection.grants.clear();
  }
  for (const session of retired) {
    const sourcePolicy = policies.get(session.id);
    if (!sourcePolicy || sourcePolicy.audience !== 'public') {
      for (const comment of comments.filter((comment) => comment.entityId === session.id))
        await transaction
          .insert(schema.contentPrivacy)
          .values({ entityType: 'comment', entityId: comment.uuid, ownerId: comment.userId, audience: 'only_me' })
          .onConflictDoUpdate({
            target: [schema.contentPrivacy.entityType, schema.contentPrivacy.entityId],
            set: { audience: 'only_me', publicConsentRevision: null, updatedAt: new Date() },
          });
    }
  }
  const byVoter = new Map<string, typeof votes>();
  for (const vote of votes) {
    const entries = byVoter.get(vote.userId) ?? [];
    entries.push(vote);
    byVoter.set(vote.userId, entries);
  }
  const winningVotes = [...byVoter.values()].map(
    (entries) =>
      [...entries].sort(
        (left, right) =>
          Number(right.entityId === instruction.retainedId) - Number(left.entityId === instruction.retainedId) ||
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id - left.id,
      )[0],
  );
  const losers = votes.filter((vote) => !winningVotes.includes(vote));
  if (losers.length)
    await transaction.delete(schema.votes).where(
      inArray(
        schema.votes.id,
        losers.map((vote) => vote.id),
      ),
    );
  await transaction
    .update(schema.votes)
    .set({ entityId: instruction.retainedId })
    .where(and(eq(schema.votes.entityType, 'session'), inArray(schema.votes.entityId, [...instruction.retiredIds])));
  await transaction
    .update(schema.comments)
    .set({ entityId: instruction.retainedId })
    .where(
      and(eq(schema.comments.entityType, 'session'), inArray(schema.comments.entityId, [...instruction.retiredIds])),
    );
  await transaction
    .update(schema.feedItems)
    .set({ entityId: instruction.retainedId })
    .where(
      and(eq(schema.feedItems.entityType, 'session'), inArray(schema.feedItems.entityId, [...instruction.retiredIds])),
    );
  await transaction
    .update(schema.notifications)
    .set({ entityId: instruction.retainedId })
    .where(
      and(
        eq(schema.notifications.entityType, 'session'),
        inArray(schema.notifications.entityId, [...instruction.retiredIds]),
      ),
    );
  await transaction
    .delete(schema.voteCounts)
    .where(and(eq(schema.voteCounts.entityType, 'session'), inArray(schema.voteCounts.entityId, ids)));
  const upvotes = winningVotes.filter((vote) => vote.value === 1).length;
  const downvotes = winningVotes.filter((vote) => vote.value === -1).length;
  if (winningVotes.length || counts.length)
    await transaction.insert(schema.voteCounts).values({
      entityType: 'session',
      entityId: instruction.retainedId,
      upvotes,
      downvotes,
      score: upvotes - downvotes,
      hotScore: 0,
      createdAt: retained.createdAt,
    });
  // Identical HealthKit mapping is safe to coalesce; distinct external workout IDs require review.
  const healthByUser = new Map<string, typeof health>();
  for (const row of health) {
    const userId = members.includes(row.userId) ? context.survivorUserId : row.userId;
    const entries = healthByUser.get(userId) ?? [];
    entries.push(row);
    healthByUser.set(userId, entries);
  }
  if ([...healthByUser.values()].some((entries) => new Set(entries.map((row) => row.workoutId)).size > 1))
    throw new ConsolidationError('UNSAFE_PLAN');
  await transaction
    .delete(schema.sessionHealthKitWorkouts)
    .where(inArray(schema.sessionHealthKitWorkouts.sessionId, ids));
  for (const [userId, entries] of healthByUser)
    await transaction
      .insert(schema.sessionHealthKitWorkouts)
      .values({ ...entries[0], userId, sessionId: instruction.retainedId });
  await transaction
    .delete(schema.boardSessionParticipants)
    .where(inArray(schema.boardSessionParticipants.sessionId, ids));
  const participantByUser = new Map<string, (typeof participants)[number]>();
  for (const row of participants) {
    const userId = members.includes(row.userId) ? context.survivorUserId : row.userId;
    const previous = participantByUser.get(userId);
    if (!previous || row.joinedAt < previous.joinedAt) participantByUser.set(userId, row);
  }
  for (const [userId, row] of participantByUser)
    await transaction
      .insert(schema.boardSessionParticipants)
      .values({ ...row, userId, sessionId: instruction.retainedId });
  await transaction.delete(schema.sessionBoards).where(inArray(schema.sessionBoards.sessionId, ids));
  for (const boardId of new Set(boards.map((board) => board.boardId))) {
    const original = boards
      .filter((board) => board.boardId === boardId)
      .sort(
        (left, right) =>
          (left.createdAt?.getTime() ?? Infinity) - (right.createdAt?.getTime() ?? Infinity) || left.id - right.id,
      )[0];
    await transaction
      .insert(schema.sessionBoards)
      .values({ boardId, sessionId: instruction.retainedId, createdAt: original.createdAt });
  }
  await transaction
    .update(schema.boardClimbEvents)
    .set({ sessionId: instruction.retainedId })
    .where(inArray(schema.boardClimbEvents.sessionId, [...instruction.retiredIds]));
  await transaction
    .update(schema.boardseshTicks)
    .set({ sessionId: instruction.retainedId })
    .where(inArray(schema.boardseshTicks.sessionId, [...instruction.retiredIds]));
  await transaction
    .delete(schema.contentPrivacy)
    .where(and(eq(schema.contentPrivacy.entityType, 'session'), inArray(schema.contentPrivacy.entityId, ids)));
  await transaction
    .delete(schema.resourcePrivacy)
    .where(
      and(
        eq(schema.resourcePrivacy.kind, 'session'),
        inArray(schema.resourcePrivacy.resourceId, [...instruction.retiredIds]),
      ),
    );
  await transaction
    .delete(schema.resourceGrants)
    .where(
      and(
        eq(schema.resourceGrants.kind, 'session'),
        inArray(schema.resourceGrants.resourceId, [...instruction.retiredIds]),
      ),
    );
  await writeInferredPrivacy(transaction, instruction.retainedId, context.survivorUserId, intersection);
  const [profile] = await transaction
    .select({ revision: schema.userProfiles.privacyRevision })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, context.survivorUserId));
  await transaction.insert(schema.contentPrivacy).values({
    entityType: 'session',
    entityId: instruction.retainedId,
    ownerId: context.survivorUserId,
    audience: intersection.audience === 'public' ? 'public' : 'only_me',
    publicConsentRevision: intersection.audience === 'public' ? (profile?.revision ?? 0) : null,
  });
  const aliases = await transaction
    .select()
    .from(accountConsolidationSessionAliases)
    .where(inArray(accountConsolidationSessionAliases.retiredSessionId, [...instruction.retiredIds]))
    .for('update');
  if (
    aliases.some(
      (alias) =>
        alias.canonicalSessionId !== instruction.retainedId ||
        alias.targetUserId !== context.survivorUserId ||
        alias.mergeId !== context.mergeId ||
        alias.tombstoned,
    )
  )
    throw new ConsolidationError('UNSAFE_PLAN');
  for (const sessionId of instruction.retiredIds)
    if (!aliases.some((alias) => alias.retiredSessionId === sessionId))
      await transaction.insert(accountConsolidationSessionAliases).values({
        retiredSessionId: sessionId,
        canonicalSessionId: instruction.retainedId,
        targetUserId: context.survivorUserId,
        mergeId: context.mergeId,
      });
  await transaction.delete(schema.boardSessions).where(inArray(schema.boardSessions.id, [...instruction.retiredIds]));
  const retiredTicks = new Map(context.group.tickMerges.map((merge) => [merge.retiredId, merge.retainedId]));
  const projectedTickIds = allTicks
    .map((tick) => BigInt(retiredTicks.get(tick.id.toString()) ?? tick.id))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const anchor =
    retained.anchorTickId === null
      ? Number(projectedTickIds[0])
      : Number(retiredTicks.get(String(retained.anchorTickId)) ?? retained.anchorTickId);
  if (anchor !== null && !Number.isSafeInteger(anchor)) throw new ConsolidationError('UNSAFE_PLAN');
  await transaction
    .update(schema.boardSessions)
    .set({
      ...combineConsolidatedSessionMetadata(retained, retired),
      createdByUserId: context.survivorUserId,
      startedAt: instruction.firstTickAt,
      endedAt: instruction.lastTickAt,
      lastActivity: instruction.lastTickAt,
      anchorTickId: anchor,
    })
    .where(eq(schema.boardSessions.id, instruction.retainedId));
}

export function createConsolidationSessionHandler(options: {
  readonly archivePreimages: ConsolidationPreimageArchive;
}): ConsolidationDomainHandler {
  return {
    name: 'sessions',
    userReferences: [
      'public.board_sessions.created_by_user_id',
      'public.board_session_participants.user_id',
      'public.session_health_kit_workouts.user_id',
      'public.session_workouts.user_id',
    ],
    async apply(transaction, context) {
      const members = [context.survivorUserId, ...context.sourceUserIds];
      const sessions = await transaction
        .select()
        .from(schema.boardSessions)
        .where(inArray(schema.boardSessions.createdByUserId, members))
        .orderBy(schema.boardSessions.id)
        .limit(10001)
        .for('update');
      const ticks = await transaction
        .select({
          id: schema.boardseshTicks.id,
          sessionId: schema.boardseshTicks.sessionId,
          climbedAt: schema.boardseshTicks.climbedAt,
        })
        .from(schema.boardseshTicks)
        .where(inArray(schema.boardseshTicks.userId, members))
        .limit(100001)
        .for('update');
      if (sessions.length > 10000 || ticks.length > 100000) throw new ConsolidationError('INPUT_LIMIT');
      const workoutRows = await transaction
        .select({ sessionId: schema.sessionWorkouts.sessionId, userId: schema.sessionWorkouts.userId })
        .from(schema.sessionWorkouts)
        .where(inArray(schema.sessionWorkouts.userId, [...context.sourceUserIds]))
        .limit(1);
      // Workout plans/revisions need their own conflict policy; never cascade or silently drop them.
      if (workoutRows.length) throw new ConsolidationError('UNSAFE_PLAN');
      const instructions = planConsolidatedInferredSessions(sessions, ticks, context.survivorUserId);
      bounded({ sessions, instructions });
      await options.archivePreimages(context, 'session-ownership', { sessions, instructions });
      for (const instruction of instructions)
        await mergeOneSession(transaction, context, instruction, sessions, options.archivePreimages);
      await transaction
        .update(schema.boardSessions)
        .set({ createdByUserId: context.survivorUserId })
        .where(inArray(schema.boardSessions.createdByUserId, [...context.sourceUserIds]));
      // Participant and HealthKit rows outside merged inferred sessions still need explicit set-union conflict handling.
      const participants = await transaction
        .select()
        .from(schema.boardSessionParticipants)
        .where(inArray(schema.boardSessionParticipants.userId, members))
        .limit(100001)
        .for('update');
      const health = await transaction
        .select()
        .from(schema.sessionHealthKitWorkouts)
        .where(inArray(schema.sessionHealthKitWorkouts.userId, members))
        .limit(100001)
        .for('update');
      bounded({ participants, health });
      await options.archivePreimages(context, 'session-member-ownership', { participants, health });
      const participantKeys = new Set(
        participants.filter((row) => row.userId === context.survivorUserId).map((row) => row.sessionId),
      );
      for (const retained of participants.filter((row) => row.userId === context.survivorUserId)) {
        const earliest = participants
          .filter((row) => row.sessionId === retained.sessionId)
          .reduce((joinedAt, row) => (row.joinedAt < joinedAt ? row.joinedAt : joinedAt), retained.joinedAt);
        if (earliest < retained.joinedAt)
          await transaction
            .update(schema.boardSessionParticipants)
            .set({ joinedAt: earliest })
            .where(
              and(
                eq(schema.boardSessionParticipants.sessionId, retained.sessionId),
                eq(schema.boardSessionParticipants.userId, context.survivorUserId),
              ),
            );
      }
      for (const row of participants.filter((row) => context.sourceUserIds.includes(row.userId))) {
        if (!participantKeys.has(row.sessionId)) {
          await transaction.insert(schema.boardSessionParticipants).values({ ...row, userId: context.survivorUserId });
          participantKeys.add(row.sessionId);
        }
      }
      await transaction
        .delete(schema.boardSessionParticipants)
        .where(inArray(schema.boardSessionParticipants.userId, [...context.sourceUserIds]));
      const healthBySession = new Map<string, typeof health>();
      for (const row of health) {
        const entries = healthBySession.get(row.sessionId) ?? [];
        entries.push(row);
        healthBySession.set(row.sessionId, entries);
      }
      for (const entries of healthBySession.values()) {
        if (new Set(entries.map((row) => row.workoutId)).size > 1) throw new ConsolidationError('UNSAFE_PLAN');
        const retained = entries.find((row) => row.userId === context.survivorUserId) ?? entries[0];
        for (const row of entries.filter((row) => row !== retained))
          await transaction
            .delete(schema.sessionHealthKitWorkouts)
            .where(
              and(
                eq(schema.sessionHealthKitWorkouts.sessionId, row.sessionId),
                eq(schema.sessionHealthKitWorkouts.userId, row.userId),
              ),
            );
        if (retained.userId !== context.survivorUserId)
          await transaction
            .update(schema.sessionHealthKitWorkouts)
            .set({ userId: context.survivorUserId })
            .where(
              and(
                eq(schema.sessionHealthKitWorkouts.sessionId, retained.sessionId),
                eq(schema.sessionHealthKitWorkouts.userId, retained.userId),
              ),
            );
      }
      // Repair anchors even when the inferred session did not need a session merge.
      for (const merge of context.group.tickMerges)
        await transaction
          .update(schema.boardSessions)
          .set({ anchorTickId: Number(merge.retainedId) })
          .where(
            and(
              eq(schema.boardSessions.anchorTickId, Number(merge.retiredId)),
              eq(schema.boardSessions.origin, 'inferred'),
            ),
          );
      return {
        sessionsReassigned: sessions.filter((session) => context.sourceUserIds.includes(session.createdByUserId ?? ''))
          .length,
        inferredSessionsMerged: instructions.reduce((total, instruction) => total + instruction.retiredIds.length, 0),
        participantRows: participants.length,
        healthKitRows: health.length,
      };
    },
  };
}
