import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  CreateWorkoutSchema,
  WorkoutCreatedSchema,
  WorkoutResponseSchema,
  WorkoutStatusSchema,
  WorkoutPlanSchema,
  workoutBlockSupport,
  type CreateWorkout,
  type WorkoutCreated,
  type WorkoutResponse,
  type WorkoutPlan,
} from '@boardsesh/public-api';
import { appWorkouts, appWorkoutRequests, boardSessions, boardSessionParticipants } from '@boardsesh/db/schema';
import { oauthClient } from '@boardsesh/db/schema/auth';
import { findPartnerApiPrincipal, type PartnerApiPrincipal } from '../../auth/partner/bearer';
import { PARTNER_RESOURCE } from '../../auth/partner/configuration';
import { lockPartnerConnection } from '../../auth/partner/locks';
import { ensurePartnerSubject } from '../../auth/partner/api-access';
import type { PartnerDatabase } from '../../auth/partner/tables';
import { runInPartnerTransaction } from '../../auth/partner/transaction';
import { buildWorkoutResults } from './workout-results';

export type AppWorkoutRow = typeof appWorkouts.$inferSelect;
export const UNFINISHED_WORKOUT_STATUSES = ['created', 'opened', 'started'];
/** Serialize attachment against End before enumerating workouts or taking user locks. */
export async function lockAppWorkoutSession(transaction: PartnerDatabase, sessionId: string): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(67341003, hashtext(${sessionId}))`);
}
export function canonicalWorkoutPlan(spec: CreateWorkout, plan: WorkoutPlan): WorkoutPlan {
  if (plan.some((block) => block.index >= spec.blocks.length))
    throw new AppWorkoutError(422, 'invalid_block', 'Plan index does not name a workout block.');
  const byIndex = new Map(plan.map((block) => [block.index, block.climbUuids]));
  return spec.blocks.map((_, index) => ({ index, climbUuids: [...new Set(byIndex.get(index) ?? [])].sort() }));
}

const DAY_MS = 86_400_000;
export class AppWorkoutError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'invalid_token'
      | 'not_found'
      | 'conflict'
      | 'workout_limit'
      | 'invalid_block'
      | 'idempotency_mismatch'
      | 'insufficient_scope',
    message: string,
    readonly existing?: WorkoutCreated,
    readonly field?: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export function workoutExpiresAt(spec: CreateWorkout, now: Date): Date {
  const minimum = now.getTime() + 7 * DAY_MS;
  return new Date(
    Math.max(minimum, spec.scheduledFor ? Date.parse(`${spec.scheduledFor}T00:00:00Z`) + 2 * DAY_MS : minimum),
  );
}

export function presentCreatedWorkout(workout: AppWorkoutRow): WorkoutCreated {
  const spec = CreateWorkoutSchema.parse(workout.spec);
  return WorkoutCreatedSchema.parse({
    id: workout.id,
    externalRef: workout.externalRef,
    status: WorkoutStatusSchema.parse(workout.status),
    launchUrl: `https://www.boardsesh.com/w/${workout.id}`,
    appUrl: `com.boardsesh.app://w/${workout.id}`,
    expiresAt: workout.expiresAt.toISOString(),
    blocks: spec.blocks.map((block, index) => ({
      index,
      type: block.type,
      support: workoutBlockSupport(block),
      ...(block.externalRef === undefined ? {} : { externalRef: block.externalRef }),
    })),
  });
}

/** All REST operations revalidate issuance under the same connection lock as Disconnect. */
async function lockPrincipal(
  transaction: PartnerDatabase,
  principal: PartnerApiPrincipal,
  scope: string,
  resource = PARTNER_RESOURCE,
): Promise<void> {
  const connection = await lockPartnerConnection(transaction, principal.userId, principal.clientId);
  if (
    !connection ||
    connection.id !== principal.connectionId ||
    connection.generation !== principal.connectionGeneration ||
    connection.revokedAt
  )
    throw new AppWorkoutError(401, 'invalid_token', 'The app connection ended.');
  const current = await findPartnerApiPrincipal(transaction, { accessTokenHash: principal.accessTokenHash, resource });
  if (!current.principal) throw new AppWorkoutError(401, 'invalid_token', 'The access token is no longer valid.');
  if (!current.principal.scopes.includes(scope))
    throw new AppWorkoutError(403, 'insufficient_scope', `This call needs ${scope}.`);
}

