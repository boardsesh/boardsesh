import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGraphQLClient } from '../create-client';

const mocks = vi.hoisted(() => ({
  capturedOptions: { current: {} as Record<string, unknown> },
}));

vi.mock('graphql-ws', () => ({
  createClient: (opts: Record<string, unknown>) => {
    mocks.capturedOptions.current = opts;
    return {
      on: () => () => {},
      subscribe: () => () => {},
      iterate: () => {
        throw new Error('not used');
      },
      dispose: vi.fn(async () => {}),
      terminate: () => {},
    };
  },
}));

describe('createGraphQLClient', () => {
  beforeEach(() => {
    mocks.capturedOptions.current = {};
  });

  it('passes static authToken as connectionParams object', () => {
    createGraphQLClient({ url: 'ws://localhost/graphql', authToken: 'tok123' });
    expect(mocks.capturedOptions.current.connectionParams).toEqual({ authToken: 'tok123' });
  });

  it('passes async connectionParams provider through', () => {
    const provider = vi.fn(async () => ({ authToken: 'dynamic' }));
    createGraphQLClient({ url: 'ws://localhost/graphql', connectionParams: provider });
    expect(mocks.capturedOptions.current.connectionParams).toBe(provider);
  });

  it('passes custom shouldRetry predicate', () => {
    const predicate = vi.fn(() => false);
    createGraphQLClient({ url: 'ws://localhost/graphql', shouldRetry: predicate });
    expect(mocks.capturedOptions.current.shouldRetry).toBe(predicate);
  });

  it('defaults shouldRetry to always-true', () => {
    createGraphQLClient({ url: 'ws://localhost/graphql' });
    expect((mocks.capturedOptions.current.shouldRetry as () => boolean)()).toBe(true);
  });

  it('omits connectionParams when neither authToken nor provider given', () => {
    createGraphQLClient({ url: 'ws://localhost/graphql' });
    expect(mocks.capturedOptions.current.connectionParams).toBeUndefined();
  });

  it('invokes onDisconnect from the graphql-ws closed handler', () => {
    const onDisconnect = vi.fn();
    createGraphQLClient({ url: 'ws://localhost/graphql', onDisconnect });

    const handlers = mocks.capturedOptions.current.on as { closed?: () => void };
    expect(handlers.closed).toBeTypeOf('function');
    expect(onDisconnect).not.toHaveBeenCalled();

    handlers.closed?.();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing onDisconnect when the connection closes', () => {
    createGraphQLClient({ url: 'ws://localhost/graphql' });
    const handlers = mocks.capturedOptions.current.on as { closed?: () => void };
    expect(() => handlers.closed?.()).not.toThrow();
  });
});
