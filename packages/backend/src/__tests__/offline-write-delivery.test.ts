import { randomUUID } from 'node:crypto';
import { buildSchema, execute, GraphQLError, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionContext, OfflineWriteObservation } from '@boardsesh/shared-schema';
import {
  observeOfflineWriteResolver,
  parseOfflineWriteDeliveryId,
  parseOfflineWriteRelease,
} from '../graphql/offline-write-delivery';
import { offlineWriteBindingHash } from '../services/offline-write-delivery';
import { RecordOfflineWriteObservationsInputSchema } from '../validation/schemas/offline-write-delivery';

const deliveryId = '50000000-0000-4000-8000-000000000001';
const context: ConnectionContext = {
  connectionId: 'test',
  transport: 'http',
  isAuthenticated: true,
  userId: 'owner',
  offlineWriteDeliveryId: deliveryId,
};

async function runMutation(query: string, result: () => unknown, requestContext = context) {
  const schema = buildSchema('type Query { noop: Boolean } type Mutation { saveTick(uuid: ID!): ID }');
  const record = vi.fn().mockResolvedValue(undefined);
  schema.getMutationType()!.getFields().saveTick!.resolve = observeOfflineWriteResolver('saveTick', result, record);
  const response = await execute({ schema, document: parse(query), contextValue: requestContext });
  return { response, record };
}