async function refreshExpiry(transaction: PartnerDatabase, workout: AppWorkoutRow, now: Date): Promise<AppWorkoutRow> {
  if ((workout.status === 'created' || workout.status === 'opened') && workout.expiresAt <= now) {
    const [expired] = await transaction
      .update(appWorkouts)
      .set({ status: 'expired' })
      .where(and(eq(appWorkouts.id, workout.id), inArray(appWorkouts.status, ['created', 'opened'])))
      .returning();
    return expired ?? workout;
  }
  return workout;
}

export async function createPartnerWorkout(
  database: PartnerDatabase,
  principal: PartnerApiPrincipal,
  spec: CreateWorkout,
  key: string,
  now = new Date(),
  resource = PARTNER_RESOURCE,
): Promise<WorkoutCreated> {
  if (
    spec.scheduledFor &&
    Date.parse(`${spec.scheduledFor}T00:00:00Z`) >
      Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + 90 * DAY_MS
  )
    throw new AppWorkoutError(
      422,
      'invalid_block',
      'scheduledFor must be at most 90 days away.',
      undefined,
      'scheduledFor',
    );
  const bodyHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  return runInPartnerTransaction(database, async (transaction) => {
    await lockPrincipal(transaction, principal, 'workouts:write', resource);
    await ensurePartnerSubject(transaction, principal.userId, principal.clientId);
    const requestIdentity = and(
      eq(appWorkoutRequests.clientId, principal.clientId),
      eq(appWorkoutRequests.userId, principal.userId),
      eq(appWorkoutRequests.key, key),
    );
    const [previous] = await transaction.select().from(appWorkoutRequests).where(requestIdentity);
    if (previous && previous.expiresAt > now && previous.connectionGeneration === principal.connectionGeneration) {
      if (previous.bodyHash !== bodyHash)
        throw new AppWorkoutError(422, 'idempotency_mismatch', 'This Idempotency-Key was used with another body.');
      return WorkoutCreatedSchema.parse(previous.response);
    }
    const [duplicate] = await transaction
      .select()
      .from(appWorkouts)
      .where(
        and(
          eq(appWorkouts.clientId, principal.clientId),
          eq(appWorkouts.userId, principal.userId),
          eq(appWorkouts.externalRef, spec.externalRef),
        ),
      );
    if (duplicate)
      throw new AppWorkoutError(
        409,
        'conflict',
        'externalRef already names a workout. Use a new reference for a replacement.',
        presentCreatedWorkout(duplicate),
      );
    await transaction
      .update(appWorkouts)
      .set({ status: 'expired' })
      .where(
        and(
          eq(appWorkouts.clientId, principal.clientId),
          eq(appWorkouts.userId, principal.userId),
          inArray(appWorkouts.status, ['created', 'opened']),
          lte(appWorkouts.expiresAt, now),
        ),
      );
    const [unfinished] = await transaction
      .select({ total: count() })
      .from(appWorkouts)
      .where(
        and(
          eq(appWorkouts.clientId, principal.clientId),
          eq(appWorkouts.userId, principal.userId),
          inArray(appWorkouts.status, UNFINISHED_WORKOUT_STATUSES),
        ),
      );
    if ((unfinished?.total ?? 0) >= 20)
      throw new AppWorkoutError(409, 'workout_limit', 'This climber already has 20 unfinished workouts from this app.');
    const [created] = await transaction
      .insert(appWorkouts)
      .values({
        id: `wk_${randomBytes(16).toString('base64url')}`,
        clientId: principal.clientId,
        userId: principal.userId,
        connectionId: principal.connectionId,
        connectionGeneration: principal.connectionGeneration,
        externalRef: spec.externalRef,
        title: spec.title,
        spec,
        expiresAt: workoutExpiresAt(spec, now),
      })
      .returning();
    const response = presentCreatedWorkout(created);
    await transaction
      .insert(appWorkoutRequests)
      .values({
        clientId: principal.clientId,
        userId: principal.userId,
        key,
        bodyHash,
        response,
        connectionGeneration: principal.connectionGeneration,
        expiresAt: new Date(now.getTime() + DAY_MS),
      })
      .onConflictDoUpdate({
        target: [appWorkoutRequests.clientId, appWorkoutRequests.userId, appWorkoutRequests.key],
        set: {
          bodyHash,
          response,
          connectionGeneration: principal.connectionGeneration,
          expiresAt: new Date(now.getTime() + DAY_MS),
        },
      });
    return response;
  });
}

