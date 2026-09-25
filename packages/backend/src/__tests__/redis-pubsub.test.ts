import { describe, it, expect, beforeAll, afterAll, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { createRedisPubSubAdapter, type RedisPubSubAdapter } from '../pubsub/redis-adapter';
import { logger } from '../utils/logger';
import type { ClimbStatsEvent, QueueEvent, SessionEvent } from '@boardsesh/shared-schema';

// Integration tests require Redis to be running
// Run with: docker-compose -f docker-compose.test.yml up redis
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

describe('Redis PubSub Adapter', () => {
  let publisher1: Redis;
  let subscriber1: Redis;
  let publisher2: Redis;
  let subscriber2: Redis;
  let adapter1: RedisPubSubAdapter;
  let adapter2: RedisPubSubAdapter;

  beforeAll(async () => {
    // Create two separate "instances" to simulate multi-instance deployment
    publisher1 = new Redis(REDIS_URL);
    subscriber1 = new Redis(REDIS_URL);
    publisher2 = new Redis(REDIS_URL);
    subscriber2 = new Redis(REDIS_URL);

    // Wait for all connections
    await Promise.all([
      new Promise<void>((resolve) => publisher1.once('ready', resolve)),
      new Promise<void>((resolve) => subscriber1.once('ready', resolve)),
      new Promise<void>((resolve) => publisher2.once('ready', resolve)),
      new Promise<void>((resolve) => subscriber2.once('ready', resolve)),
    ]);

    adapter1 = createRedisPubSubAdapter(publisher1, subscriber1);
    adapter2 = createRedisPubSubAdapter(publisher2, subscriber2);
  });

  afterAll(async () => {
    await Promise.all([publisher1.quit(), subscriber1.quit(), publisher2.quit(), subscriber2.quit()]);
  });

  describe('Cross-instance message delivery', () => {
    it('delivers an idless Redis queue message to another instance', async () => {
      const sessionId = 'test-session-idless';
      const event: QueueEvent = {
        __typename: 'QueueItemRemoved',
        sequence: 1,
        stateHash: 'idless-hash',
        uuid: 'idless-item',
      };
      const receivedEvents: QueueEvent[] = [];
      adapter2.onQueueMessage((receivedSessionId, receivedEvent) => {
        if (receivedSessionId === sessionId) receivedEvents.push(receivedEvent);
      });
      await adapter2.subscribeQueueChannel(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        await publisher1.publish(`boardsesh:queue:${sessionId}`, JSON.stringify({ event, timestamp: Date.now() }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(receivedEvents).toEqual([event]);
      } finally {
        await adapter2.unsubscribeQueueChannel(sessionId);
      }
    });

    it('should deliver queue events from instance 1 to instance 2', async () => {
      const sessionId = 'test-session-1';
      const receivedEvents: QueueEvent[] = [];

      // Set up listener on adapter2
      adapter2.onQueueMessage((sid, event) => {
        if (sid === sessionId) {
          receivedEvents.push(event);
        }
      });

      // Subscribe adapter2 to the session
      await adapter2.subscribeQueueChannel(sessionId);

      // Small delay to ensure subscription is active
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Publish from adapter1
      const event: QueueEvent = {
        __typename: 'QueueItemAdded',
        sequence: 1,
        stateHash: 'hash-1',
        item: {
          uuid: 'test-uuid',
          climb: {
            uuid: 'climb-uuid',
            setter_username: 'test-setter',
            name: 'Test Climb',
            description: 'A test climb',
            frames: 'test-frames',
            angle: 40,
            ascensionist_count: 10,
            difficulty: 'V5',
            quality_average: '4.5',
            stars: 4.5,
            difficulty_error: '0.5',
            mirrored: false,
            benchmark_difficulty: null,
          },
          tickedBy: [],
          addedBy: undefined,
          suggested: false,
        },
        position: 0,
      };

      await adapter1.publishQueueEvent(sessionId, event);

      // Wait for message to be delivered
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].__typename).toBe('QueueItemAdded');

      // Cleanup
      await adapter2.unsubscribeQueueChannel(sessionId);
    });

    it('should deliver session events from instance 1 to instance 2', async () => {
      const sessionId = 'test-session-2';
      const receivedEvents: SessionEvent[] = [];

      // Set up listener on adapter2
      adapter2.onSessionMessage((sid, event) => {
        if (sid === sessionId) {
          receivedEvents.push(event);
        }
      });

      // Subscribe adapter2 to the session
      await adapter2.subscribeSessionChannel(sessionId);

      // Small delay to ensure subscription is active
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Publish from adapter1
      const event: SessionEvent = {
        __typename: 'UserJoined',
        user: {
          id: 'user-123',
          username: 'TestUser',
          isLeader: true,
          avatarUrl: undefined,
          connectionState: 'CONNECTED',
        },
      };

      await adapter1.publishSessionEvent(sessionId, event);

      // Wait for message to be delivered
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].__typename).toBe('UserJoined');

      // Cleanup
      await adapter2.unsubscribeSessionChannel(sessionId);
    });

    it('delivers complete climb-stats events across instances by layout key', async () => {
      const channelKey = 'kilter:1';
      const receivedEvents: ClimbStatsEvent[] = [];
      adapter2.onClimbStatsMessage((receivedKey, event) => {
        if (receivedKey === channelKey) receivedEvents.push(event);
      });
      await adapter2.subscribeClimbStatsChannel(channelKey);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const event: ClimbStatsEvent = {
        boardType: 'kilter',
        layoutId: 1,
        climbUuid: 'climb-live-stats',
        angle: 40,
        ascensionistCount: 12,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        difficulty: '7a/V6',
        faUsername: 'setter',
        faAt: '2026-08-01T00:00:00.000Z',
        syncSeq: '90071992547409930',
      };
      await adapter1.publishClimbStatsEvent(channelKey, event);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedEvents).toEqual([event]);
      await adapter2.unsubscribeClimbStatsChannel(channelKey);
    });

    it('does not echo climb-stats events back to the publishing instance', async () => {
      const channelKey = 'kilter:self-echo';
      const receivedEvents: ClimbStatsEvent[] = [];
      adapter1.onClimbStatsMessage((receivedKey, event) => {
        if (receivedKey === channelKey) receivedEvents.push(event);
      });
      await adapter1.subscribeClimbStatsChannel(channelKey);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const event: ClimbStatsEvent = {
        boardType: 'kilter',
        layoutId: 1,
        climbUuid: 'climb-self-echo',
        angle: 40,
        ascensionistCount: 1,
        qualityAverage: null,
        difficultyAverage: null,
        displayDifficulty: null,
        difficulty: null,
        faUsername: null,
        faAt: null,
        syncSeq: '1',
      };
      await adapter1.publishClimbStatsEvent(channelKey, event);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedEvents).toEqual([]);
      await adapter1.unsubscribeClimbStatsChannel(channelKey);
    });

    it('should NOT deliver messages to the same instance that published them', async () => {
      const sessionId = 'test-session-3';
      const receivedEvents: QueueEvent[] = [];

      // Set up listener on adapter1 (same instance that will publish)
      adapter1.onQueueMessage((sid, event) => {
        if (sid === sessionId) {
          receivedEvents.push(event);
        }
      });

      // Subscribe adapter1 to the session
      await adapter1.subscribeQueueChannel(sessionId);

      // Small delay to ensure subscription is active
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Publish from adapter1 (same instance)
      const event: QueueEvent = {
        __typename: 'QueueItemRemoved',
        sequence: 1,
        stateHash: 'hash-1',
        uuid: 'removed-uuid',
      };

      await adapter1.publishQueueEvent(sessionId, event);

      // Wait for any potential message delivery
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should NOT receive the message (same instance filtering)
      expect(receivedEvents.length).toBe(0);

      // Cleanup
      await adapter1.unsubscribeQueueChannel(sessionId);
    });
  });

  describe('Channel management', () => {
    it('should not subscribe to the same channel twice', async () => {
      const sessionId = 'test-session-4';

      // Subscribe twice
      await adapter1.subscribeQueueChannel(sessionId);
      await adapter1.subscribeQueueChannel(sessionId);

      // Should not throw and should only have one subscription
      // (we can't easily verify this without exposing internal state,
      // but the second call should be a no-op)

      // Cleanup
      await adapter1.unsubscribeQueueChannel(sessionId);
    });

    it('should handle unsubscribe for non-subscribed channel', async () => {
      const sessionId = 'test-session-never-subscribed';

      // Should not throw
      await adapter1.unsubscribeQueueChannel(sessionId);
    });
  });

  describe('Instance ID', () => {
    it('should generate unique instance IDs for each adapter', () => {
      const id1 = adapter1.getInstanceId();
      const id2 = adapter2.getInstanceId();

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });
  });
});

