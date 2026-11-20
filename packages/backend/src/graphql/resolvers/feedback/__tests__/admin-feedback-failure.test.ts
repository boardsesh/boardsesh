import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { captureException } from '@sentry/node';
import { maskDatabaseError } from '../../../mask-error';
import { feedbackQueries } from '../queries';

const { attempted } = vi.hoisted(() => ({ attempted: vi.fn() }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
vi.mock('../../social/roles', () => ({ requireAdmin: vi.fn() }));
vi.mock('../../../../db/client', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  return {
    db: drizzle(async (query, params) => {
      attempted(query, params);
      if (query.includes('count(*)')) throw new Error('Synthetic test driver outage');
      return { rows: [] };
    }),
  };
});

describe('private admin feedback read failures', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['all', 'board_requests'])(
    'rejects a failed %s count without sending bound search data to Sentry',
    async (type) => {
      const marker = 'private-board-search-fixture';
      let failure: unknown;
      try {
        await feedbackQueries.adminAppFeedback(null, { input: { type, search: marker } }, {} as ConnectionContext);
      } catch (error) {
        failure = error;
      }
      expect(
        attempted.mock.calls.some(
          ([query, params]) => query.includes('count(*)') && params.includes('%' + marker + '%'),
        ),
      ).toBe(true);
      expect(failure).toBeInstanceOf(GraphQLError);
      const masked = maskDatabaseError(failure);
      expect(masked).toMatchObject({
        message: 'Feedback reports are temporarily unavailable.',
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
      expect(captureException).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'Admin feedback read failed' }),
      );
      expect(vi.mocked(captureException).mock.calls[0][0]).not.toHaveProperty('cause');
      expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain(marker);
    },
  );
});