async function presentWorkout(transaction: PartnerDatabase, workout: AppWorkoutRow): Promise<WorkoutResponse> {
  const spec = CreateWorkoutSchema.parse(workout.spec);
  const results =
    workout.status === 'completed' || workout.status === 'auto_closed'
      ? await buildWorkoutResults(transaction, workout)
      : undefined;
  return WorkoutResponseSchema.parse({
    ...presentCreatedWorkout(workout),
    title: workout.title,
    scheduledFor: spec.scheduledFor ?? null,
    notes: spec.notes ?? null,
    spec,
    openedByMismatch: workout.openedByMismatch,
    ...(results ? { results } : {}),
  });
}

export async function readPartnerWorkout(
  database: PartnerDatabase,
  principal: PartnerApiPrincipal,
  id: string,
  resource = PARTNER_RESOURCE,
): Promise<WorkoutResponse> {
  return runInPartnerTransaction(database, async (transaction) => {
    await lockPrincipal(transaction, principal, 'workouts:read', resource);
    const [workout] = await transaction
      .select()
      .from(appWorkouts)
      .where(
        and(
          eq(appWorkouts.id, id),
          eq(appWorkouts.clientId, principal.clientId),
          eq(appWorkouts.userId, principal.userId),
        ),
      );
    if (!workout) throw new AppWorkoutError(404, 'not_found', 'No workout exists for this app and climber.');
    return presentWorkout(transaction, await refreshExpiry(transaction, workout, new Date()));
  });
}

