import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const fixtures = vi.hoisted(() => ({
  execute: vi.fn(),
  capture: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('graphql', async (importOriginal) => ({
  ...(await importOriginal<typeof import('graphql')>()),
  graphql: fixtures.execute,
}));
vi.mock('@sentry/node', () => ({ captureException: fixtures.capture }));
vi.mock('../../../graphql/index', () => ({ schema: {} }));
vi.mock('../../../utils/logger', () => ({ logger: { info: fixtures.info, warn: fixtures.warn } }));

import { executeGymDocument } from '../domain';
import { gymMcpToolFailure } from '../tool-result';

const context: ConnectionContext = {
  connectionId: 'test-gym-mcp',
  transport: 'http',
  userId: 'test-admin',
  isAuthenticated: true,
};

beforeEach(() => vi.clearAllMocks());

describe('gym MCP internal failure reporting', () => {
  it('reports a driver failure once without leaking SQL or arguments to the tool or logs', async () => {
    const driverError = Object.assign(new Error('private-driver-message'), { code: '23505' });
    const queryError = new Error('Failed query: private-sql-marker', { cause: driverError });
    fixtures.execute.mockResolvedValue({
      errors: [new GraphQLError(queryError.message, { originalError: queryError })],
    });
    let failure: unknown;
    try {
      await executeGymDocument('updateGym', { input: { name: 'private-input-marker' } }, context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GraphQLError);
    const result = gymMcpToolFailure(failure, 'update_gym_profile', performance.now());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(fixtures.capture).toHaveBeenCalledExactlyOnceWith(driverError, expect.any(Object));
    expect(fixtures.warn).toHaveBeenCalledExactlyOnceWith('Gym MCP database operation failed', {
      operation: 'updateGym',
      databaseCode: '23505',
    });
    expect(JSON.stringify([result, fixtures.info.mock.calls, fixtures.warn.mock.calls])).not.toContain('private-');
  });

  it('captures unexpected resolver exceptions while keeping their messages private', () => {
    const original = new TypeError('private-resolver-message');
    const failure = new GraphQLError(original.message, { originalError: original });
    const result = gymMcpToolFailure(failure, 'update_gym_profile');
    gymMcpToolFailure(failure, 'update_gym_profile');
    expect(fixtures.capture).toHaveBeenCalledOnce();
    expect(fixtures.capture).toHaveBeenCalledWith(failure, {
      tags: { source: 'gym-mcp', tool: 'update_gym_profile' },
    });
    expect(fixtures.warn).toHaveBeenCalledExactlyOnceWith('Gym MCP internal failure', {
      tool: 'update_gym_profile',
      errorType: 'TypeError',
    });
    expect(JSON.stringify([result, fixtures.warn.mock.calls])).not.toContain('private-');
  });

  it('reports receipt database failures without capturing the SQL-bearing wrapper', () => {
    const driverError = Object.assign(new Error('driver failure'), { code: '23503' });
    const failure = new Error(`Failed query: private-receipt-and-arguments${'x'.repeat(2100)}`, {
      cause: driverError,
    });
    const result = gymMcpToolFailure(failure, 'update_gym_profile');
    expect(fixtures.capture).toHaveBeenCalledExactlyOnceWith(driverError, expect.any(Object));
    expect(JSON.stringify([result, fixtures.warn.mock.calls])).not.toContain('private-');
    expect(fixtures.capture.mock.calls[0]![1].extra.failedQuery.length).toBeLessThanOrEqual(2000);
  });

  it('preserves expected permission failures without reporting an internal exception', () => {
    const result = gymMcpToolFailure(new GraphQLError('Gym access denied', { extensions: { code: 'FORBIDDEN' } }));
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: { code: 'FORBIDDEN', message: 'Gym access denied' },
    });
    expect(fixtures.capture).not.toHaveBeenCalled();
    expect(fixtures.warn).not.toHaveBeenCalled();
  });
});
