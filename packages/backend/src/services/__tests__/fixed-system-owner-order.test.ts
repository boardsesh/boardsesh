import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { FixedSystemOwnerTransaction } from '@boardsesh/db/fixed-system-owner-order';
import {
  captureFixedSystemOwnerOrderMode,
  lockCooperativeFixedSystemOwnerTransaction,
} from '../fixed-system-owner-order';

function fakeTransaction(acquired: boolean) {
  let queries = 0;
  const transaction = {
    rollback: () => {
      throw new Error('Only the caller may roll back.');
    },
    execute: async () => {
      queries += 1;
      return [{ acquired }];
    },
  } as unknown as FixedSystemOwnerTransaction;
  return { transaction, queryCount: () => queries };
}

function fixtureMutation(selector: string | undefined, acquired: boolean) {
  const { transaction, queryCount } = fakeTransaction(acquired);
  let writes = 0;
  const yoga = createYoga({
    schema: makeExecutableSchema({
      typeDefs: 'type Query { ready: Boolean! } type Mutation { update: Boolean! }',
      resolvers: {
        Query: { ready: () => true },
        Mutation: {
          update: async () => {
            const mode = captureFixedSystemOwnerOrderMode({ CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE: selector });
            await lockCooperativeFixedSystemOwnerTransaction(transaction, mode);
            writes += 1;
            return true;
          },
        },
      },
    }),
    logging: false,
    maskedErrors: false,
  });
  return {
    queryCount,
    writeCount: () => writes,
    request: () =>
      yoga.fetch('http://owned-fixture/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'mutation { update }' }),
      }),
  };
}

describe('fixed system-owner GraphQL boundary', () => {
  it('rejects unknown configuration with a fixed unavailable error', () => {
    let observed: unknown;
    try {
      captureFixedSystemOwnerOrderMode({ CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE: 'private-invalid-selector' });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(GraphQLError);
    const failure = observed as GraphQLError;
    expect(failure.extensions).toEqual({ code: 'SERVICE_UNAVAILABLE', http: { status: 503 } });
    expect(failure.message).not.toContain('private-invalid-selector');
    expect(failure.originalError).toBeUndefined();
  });

  it('maps contention without owning rollback or replay', async () => {
    const { transaction, queryCount } = fakeTransaction(false);
    await expect(lockCooperativeFixedSystemOwnerTransaction(transaction, 'cooperative-staging')).rejects.toMatchObject({
      extensions: { code: 'SERVICE_UNAVAILABLE', http: { status: 503 } },
    });
    expect(queryCount()).toBe(1);
  });

  it('preserves an unrelated driver failure for the existing database boundary', async () => {
    const failure = new Error('fixture driver failure');
    const transaction = {
      rollback: () => undefined,
      execute: async () => {
        throw failure;
      },
    } as unknown as FixedSystemOwnerTransaction;
    await expect(lockCooperativeFixedSystemOwnerTransaction(transaction, 'cooperative-staging')).rejects.toBe(failure);
  });

  it('returns HTTP 503 for contention before a mutation can write', async () => {
    const fixture = fixtureMutation('cooperative-staging', false);
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'SERVICE_UNAVAILABLE' } }] });
    expect(fixture.queryCount()).toBe(1);
    expect(fixture.writeCount()).toBe(0);
  });

  it('returns HTTP 503 for invalid configuration without SQL or writes', async () => {
    const fixture = fixtureMutation('typo', true);
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'SERVICE_UNAVAILABLE' } }] });
    expect(fixture.queryCount()).toBe(0);
    expect(fixture.writeCount()).toBe(0);
  });

  it('keeps default-off mutation behavior without taking the new key', async () => {
    const fixture = fixtureMutation(undefined, false);
    const response = await fixture.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { update: true } });
    expect(fixture.queryCount()).toBe(0);
    expect(fixture.writeCount()).toBe(1);
  });
});
