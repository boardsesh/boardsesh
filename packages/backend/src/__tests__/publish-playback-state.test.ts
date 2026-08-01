/**
 * Tests the `publishPlaybackState` mutation introduced for multi-frame
 * climb playback sync (issue #2232). The resolver is intentionally tiny —
 * it stamps the server time, tags the event with the caller's
 * `connectionId` for echo suppression, and broadcasts via `publishQueueEvent`.
 * Echo suppression itself happens on the client.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getQueueState: vi.fn().mockResolvedValue({
      sequence: 7,
      stateHash: 'hash',
      queue: [],
      currentClimbQueueItem: null,
    }),
  },
  VersionConflictError: class VersionConflictError extends Error {},
}));

vi.mock('../pubsub/index', () => ({
  pubsub: {
    publishQueueEvent: vi.fn(),
  },
}));

vi.mock('../graphql/context', () => ({
  updateContext: vi.fn(),
  getContext: vi.fn(() => ({ sessionId: 'session-1' })),
}));

vi.mock('../graphql/resolvers/shared/helpers', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/shared/helpers')>(
    '../graphql/resolvers/shared/helpers',
  );
  return {
    ...actual,
    applyRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

const { queueMutations } = await import('../graphql/resolvers/queue/mutations');
const { pubsub } = await import('../pubsub/index');

const pubsubMock = pubsub as unknown as { publishQueueEvent: ReturnType<typeof vi.fn> };

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    transport: 'ws',
    sessionId: 'session-1',
    participantId: 'participant-1',
    isAuthenticated: false,
    ...overrides,
  };
}

const climbUuid = '11111111-1111-1111-1111-111111111111';
const validPlaybackInput = {
  climbUuid,
  frameIndex: 3,
  isPlaying: true,
  speed: 1.5,
  paceMs: 250,
};

describe('publishPlaybackState mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts a PlaybackStateChanged event tagged with the caller connectionId', async () => {
    const before = Date.now();
    const result = await queueMutations.publishPlaybackState(
      undefined,
      {
        input: validPlaybackInput,
      },
      makeCtx({ connectionId: 'conn-abc' }),
    );

    expect(result).toBe(true);
    expect(pubsubMock.publishQueueEvent).toHaveBeenCalledTimes(1);
    const [sessionId, event] = pubsubMock.publishQueueEvent.mock.calls[0] as unknown as [
      string,
      {
        __typename: string;
        climbUuid: string;
        frameIndex: number;
        isPlaying: boolean;
        speed: number;
        paceMs: number;
        anchorTimestamp: string;
        clientId: string | null;
        sequence: number;
      },
    ];

    expect(sessionId).toBe('session-1');
    expect(event.__typename).toBe('PlaybackStateChanged');
    expect(event.climbUuid).toBe(climbUuid);
    expect(event.frameIndex).toBe(3);
    expect(event.isPlaying).toBe(true);
    expect(event.speed).toBe(1.5);
    expect(event.paceMs).toBe(250);
    expect(event.clientId).toBe('conn-abc');
    expect(event.sequence).toBe(7);
    const stampedMs = Number(event.anchorTimestamp);
    expect(Number.isNaN(stampedMs)).toBe(false);
    expect(stampedMs).toBeGreaterThanOrEqual(before);
    expect(stampedMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('emits null clientId when the caller has no connectionId', async () => {
    await queueMutations.publishPlaybackState(
      undefined,
      {
        input: {
          climbUuid,
          frameIndex: 0,
          isPlaying: false,
          speed: 1,
          paceMs: 500,
        },
      },
      makeCtx({ connectionId: '' }),
    );
    const event = pubsubMock.publishQueueEvent.mock.calls[0]?.[1] as { clientId: string | null };
    expect(event.clientId).toBeNull();
  });

  it('prefers the publisher-supplied clientId over the connection id', async () => {
    await queueMutations.publishPlaybackState(
      undefined,
      {
        input: {
          climbUuid,
          frameIndex: 2,
          isPlaying: true,
          speed: 1,
          paceMs: 400,
          clientId: 'engine-:r3:',
        },
      },
      makeCtx({ connectionId: 'conn-xyz' }),
    );
    const event = pubsubMock.publishQueueEvent.mock.calls[0]?.[1] as { clientId: string | null };
    expect(event.clientId).toBe('engine-:r3:');
  });

  it.each([
    ['negative frame index', { frameIndex: -1 }],
    ['fractional frame index', { frameIndex: 1.5 }],
    ['NaN speed', { speed: Number.NaN }],
    ['infinite speed', { speed: Infinity }],
    ['speed outside the shipped range', { speed: 10.1 }],
    ['pace below the engine floor', { paceMs: 199 }],
    ['fractional pace', { paceMs: 200.5 }],
    ['infinite pace', { paceMs: Infinity }],
    ['coerced numeric value', { paceMs: '200' }],
    ['wrong boolean type', { isPlaying: 'true' }],
  ])('rejects %s before publishing', async (_description, overrides) => {
    await expect(
      queueMutations.publishPlaybackState(undefined, { input: { ...validPlaybackInput, ...overrides } }, makeCtx()),
    ).rejects.toThrow('Invalid input');

    expect(pubsubMock.publishQueueEvent).not.toHaveBeenCalled();
  });
});