export async function listPartnerWorkouts(
  database: PartnerDatabase,
  principal: PartnerApiPrincipal,
  query: { externalRef?: string; limit: number; cursor?: string },
  resource = PARTNER_RESOURCE,
): Promise<{ workouts: WorkoutResponse[]; cursor: string | null; hasMore: boolean }> {
  await runInPartnerTransaction(database, async (transaction) => {
    await lockPrincipal(transaction, principal, 'workouts:read', resource);
    await transaction
      .update(appWorkouts)
      .set({ status: 'expired' })
      .where(
        and(
          eq(appWorkouts.clientId, principal.clientId),
          eq(appWorkouts.userId, principal.userId),
          inArray(appWorkouts.status, ['created', 'opened']),
          lte(appWorkouts.expiresAt, new Date()),
        ),
      );
  });
  // All page rows, ticks, boards and plans share a snapshot without holding
  // the connection fence that Disconnect, refresh and session End need.
  const selected = await runInPartnerTransaction(
    database,
    async (transaction) => {
      const rows = await transaction
        .select()
        .from(appWorkouts)
        .where(
          and(
            eq(appWorkouts.clientId, principal.clientId),
            eq(appWorkouts.userId, principal.userId),
            query.externalRef ? eq(appWorkouts.externalRef, query.externalRef) : undefined,
            query.cursor ? gt(appWorkouts.id, query.cursor) : undefined,
          ),
        )
        .orderBy(asc(appWorkouts.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const workouts: WorkoutResponse[] = [];
      for (const row of page) workouts.push(await presentWorkout(transaction, row));
      return {
        workouts,
        cursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > query.limit,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  // Reject a token, scope or connection generation revoked during result work.
  await runInPartnerTransaction(database, (transaction) =>
    lockPrincipal(transaction, principal, 'workouts:read', resource),
  );
  return selected;
}

export async function cancelPartnerWorkout(
  database: PartnerDatabase,
  principal: PartnerApiPrincipal,
  id: string,
  resource = PARTNER_RESOURCE,
): Promise<void> {
  return runInPartnerTransaction(database, async (transaction) => {
    await lockPrincipal(transaction, principal, 'workouts:write', resource);
    const [workout] = await transaction
      .select()
      .from(appWorkouts)
      .where(
        and(
          eq(appWorkouts.id, id),
          eq(appWorkouts.clientId, principal.clientId),
          eq(appWorkouts.userId, principal.userId),
        ),
      )
      .for('update');
    if (!workout) throw new AppWorkoutError(404, 'not_found', 'No workout exists for this app and climber.');
    if (workout.status === 'cancelled') return;
    const current = await refreshExpiry(transaction, workout, new Date());
    if (current.status !== 'created' && current.status !== 'opened')
      throw new AppWorkoutError(409, 'conflict', 'Only an unstarted workout can be cancelled.');
    await transaction.update(appWorkouts).set({ status: 'cancelled' }).where(eq(appWorkouts.id, id));
  });
}

/** Lock order is user SHARE, connection UPDATE, workout UPDATE, then session UPDATE. */
export async function lockAppWorkoutForUser(
  transaction: PartnerDatabase,
  userId: string,
  id: string,
): Promise<AppWorkoutRow> {
  const [hint] = await transaction
    .select({ clientId: appWorkouts.clientId, userId: appWorkouts.userId })
    .from(appWorkouts)
    .where(eq(appWorkouts.id, id));
  if (!hint || hint.userId !== userId) throw new AppWorkoutError(404, 'not_found', 'Workout unavailable.');
  const connection = await lockPartnerConnection(transaction, userId, hint.clientId);
  const [workout] = await transaction
    .select()
    .from(appWorkouts)
    .where(and(eq(appWorkouts.id, id), eq(appWorkouts.userId, userId)))
    .for('update');
  const [app] = await transaction
    .select({ disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, hint.clientId));
  if (
    !workout ||
    !connection ||
    connection.revokedAt ||
    connection.generation !== workout.connectionGeneration ||
    !app ||
    app.disabled === true
  )
    throw new AppWorkoutError(409, 'conflict', 'The app connection is no longer active.');
  return refreshExpiry(transaction, workout, new Date());
}

export async function attachLockedAppWorkout(
  transaction: PartnerDatabase,
  workout: AppWorkoutRow,
  sessionId: string,
): Promise<void> {
  if (workout.status === 'started' && workout.sessionId === sessionId) return;
  if (workout.status !== 'created' && workout.status !== 'opened')
    throw new AppWorkoutError(409, 'conflict', 'This workout can no longer be started.');
  const [session] = await transaction.select().from(boardSessions).where(eq(boardSessions.id, sessionId)).for('update');
  if (!session || session.status === 'ended' || session.origin !== 'explicit')
    throw new AppWorkoutError(409, 'conflict', 'The session is no longer running.');
  if (session.isPermanent)
    throw new AppWorkoutError(
      409,
      'conflict',
      'Start a personal session to use this workout.',
      undefined,
      undefined,
      'APP_WORKOUT_PERMANENT_SESSION',
    );
  if (session.createdByUserId !== workout.userId) {
    const [member] = await transaction
      .select({ userId: boardSessionParticipants.userId })
      .from(boardSessionParticipants)
      .where(
        and(eq(boardSessionParticipants.sessionId, sessionId), eq(boardSessionParticipants.userId, workout.userId)),
      );
    if (!member) throw new AppWorkoutError(404, 'not_found', 'Session unavailable.');
  }
  const [existing] = await transaction
    .select({ id: appWorkouts.id })
    .from(appWorkouts)
    .where(and(eq(appWorkouts.sessionId, sessionId), eq(appWorkouts.userId, workout.userId)));
  if (existing && existing.id !== workout.id)
    throw new AppWorkoutError(409, 'conflict', 'This climber already attached a workout to this session.');
  await transaction
    .update(appWorkouts)
    .set({ status: 'started', sessionId, startedAt: new Date(), openedAt: workout.openedAt ?? new Date() })
    .where(eq(appWorkouts.id, workout.id));
}

export async function recordAppWorkoutPlan(
  transaction: PartnerDatabase,
  userId: string,
  id: string,
  input: unknown,
): Promise<void> {
  const requestedPlan = WorkoutPlanSchema.parse(input);
  const workout = await lockAppWorkoutForUser(transaction, userId, id);
  if (workout.status !== 'started')
    throw new AppWorkoutError(409, 'conflict', 'Start the workout before recording its plan.');
  const spec = CreateWorkoutSchema.parse(workout.spec);
  const plan = canonicalWorkoutPlan(spec, requestedPlan);
  // A retry can resend the snapshot; replacing it later could rewrite attribution.
  if (workout.planSnapshot !== null) {
    if (
      JSON.stringify(canonicalWorkoutPlan(spec, WorkoutPlanSchema.parse(workout.planSnapshot))) !== JSON.stringify(plan)
    )
      throw new AppWorkoutError(409, 'conflict', 'The started workout already has its plan.');
    return;
  }
  await transaction.update(appWorkouts).set({ planSnapshot: plan }).where(eq(appWorkouts.id, id));
}

/** Recover the initial attribution snapshot through the existing durable session-workout outbox. */
export async function recoverAppWorkoutPlan(
  transaction: PartnerDatabase,
  userId: string,
  sessionId: string,
  sessionPlan: { stages: ReadonlyArray<{ id: string; items: ReadonlyArray<{ climbUuid: string }> }> },
): Promise<void> {
  const [candidate] = await transaction
    .select({ id: appWorkouts.id })
    .from(appWorkouts)
    .where(
      and(
        eq(appWorkouts.sessionId, sessionId),
        eq(appWorkouts.userId, userId),
        isNull(appWorkouts.planSnapshot),
        inArray(appWorkouts.status, ['started', 'completed', 'auto_closed']),
      ),
    );
  if (!candidate) return;
  let workout: AppWorkoutRow;
  try {
    workout = await lockAppWorkoutForUser(transaction, userId, candidate.id);
  } catch (error) {
    if (error instanceof AppWorkoutError) return;
    throw error;
  }
  if (workout.planSnapshot !== null) return;
  const spec = CreateWorkoutSchema.parse(workout.spec);
  const plan: WorkoutPlan = sessionPlan.stages.flatMap((stage) => {
    const prefix = `${workout.id}:`;
    if (!stage.id.startsWith(prefix)) return [];
    const index = Number(stage.id.slice(prefix.length));
    return Number.isInteger(index) && index >= 0 && index < spec.blocks.length
      ? [{ index, climbUuids: [...new Set(stage.items.map((item) => item.climbUuid))] }]
      : [];
  });
  if (plan.length > 0)
    await transaction
      .update(appWorkouts)
      .set({ planSnapshot: canonicalWorkoutPlan(spec, WorkoutPlanSchema.parse(plan)) })
      .where(eq(appWorkouts.id, workout.id));
}

/** Stable fence for first Start and retries before choosing which session fence to take. */
export async function lockAppWorkoutStart(transaction: PartnerDatabase, id: string): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(67341004, hashtext(${id}))`);
}

export async function prepareAppWorkoutSessionStart(
  transaction: PartnerDatabase,
  userId: string,
  id: string,
  proposedSessionId: string,
): Promise<{ workout: AppWorkoutRow; existingSession: typeof boardSessions.$inferSelect | null }> {
  await lockAppWorkoutStart(transaction, id);
  const [hint] = await transaction
    .select({ status: appWorkouts.status, sessionId: appWorkouts.sessionId })
    .from(appWorkouts)
    .where(and(eq(appWorkouts.id, id), eq(appWorkouts.userId, userId)));
  const sessionId = hint?.status === 'started' && hint.sessionId ? hint.sessionId : proposedSessionId;
  await lockAppWorkoutSession(transaction, sessionId);
  const workout = await lockAppWorkoutForUser(transaction, userId, id);
  if (workout.status !== 'started') return { workout, existingSession: null };
  if (!workout.sessionId || workout.sessionId !== sessionId)
    throw new AppWorkoutError(409, 'conflict', 'The workout session changed. Try again.');
  const [session] = await transaction.select().from(boardSessions).where(eq(boardSessions.id, sessionId)).for('update');
  if (!session || session.status !== 'active' || session.origin !== 'explicit' || session.createdByUserId !== userId)
    throw new AppWorkoutError(409, 'conflict', 'The workout is no longer running in a session you started.');
  return { workout, existingSession: session };
}
