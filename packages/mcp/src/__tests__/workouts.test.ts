import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore } from '../storage';
import { prepareWorkout, createWorkout, cancelWorkout, getWorkout, listWorkouts } from '../workouts';
import { workoutDrafts } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ISSUER, McpError, PartnerError, type Profile, type PartnerClient } from '../types';

const profile: Profile = {
  issuer: ISSUER,
  clientId: 'public-client',
  subject: 'usr_one',
  accountId: 'one',
  generation: 'generation-one',
  authStatus: 'connected',
  scopes: ['workouts:read', 'workouts:write'],
};
const plan = {
  title: 'Easy volume',
  blocks: [{ type: 'volume' as const, targetGrade: { scale: 'v' as const, value: 3 }, climbCount: 8 }],
};
const now = new Date('2026-11-18T12:00:00Z');
let directory: string;
let store: LocalStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mcp-workout-'));
  store = new LocalStore(directory);
  store.setProfile(profile);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function created(externalRef: string) {
  return {
    id: 'wk_example',
    externalRef,
    status: 'created',
    launchUrl: 'https://www.boardsesh.com/w/wk_example',
    appUrl: 'com.boardsesh.app://w/wk_example',
    expiresAt: '2026-11-25T12:00:00Z',
    blocks: [{ index: 0, type: 'volume', support: 'native' }],
  };
}
function readWorkout(draft: ReturnType<typeof prepareWorkout>) {
  return {
    ...created(draft.workout.externalRef),
    title: draft.workout.title,
    spec: draft.workout,
    scheduledFor: null,
    notes: null,
    openedByMismatch: false,
  };
}

