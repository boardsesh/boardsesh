// setSessionRestCadence (#5382): the crew rest clock's one write path. Unlike
// the other party actions it hands transport errors back, because a FIRE that
// never landed must not move the wall.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { SET_SESSION_REST_CADENCE } from '@boardsesh/graphql/operations/queue-session';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: executeMock }));

import { createQueueMutations, type QueueMutationsDeps } from '../create-queue-mutations';

type TestItem = { uuid: string };
const client = {} as never;

function make(overrides: Partial<QueueMutationsDeps<TestItem>> = {}) {
  return createQueueMutations<TestItem>({
    getClient: () => client,
    getSessionId: () => 'S',
    toQueueItemInput: (queueItem) => ({ uuid: queueItem.uuid }) as unknown as ClimbQueueItemInput,
    getQueuePosition: () => -1,
    ...overrides,
  });
}

const payload = {
  applied: true,
  change: { restCadence: null, revision: 3, serverNow: '1800000000000', isSnapshot: false, action: 'DISARM' },
};

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue({ setSessionRestCadence: payload });
});

describe('setSessionRestCadence', () => {
  it('sends the input and hands back the server’s answer', async () => {
    await expect(make().setSessionRestCadence({ action: 'DISARM' })).resolves.toEqual(payload);
    expect(executeMock).toHaveBeenCalledWith(
      client,
      { query: SET_SESSION_REST_CADENCE, variables: { input: { action: 'DISARM' } } },
      {},
    );
  });

  it('gives a FIRE its own short timeout and no rate-limit retry', async () => {
    await make().setSessionRestCadence(
      { action: 'FIRE', expectedRevision: 3 },
      { timeoutMs: 2_000, retryWhenRateLimited: false },
    );
    expect(executeMock.mock.calls[0][2]).toEqual({ timeoutMs: 2_000, rateLimitRetries: 0 });
  });

  it('passes the rate-limit notifier on', async () => {
    const onRateLimited = vi.fn();
    await make({ onRateLimited }).setSessionRestCadence({ action: 'RESUME' });
    expect(executeMock.mock.calls[0][2]).toEqual({ onRateLimited });
  });

  it('throws a transport error instead of swallowing it', async () => {
    executeMock.mockRejectedValue(new Error('socket closed'));
    const onBestEffortError = vi.fn();
    await expect(make({ onBestEffortError }).setSessionRestCadence({ action: 'PAUSE' })).rejects.toThrow(
      'socket closed',
    );
    expect(onBestEffortError).not.toHaveBeenCalled();
  });

  it('is a no-op with no session, on both platforms', async () => {
    await expect(make({ getSessionId: () => null }).setSessionRestCadence({ action: 'ARM' })).resolves.toBeNull();
    await expect(
      make({ getSessionId: () => null, ensureReady: async () => null }).setSessionRestCadence({ action: 'ARM' }),
    ).resolves.toBeNull();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('joins the session first on mobile', async () => {
    const ensureReady = vi.fn(async (sessionId: string | null) => sessionId);
    await make({ ensureReady }).setSessionRestCadence({ action: 'RESET', isRunning: true });
    expect(ensureReady).toHaveBeenCalledWith('S');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
