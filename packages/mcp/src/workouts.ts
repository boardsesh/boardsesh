import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BOARD_TYPES, CreateWorkoutSchema, workoutBlockSupport } from '@boardsesh/public-api';
import type { LocalStore } from './storage';
import { McpError, PartnerError, type PartnerClient, type Profile } from './types';

// Unlike the server contract's extensible custom enum, a request must have a
// concrete JSON Schema for MCP clients to discover.
export const PrepareWorkoutSchema = CreateWorkoutSchema.omit({ externalRef: true })
  .extend({
    preferredBoard: z
      .object({ type: z.enum(BOARD_TYPES), angle: z.number().int().min(0).max(90).optional() })
      .optional(),
  })
  .strict();

const BlockSupport = z.object({ index: z.number().int(), type: z.string(), support: z.string() });
const CreatedWorkout = z.object({
  id: z.string().min(1),
  externalRef: z.string(),
  status: z.string(),
  launchUrl: z.url(),
  appUrl: z.string(),
  expiresAt: z.iso.datetime(),
  blocks: z.array(BlockSupport),
});
const Workout = CreatedWorkout.extend({
  title: z.string(),
  scheduledFor: z.string().nullable(),
  notes: z.string().nullable(),
  spec: z.record(z.string(), z.unknown()),
  openedByMismatch: z.boolean(),
  results: z
    .object({
      completion: z.string(),
      session: z.record(z.string(), z.unknown()),
      ticks: z.array(z.record(z.string(), z.unknown())).max(50_000),
      blocks: z.array(z.record(z.string(), z.unknown())).max(12),
    })
    .optional(),
});
const WorkoutList = z.object({
  workouts: z.array(Workout).max(100),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export const ListWorkoutsSchema = z.object({
  externalRef: z.string().min(1).max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const GetWorkoutSchema = z.object({
  id: z.string().min(1).max(200),
  tickOffset: z.number().int().min(0).max(50_000).default(0),
  tickLimit: z.number().int().min(1).max(200).default(50),
});

export function requireScope(profile: Profile, scope: string): void {
  if (!profile.scopes.includes(scope))
    throw new McpError('insufficient_scope', `Reconnect with ${scope} to use this tool.`);
}

export function prepareWorkout(
  store: LocalStore,
  profile: Profile,
  input: z.input<typeof PrepareWorkoutSchema>,
  now = new Date(),
) {
  requireScope(profile, 'workouts:write');
  store.assertProfile(profile.generation);
  const spec = PrepareWorkoutSchema.parse(input);
  if (
    spec.scheduledFor &&
    Date.parse(`${spec.scheduledFor}T00:00:00Z`) >
      Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + 90 * 86_400_000
  ) {
    throw new McpError('invalid_workout', 'Workouts can be scheduled at most 90 days ahead.');
  }
  const draft = {
    id: randomUUID(),
    accountId: profile.accountId,
    generation: profile.generation,
    body: CreateWorkoutSchema.parse({ ...spec, externalRef: `mcp_${randomUUID()}` }),
    idempotencyKey: randomUUID(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
  store.putDraft(draft);
  return {
    draftId: draft.id,
    expiresAt: draft.expiresAt,
    workout: draft.body,
    blocks: draft.body.blocks.map((block, index) => ({ index, type: block.type, support: workoutBlockSupport(block) })),
    instructions:
      'Show the plan and any freeform blocks. Resolve unclear screenshot details before creating it. Creating requires an online connection; Boardsesh starts the workout only when the climber presses Start.',
  };
}

export async function createWorkout(
  store: LocalStore,
  client: PartnerClient,
  profile: Profile,
  draftId: string,
  now = new Date(),
) {
  requireScope(profile, 'workouts:write');
  const draft = store.getDraft(draftId, profile);
  if (!draft)
    throw new McpError(
      'draft_not_found',
      'This draft does not belong to the connected account. Prepare the workout again.',
    );
  // Even a saved success is verified online: an old response is not proof that
  // a connection remains usable or that the workout has not been cancelled.
  if (draft.result !== undefined) {
    const saved = CreatedWorkout.parse(draft.result);
    requireScope(profile, 'workouts:read');
    return CreatedWorkout.parse(await client.request(profile, `/v1/workouts/${encodeURIComponent(saved.id)}`));
  }
  const reconcile = async () => {
    requireScope(profile, 'workouts:read');
    const found = WorkoutList.parse(
      await client.request(
        profile,
        `/v1/workouts?${new URLSearchParams({ externalRef: draft.body.externalRef, limit: '1' })}`,
      ),
    );
    const existing = found.workouts.find((workout) => workout.externalRef === draft.body.externalRef);
    if (!existing) return undefined;
    if (JSON.stringify(CreateWorkoutSchema.parse(existing.spec)) !== JSON.stringify(draft.body)) {
      throw new McpError(
        'workout_conflict',
        'The external reference names a different plan. No new workout was created.',
      );
    }
    return CreatedWorkout.parse(existing);
  };
  if (Date.parse(draft.expiresAt) <= now.getTime()) {
    // Expiry forbids new POSTs, but a previous POST may have committed before
    // its response was lost. Resolve that original identity before replacing it.
    const existing = await reconcile();
    if (!existing)
      throw new McpError(
        'draft_expired',
        'This draft expired and no existing workout was found. Prepare a new workout.',
      );
    store.saveDraftResult(draft.id, profile, existing);
    return existing;
  }
  let created: z.infer<typeof CreatedWorkout>;
  try {
    created = CreatedWorkout.parse(
      await client.request(profile, '/v1/workouts', {
        method: 'POST',
        body: draft.body,
        idempotencyKey: draft.idempotencyKey,
      }),
    );
  } catch (error) {
    // The original POST may have committed even if its response was lost.
    // Read by the original externalRef; never generate a replacement identity.
    const uncertain = !(error instanceof PartnerError) || error.status >= 500 || error.status === 409;
    if (!uncertain || !profile.scopes.includes('workouts:read')) throw error;
    const existing = await reconcile();
    if (!existing) throw error;
    created = existing;
  }
  store.assertProfile(profile.generation);
  store.saveDraftResult(draft.id, profile, created);
  return created;
}

export async function listWorkouts(client: PartnerClient, profile: Profile, input: z.input<typeof ListWorkoutsSchema>) {
  requireScope(profile, 'workouts:read');
  const query = ListWorkoutsSchema.parse(input);
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.externalRef) params.set('externalRef', query.externalRef);
  if (query.cursor) params.set('cursor', query.cursor);
  const response = WorkoutList.parse(await client.request(profile, `/v1/workouts?${params}`));
  return { ...response, workouts: response.workouts.map(({ spec: _spec, results: _results, ...workout }) => workout) };
}

export async function getWorkout(client: PartnerClient, profile: Profile, input: z.input<typeof GetWorkoutSchema>) {
  requireScope(profile, 'workouts:read');
  const query = GetWorkoutSchema.parse(input);
  const workout = Workout.parse(await client.request(profile, `/v1/workouts/${encodeURIComponent(query.id)}`));
  if (!workout.results) return workout;
  const ticks = workout.results.ticks;
  const nextOffset = query.tickOffset + query.tickLimit;
  return {
    ...workout,
    results: {
      ...workout.results,
      ticks: ticks.slice(query.tickOffset, nextOffset),
      totalTicks: ticks.length,
      nextTickOffset: nextOffset < ticks.length ? nextOffset : null,
    },
    attribution:
      'blockIndex is inferred and may be null. Tick pages reflect current results; edits between requests may change their positions. No effort or rest-adherence measurement is implied.',
  };
}

export async function cancelWorkout(client: PartnerClient, profile: Profile, id: string) {
  requireScope(profile, 'workouts:write');
  await client.request(profile, `/v1/workouts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { id, status: 'cancelled' };
}