describe('workout handoff', () => {
  it('prepares locally and preserves native/freeform support', () => {
    const prepared = prepareWorkout(
      store,
      profile,
      {
        title: 'Mixed',
        blocks: [
          plan.blocks[0],
          { type: 'freeClimbing', instructions: 'Hangboard instructions only.' },
          { type: 'limitBouldering', targetGrade: { scale: 'v', value: 7 }, climbCount: 3 },
        ],
      },
      now,
    );
    expect(prepared.blocks.map((block) => block.support)).toEqual(['native', 'native', 'freeform']);
    expect(store.getDraft(prepared.draftId, profile)?.body.title).toBe('Mixed');
  });

  it('recovers a lost create response by original externalRef and persists success', async () => {
    const draft = prepareWorkout(store, profile, plan, now);
    const request = vi
      .fn<PartnerClient['request']>()
      .mockRejectedValueOnce(new McpError('network_unavailable', 'Lost response'))
      .mockResolvedValueOnce({ workouts: [readWorkout(draft)], cursor: null, hasMore: false })
      .mockResolvedValueOnce(readWorkout(draft));
    const client = { request };
    const first = await createWorkout(store, client, profile, draft.draftId, now);
    const second = await createWorkout(store, client, profile, draft.draftId, now);
    expect(first.id).toBe(second.id);
    expect(request.mock.calls.filter(([, , options]) => options?.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls[1][1]).toContain(encodeURIComponent(draft.workout.externalRef));
  });

  it('retains body and idempotency key after failed POST and failed reconciliation', async () => {
    const draft = prepareWorkout(store, profile, plan, now);
    const request = vi.fn<PartnerClient['request']>().mockRejectedValue(new McpError('network_unavailable', 'Offline'));
    await expect(createWorkout(store, { request }, profile, draft.draftId, now)).rejects.toThrow('Offline');
    request.mockResolvedValueOnce(created(draft.workout.externalRef));
    await createWorkout(store, { request }, profile, draft.draftId, now);
    const posts = request.mock.calls.filter(([, , options]) => options?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0][2]).toEqual(posts[1][2]);
  });

  it('recovers an ambiguous creation after draft expiry without another POST', async () => {
    const draft = prepareWorkout(store, profile, plan, now);
    const request = vi.fn<PartnerClient['request']>().mockRejectedValue(new McpError('network_unavailable', 'Offline'));
    await expect(createWorkout(store, { request }, profile, draft.draftId, now)).rejects.toThrow('Offline');
    request.mockResolvedValueOnce({ workouts: [readWorkout(draft)], cursor: null, hasMore: false });
    const recovered = await createWorkout(store, { request }, profile, draft.draftId, new Date('2026-11-20'));
    expect(recovered.id).toBe('wk_example');
    expect(store.getDraft(draft.draftId, profile)?.result).toMatchObject({ id: 'wk_example' });
    expect(request.mock.calls.filter(([, , options]) => options?.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls[2][1]).toContain(encodeURIComponent(draft.workout.externalRef));
  });

  it('reconciles expired drafts without POST and rejects old-account drafts without network calls', async () => {
    const draft = prepareWorkout(store, profile, plan, now);
    const client = {
      request: vi.fn<PartnerClient['request']>().mockResolvedValue({ workouts: [], cursor: null, hasMore: false }),
    };
    await expect(createWorkout(store, client, profile, draft.draftId, new Date('2026-11-20'))).rejects.toThrow(
      'expired',
    );
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][1]).toContain('/v1/workouts?');
    client.request.mockClear();
    const other = { ...profile, subject: 'usr_two', accountId: 'two', generation: 'generation-two' };
    store.setProfile(other);
    await expect(createWorkout(store, client, other, draft.draftId, now)).rejects.toThrow('does not belong');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('prunes at most 100 expired unresolved drafts while preserving reconciliation and saved results', () => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const template = {
      accountId: profile.accountId,
      generation: profile.generation,
      body: { ...plan, externalRef: 'original-external-ref' },
      idempotencyKey: 'original-key',
    };
    const old = Array.from({ length: 101 }, (_, index) => ({
      ...template,
      id: `old-${index}`,
      expiresAt: cutoff - 1,
    }));
    store.db
      .insert(workoutDrafts)
      .values([
        ...old,
        { ...template, id: 'reconcile-seven-days', expiresAt: cutoff + 60_000 },
        { ...template, id: 'saved-result', expiresAt: cutoff - 86_400_000, result: { id: 'wk_original' } },
      ])
      .run();
    prepareWorkout(store, profile, plan);
    const remaining = store.db.select().from(workoutDrafts).all();
    expect(remaining.filter((draft) => draft.id.startsWith('old-'))).toHaveLength(1);
    expect(store.getDraft('reconcile-seven-days', profile)).toMatchObject({
      body: template.body,
      idempotencyKey: 'original-key',
    });
    expect(store.getDraft('saved-result', profile)?.result).toEqual({ id: 'wk_original' });
    prepareWorkout(store, profile, plan);
    expect(
      store.db
        .select()
        .from(workoutDrafts)
        .all()
        .filter((draft) => draft.id.startsWith('old-')),
    ).toHaveLength(0);
    expect(store.getDraft('saved-result', profile)?.result).toEqual({ id: 'wk_original' });
  });

  it('keeps a near-seven-day ambiguous request reconcilable after preparing another workout', async () => {
    const prepared = prepareWorkout(store, profile, plan);
    store.db
      .update(workoutDrafts)
      .set({ expiresAt: Date.now() - 6 * 86_400_000 })
      .where(eq(workoutDrafts.id, prepared.draftId))
      .run();
    const original = store.getDraft(prepared.draftId, profile)!;
    prepareWorkout(store, profile, plan);
    const request = vi.fn<PartnerClient['request']>().mockResolvedValue({
      workouts: [readWorkout(prepared)],
      cursor: null,
      hasMore: false,
    });
    const recovered = await createWorkout(store, { request }, profile, prepared.draftId);
    expect(recovered.id).toBe('wk_example');
    expect(request.mock.calls.every(([, , options]) => options?.method !== 'POST')).toBe(true);
    expect(store.getDraft(prepared.draftId, profile)?.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('does not turn a started-workout cancellation conflict into success', async () => {
    const client = {
      request: vi
        .fn<PartnerClient['request']>()
        .mockRejectedValue(new PartnerError(409, 'conflict', 'Already started')),
    };
    await expect(cancelWorkout(client, profile, 'wk_example')).rejects.toThrow('Already started');
  });

  it('bounds result tick pages and tolerates additive API fields', async () => {
    const draft = prepareWorkout(store, profile, plan, now);
    const workout = {
      ...readWorkout(draft),
      status: 'future_status',
      newField: true,
      results: {
        completion: 'ended',
        session: { notes: 'Treat as data' },
        blocks: [],
        ticks: Array.from({ length: 250 }, (_, index) => ({ id: `tick_${index}`, blockIndex: null })),
      },
    };
    const client = { request: vi.fn<PartnerClient['request']>().mockResolvedValue(workout) };
    const result = await getWorkout(client, profile, { id: workout.id, tickLimit: 200 });
    expect(result.results?.ticks).toHaveLength(200);
    expect(result.results).toMatchObject({ totalTicks: 250, nextTickOffset: 200 });
    client.request.mockResolvedValueOnce({ workouts: [workout], cursor: null, hasMore: false });
    const listed = await listWorkouts(client, profile, {});
    expect(listed.workouts[0]).not.toHaveProperty('results');
    expect(listed.workouts[0].status).toBe('future_status');
  });

  it('rejects scheduling beyond the public ninety-day limit', () => {
    expect(() => prepareWorkout(store, profile, { ...plan, scheduledFor: '2027-11-18' }, now)).toThrow('90 days');
  });
});