describe('Redis PubSub Adapter - Unit Tests (mocked)', () => {
  it('ignores Kilter live control messages before parsing their payloads', () => {
    const messageHandlers: Array<(channel: string, message: string) => void> = [];
    const mockPublisher = { publish: vi.fn() } as unknown as Redis;
    const mockSubscriber = {
      on: vi.fn((eventName: string, listener: (channel: string, message: string) => void) => {
        if (eventName === 'message') messageHandlers.push(listener);
      }),
    } as unknown as Redis;
    const adapter = createRedisPubSubAdapter(mockPublisher, mockSubscriber);
    const queueCallback = vi.fn();
    adapter.onQueueMessage(queueCallback);
    const parseSpy = vi.spyOn(JSON, 'parse');

    try {
      messageHandlers[0]?.('boardsesh:kilter-live:changed', '*');
      messageHandlers[0]?.('boardsesh:kilter-live:changed', '123');
      expect(parseSpy).not.toHaveBeenCalled();
      expect(queueCallback).not.toHaveBeenCalled();
      expect(adapter.getRejectedMessageCounts()).toEqual({ invalidJson: 0, invalidEnvelope: 0 });
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('counts malformed messages on event channels without dispatching them', () => {
    const messageHandlers: Array<(channel: string, message: string) => void> = [];
    const mockPublisher = { publish: vi.fn() } as unknown as Redis;
    const mockSubscriber = {
      on: vi.fn((eventName: string, listener: (channel: string, message: string) => void) => {
        if (eventName === 'message') messageHandlers.push(listener);
      }),
    } as unknown as Redis;
    const adapter = createRedisPubSubAdapter(mockPublisher, mockSubscriber);
    const queueCallback = vi.fn();
    adapter.onQueueMessage(queueCallback);

    messageHandlers[0]?.('boardsesh:queue:session-1', 'not-json');
    for (const payload of ['null', '{}', '{"event":null}', '{"event":[]}']) {
      messageHandlers[0]?.('boardsesh:queue:session-1', payload);
    }

    expect(queueCallback).not.toHaveBeenCalled();
    expect(adapter.getRejectedMessageCounts()).toEqual({ invalidJson: 1, invalidEnvelope: 4 });
  });

  it('logs incoming wall session events at debug while delivering them', () => {
    const messageHandlers: Array<(channel: string, message: string) => void> = [];
    const mockPublisher = { publish: vi.fn() } as unknown as Redis;
    const mockSubscriber = {
      on: vi.fn((eventName: string, listener: (channel: string, message: string) => void) => {
        if (eventName === 'message') messageHandlers.push(listener);
      }),
    } as unknown as Redis;
    const adapter = createRedisPubSubAdapter(mockPublisher, mockSubscriber);
    const sessionCallback = vi.fn();
    adapter.onSessionMessage(sessionCallback);
    const debugSpy = vi.spyOn(logger, 'debug');
    const infoSpy = vi.spyOn(logger, 'info');

    try {
      const wallEvent = { __typename: 'WallConfirmedClimb' };
      messageHandlers[0]?.('boardsesh:session:session-1', JSON.stringify({ event: wallEvent }));
      expect(sessionCallback).toHaveBeenCalledExactlyOnceWith('session-1', wallEvent);
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Received cross-instance message'));
      expect(infoSpy).not.toHaveBeenCalled();

      const membershipEvent = { __typename: 'UserJoined' };
      messageHandlers[0]?.('boardsesh:session:session-1', JSON.stringify({ event: membershipEvent }));
      expect(sessionCallback).toHaveBeenLastCalledWith('session-1', membershipEvent);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Received cross-instance message'));
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('routes idless messages to all eight channel callbacks and still skips its own messages', () => {
    const messageHandlers: Array<(channel: string, message: string) => void> = [];
    const mockPublisher = { publish: vi.fn() } as unknown as Redis;
    const mockSubscriber = {
      on: vi.fn((eventName: string, listener: (channel: string, message: string) => void) => {
        if (eventName === 'message') messageHandlers.push(listener);
      }),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Redis;
    const adapter = createRedisPubSubAdapter(mockPublisher, mockSubscriber);
    const callbacks = {
      queue: vi.fn(),
      session: vi.fn(),
      notifications: vi.fn(),
      comments: vi.fn(),
      newClimbs: vi.fn(),
      boardPresence: vi.fn(),
      boardQueue: vi.fn(),
      climbStats: vi.fn(),
    };
    adapter.onQueueMessage(callbacks.queue);
    adapter.onSessionMessage(callbacks.session);
    adapter.onNotificationMessage(callbacks.notifications);
    adapter.onCommentMessage(callbacks.comments);
    adapter.onNewClimbMessage(callbacks.newClimbs);
    adapter.onBoardPresenceMessage(callbacks.boardPresence);
    adapter.onBoardQueueMessage(callbacks.boardQueue);
    adapter.onClimbStatsMessage(callbacks.climbStats);

    const cases = [
      { channel: 'boardsesh:queue:session-1', key: 'session-1', callback: callbacks.queue },
      { channel: 'boardsesh:session:session-2', key: 'session-2', callback: callbacks.session },
      { channel: 'boardsesh:notifications:user-1', key: 'user-1', callback: callbacks.notifications },
      { channel: 'boardsesh:comments:climb:1', key: 'climb:1', callback: callbacks.comments },
      { channel: 'boardsesh:new-climbs:kilter:1', key: 'kilter:1', callback: callbacks.newClimbs },
      { channel: 'boardsesh:board:123', key: '123', callback: callbacks.boardPresence },
      { channel: 'boardsesh:board-queue:456', key: '456', callback: callbacks.boardQueue },
      { channel: 'boardsesh:climb-stats-layout:kilter:2', key: 'kilter:2', callback: callbacks.climbStats },
    ];

    expect(messageHandlers).toHaveLength(1);
    for (const { channel, key, callback } of cases) {
      // Routing is independent of the event's domain-specific shape.
      const event = { marker: channel };
      messageHandlers[0]?.(channel, JSON.stringify({ event, timestamp: Date.now() }));
      expect(callback).toHaveBeenCalledExactlyOnceWith(key, event);
    }

    messageHandlers[0]?.(
      'boardsesh:queue:session-1',
      JSON.stringify({
        instanceId: adapter.getInstanceId(),
        event: { marker: 'self' },
        timestamp: Date.now(),
      }),
    );
    expect(callbacks.queue).toHaveBeenCalledTimes(1);

    const event = { marker: 'non-string sender' };
    messageHandlers[0]?.('boardsesh:queue:session-1', JSON.stringify({ instanceId: 42, event, timestamp: Date.now() }));
    expect(callbacks.queue).toHaveBeenLastCalledWith('session-1', event);
  });

  it('should publish to correct channel format', async () => {
    const mockPublish = vi.fn().mockResolvedValue(1);
    const mockPublisher = { publish: mockPublish } as unknown as Redis;
    const mockSubscriber = {
      on: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Redis;

    const adapter = createRedisPubSubAdapter(mockPublisher, mockSubscriber);

    const event: QueueEvent = {
      __typename: 'ClimbMirrored',
      sequence: 1,
      stateHash: 'hash-1',
      uuid: 'queue-item-1',
      mirrored: true,
    };

    await adapter.publishQueueEvent('session-123', event);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).toBe('boardsesh:queue:session-123');

    const publishedMessage = JSON.parse(mockPublish.mock.calls[0][1]);
    expect(publishedMessage.event).toEqual(event);
    expect(publishedMessage.instanceId).toBe(adapter.getInstanceId());
    expect(publishedMessage.timestamp).toBeDefined();
  });

  it('should subscribe to correct channel format', async () => {
    const mockSubscribe = vi.fn().mockResolvedValue(undefined);
    const mockPublisher = { publish: vi.fn() } as unknown as Redis;
    const mockSubscriber = {
      on: vi.fn(),
      subscribe: mockSubscribe,
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    } as unknown as Redis;

    const adapter = createRedisPubSubAdapter(mockPublisher, mockSubscriber);

    await adapter.subscribeSessionChannel('session-456');

    expect(mockSubscribe).toHaveBeenCalledWith('boardsesh:session:session-456');
  });
});