describe('backend offline write evidence boundary', () => {
  it('records acceptance only after the business resolver resolves', async () => {
    const { response, record } = await runMutation('mutation { saveTick(uuid: "tick") }', () => 'tick');
    expect(response.errors).toBeUndefined();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', deliveryId, accepted: true }));
  });

  it('keeps a committed write successful when receipt storage fails', async () => {
    const schema = buildSchema('type Query { noop: Boolean } type Mutation { saveTick: ID! }');
    schema.getMutationType()!.getFields().saveTick!.resolve = observeOfflineWriteResolver(
      'saveTick',
      () => 'committed',
      vi.fn().mockRejectedValue(new Error('receipt database unavailable')),
    );
    const response = await execute({ schema, document: parse('mutation { saveTick }'), contextValue: context });
    expect(response.data?.saveTick).toBe('committed');
    expect(response.errors).toBeUndefined();
  });

  it('does not call a post-commit exception a server rejection', async () => {
    const { response, record } = await runMutation('mutation { saveTick(uuid: "tick") }', () => {
      throw new GraphQLError('post-commit notification unavailable', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
    });
    expect(response.errors).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('preserves an explicit pre-write rejection', async () => {
    const { response, record } = await runMutation('mutation { saveTick(uuid: "tick") }', () => {
      throw new GraphQLError('unknown climb', { extensions: { code: 'CLIMB_NOT_FOUND' } });
    });
    expect(response.errors).toHaveLength(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ accepted: false, rejectionCode: 'CLIMB_NOT_FOUND' }));
  });

  it('ignores multi-root operations, including aliases and fragments', async () => {
    for (const query of [
      'mutation { first: saveTick(uuid: "first") second: saveTick(uuid: "second") }',
      'mutation { ... Writes } fragment Writes on Mutation { saveTick(uuid: "tick") }',
    ]) {
      const { response, record } = await runMutation(query, () => 'tick');
      expect(response.errors).toBeUndefined();
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('does not attribute another transport or an anonymous request', async () => {
    for (const requestContext of [
      { ...context, transport: 'ws' as const },
      { ...context, isAuthenticated: false },
      { ...context, userId: undefined },
      { ...context, offlineWriteDeliveryId: undefined },
    ]) {
      const { record } = await runMutation('mutation { saveTick(uuid: "tick") }', () => 'tick', requestContext);
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('accepts one UUID header and ignores malformed or combined headers', () => {
    expect(parseOfflineWriteDeliveryId(deliveryId.toUpperCase())).toBe(deliveryId);
    expect(parseOfflineWriteDeliveryId(null)).toBeUndefined();
    expect(parseOfflineWriteDeliveryId(`${deliveryId},${randomUUID()}`)).toBeUndefined();
    expect(parseOfflineWriteDeliveryId('account-or-tick-id')).toBeUndefined();
  });

  it('binds stable targets while allowing corrected payloads, and isolates operations', () => {
    const original = offlineWriteBindingHash('saveTick', { input: { uuid: 'tick', status: 'send' } });
    expect(offlineWriteBindingHash('saveTick', { input: { status: 'send', uuid: 'tick' } })).toBe(original);
    expect(offlineWriteBindingHash('saveTick', { input: { status: 'flash', uuid: 'tick' } })).toBe(original);
    expect(offlineWriteBindingHash('saveTick', { input: { uuid: 'other', status: 'send' } })).not.toBe(original);
    expect(offlineWriteBindingHash('updateTick', { input: { uuid: 'tick', status: 'send' } })).not.toBe(original);
    expect(
      offlineWriteBindingHash('updateClimb', {
        input: { uuid: 'climb', boardType: 'spray', clientMutationId: 'repair', name: 'Corrected' },
      }),
    ).toBe(
      offlineWriteBindingHash('updateClimb', {
        input: { uuid: 'climb', boardType: 'spray', clientMutationId: 'original', name: 'Original' },
      }),
    );
    expect(
      offlineWriteBindingHash('saveClimb', { input: { uuid: 'climb', boardType: 'spray', name: 'Corrected' } }),
    ).toBe(offlineWriteBindingHash('saveClimb', { input: { uuid: 'climb', boardType: 'spray', name: 'Original' } }));
  });

  it('bounds and validates the replay runtime header independently of reporting runtime', () => {
    const release = {
      applicationId: 'com.boardsesh.app',
      platform: 'android',
      appVersion: '2.7.0',
      runtimeVersion: 'runtime',
      updateId: 'replay-bundle',
      isEmbedded: false,
      branch: 'production',
    };
    expect(parseOfflineWriteRelease(JSON.stringify(release))).toEqual(release);
    expect(parseOfflineWriteRelease(JSON.stringify({ ...release, applicationId: undefined }))).toEqual({
      ...release,
      applicationId: null,
    });
    expect(parseOfflineWriteRelease('broken')).toBeUndefined();
    expect(parseOfflineWriteRelease('x'.repeat(2049))).toBeUndefined();
    expect(parseOfflineWriteRelease(JSON.stringify({ ...release, userId: 'private' }))).toBeUndefined();
  });
});

export const observationFixture = (): OfflineWriteObservation => ({
  deliveryId: randomUUID(),
  tableName: 'boardsesh_ticks',
  operation: 'create',
  queuedAt: '2026-11-20T12:00:00.000Z',
  connectivityReason: 'device_offline',
  originRelease: {
    applicationId: 'com.boardsesh.app',
    platform: 'ios',
    appVersion: '2.7.0',
    runtimeVersion: 'runtime',
    updateId: 'ota',
    isEmbedded: false,
    branch: 'production',
  },
  state: 'pending',
  observedAt: '2026-11-21T12:00:00.000Z',
  revision: 1,
  recovered: false,
  serverResponseAt: null,
  reconciledAt: null,
  firstDeadLetterAt: null,
  lastDeadLetterAt: null,
});

describe('private observation validation', () => {
  it('rejects acceptance claims, raw payloads, and unbounded batches', () => {
    const observation = observationFixture();
    expect(
      RecordOfflineWriteObservationsInputSchema.safeParse({
        ownerUserId: 'owner',
        observations: [{ ...observation, serverAcceptedAt: observation.observedAt }],
      }).success,
    ).toBe(false);
    expect(
      RecordOfflineWriteObservationsInputSchema.safeParse({
        ownerUserId: 'owner',
        observations: [{ ...observation, payload: { comment: 'private' } }],
      }).success,
    ).toBe(false);
    expect(
      RecordOfflineWriteObservationsInputSchema.safeParse({
        ownerUserId: 'owner',
        observations: Array.from({ length: 101 }, observationFixture),
      }).success,
    ).toBe(false);
  });

  it('requires a timestamp for reconciliation and a supported table/operation pair', () => {
    expect(
      RecordOfflineWriteObservationsInputSchema.safeParse({
        ownerUserId: 'owner',
        observations: [{ ...observationFixture(), state: 'reconciled' }],
      }).success,
    ).toBe(false);
    expect(
      RecordOfflineWriteObservationsInputSchema.safeParse({
        ownerUserId: 'owner',
        observations: [{ ...observationFixture(), tableName: 'session_workouts', operation: 'delete' }],
      }).success,
    ).toBe(false);
  });
});
