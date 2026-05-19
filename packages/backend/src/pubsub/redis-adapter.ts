import type {
  QueueEvent,
  SessionEvent,
  NotificationEvent,
  CommentEvent,
  NewClimbCreatedEvent,
  BoardHistoryEvent,
} from '@boardsesh/shared-schema';
import type Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

// Channel naming convention
const QUEUE_CHANNEL_PREFIX = 'boardsesh:queue:';
const SESSION_CHANNEL_PREFIX = 'boardsesh:session:';
const NOTIFICATION_CHANNEL_PREFIX = 'boardsesh:notifications:';
const COMMENT_CHANNEL_PREFIX = 'boardsesh:comments:';
const NEW_CLIMB_CHANNEL_PREFIX = 'boardsesh:new-climbs:';
const BOARD_HISTORY_CHANNEL_PREFIX = 'boardsesh:board-history:';

type RedisMessage = {
  instanceId: string;
  event: QueueEvent | SessionEvent | NotificationEvent | CommentEvent | NewClimbCreatedEvent | BoardHistoryEvent;
  timestamp: number;
};

export type RedisPubSubAdapter = {
  publishQueueEvent(sessionId: string, event: QueueEvent): Promise<void>;
  publishSessionEvent(sessionId: string, event: SessionEvent): Promise<void>;
  publishNotificationEvent(userId: string, event: NotificationEvent): Promise<void>;
  publishCommentEvent(entityKey: string, event: CommentEvent): Promise<void>;
  publishNewClimbEvent(channelKey: string, event: NewClimbCreatedEvent): Promise<void>;
  publishBoardHistoryEvent(serial: string, event: BoardHistoryEvent): Promise<void>;
  subscribeQueueChannel(sessionId: string): Promise<void>;
  subscribeSessionChannel(sessionId: string): Promise<void>;
  subscribeNotificationChannel(userId: string): Promise<void>;
  subscribeCommentChannel(entityKey: string): Promise<void>;
  subscribeNewClimbChannel(channelKey: string): Promise<void>;
  subscribeBoardHistoryChannel(serial: string): Promise<void>;
  unsubscribeQueueChannel(sessionId: string): Promise<void>;
  unsubscribeSessionChannel(sessionId: string): Promise<void>;
  unsubscribeNotificationChannel(userId: string): Promise<void>;
  unsubscribeCommentChannel(entityKey: string): Promise<void>;
  unsubscribeNewClimbChannel(channelKey: string): Promise<void>;
  unsubscribeBoardHistoryChannel(serial: string): Promise<void>;
  onQueueMessage(callback: (sessionId: string, event: QueueEvent) => void): void;
  onSessionMessage(callback: (sessionId: string, event: SessionEvent) => void): void;
  onNotificationMessage(callback: (userId: string, event: NotificationEvent) => void): void;
  onCommentMessage(callback: (entityKey: string, event: CommentEvent) => void): void;
  onNewClimbMessage(callback: (channelKey: string, event: NewClimbCreatedEvent) => void): void;
  onBoardHistoryMessage(callback: (serial: string, event: BoardHistoryEvent) => void): void;
  getInstanceId(): string;
};

export function createRedisPubSubAdapter(publisher: Redis, subscriber: Redis): RedisPubSubAdapter {
  const instanceId = uuidv4();
  const subscribedQueueChannels = new Set<string>();
  const subscribedSessionChannels = new Set<string>();
  const subscribedNotificationChannels = new Set<string>();
  const subscribedCommentChannels = new Set<string>();
  const subscribedNewClimbChannels = new Set<string>();
  const subscribedBoardHistoryChannels = new Set<string>();

  let queueMessageCallback: ((sessionId: string, event: QueueEvent) => void) | null = null;
  let sessionMessageCallback: ((sessionId: string, event: SessionEvent) => void) | null = null;
  let notificationMessageCallback: ((userId: string, event: NotificationEvent) => void) | null = null;
  let commentMessageCallback: ((entityKey: string, event: CommentEvent) => void) | null = null;
  let newClimbMessageCallback: ((channelKey: string, event: NewClimbCreatedEvent) => void) | null = null;
  let boardHistoryMessageCallback: ((serial: string, event: BoardHistoryEvent) => void) | null = null;

  // Set up message handler
  subscriber.on('message', (channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as RedisMessage;

      // Skip messages from this instance (already delivered locally)
      if (parsed.instanceId === instanceId) {
        return;
      }

      logger.info(
        `[Redis] Received cross-instance message from ${parsed.instanceId.slice(0, 8)} on channel: ${channel}`,
      );

      if (channel.startsWith(QUEUE_CHANNEL_PREFIX)) {
        const sessionId = channel.slice(QUEUE_CHANNEL_PREFIX.length);
        if (queueMessageCallback) {
          queueMessageCallback(sessionId, parsed.event as QueueEvent);
        }
      } else if (channel.startsWith(SESSION_CHANNEL_PREFIX)) {
        const sessionId = channel.slice(SESSION_CHANNEL_PREFIX.length);
        if (sessionMessageCallback) {
          sessionMessageCallback(sessionId, parsed.event as SessionEvent);
        }
      } else if (channel.startsWith(NOTIFICATION_CHANNEL_PREFIX)) {
        const userId = channel.slice(NOTIFICATION_CHANNEL_PREFIX.length);
        if (notificationMessageCallback) {
          notificationMessageCallback(userId, parsed.event as NotificationEvent);
        }
      } else if (channel.startsWith(COMMENT_CHANNEL_PREFIX)) {
        const entityKey = channel.slice(COMMENT_CHANNEL_PREFIX.length);
        if (commentMessageCallback) {
          commentMessageCallback(entityKey, parsed.event as CommentEvent);
        }
      } else if (channel.startsWith(NEW_CLIMB_CHANNEL_PREFIX)) {
        const channelKey = channel.slice(NEW_CLIMB_CHANNEL_PREFIX.length);
        if (newClimbMessageCallback) {
          newClimbMessageCallback(channelKey, parsed.event as NewClimbCreatedEvent);
        }
      } else if (channel.startsWith(BOARD_HISTORY_CHANNEL_PREFIX)) {
        const serial = channel.slice(BOARD_HISTORY_CHANNEL_PREFIX.length);
        if (boardHistoryMessageCallback) {
          boardHistoryMessageCallback(serial, parsed.event as BoardHistoryEvent);
        }
      }
    } catch (error) {
      logger.error('[Redis] Failed to parse message:', error);
    }
  });

  return {
    async publishQueueEvent(sessionId: string, event: QueueEvent): Promise<void> {
      const channel = `${QUEUE_CHANNEL_PREFIX}${sessionId}`;
      const message: RedisMessage = {
        instanceId,
        event,
        timestamp: Date.now(),
      };
      logger.info(`[Redis] Publishing queue event to channel: ${sessionId} (type: ${event.__typename})`);
      await publisher.publish(channel, JSON.stringify(message));
    },

    async publishSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
      const channel = `${SESSION_CHANNEL_PREFIX}${sessionId}`;
      const message: RedisMessage = {
        instanceId,
        event,
        timestamp: Date.now(),
      };
      // Drop high-frequency wall/driver events to debug to keep INFO useful.
      // `WallConfirmedClimb` fires on every BLE confirm, `DriverChanged` on
      // every lightbulb press, and `SessionBoardSerialChanged` on every
      // reconnect — all noisy. Membership-level events stay at INFO since
      // they're rare and useful for triage.
      const isHighFrequency =
        event.__typename === 'WallConfirmedClimb' ||
        event.__typename === 'DriverChanged' ||
        event.__typename === 'SessionBoardSerialChanged';
      const logMessage = `[Redis] Publishing session event to channel: ${sessionId} (type: ${event.__typename})`;
      if (isHighFrequency) {
        logger.debug(logMessage);
      } else {
        logger.info(logMessage);
      }
      await publisher.publish(channel, JSON.stringify(message));
    },

    async publishNotificationEvent(userId: string, event: NotificationEvent): Promise<void> {
      const channel = `${NOTIFICATION_CHANNEL_PREFIX}${userId}`;
      const message: RedisMessage = {
        instanceId,
        event,
        timestamp: Date.now(),
      };
      await publisher.publish(channel, JSON.stringify(message));
    },

    async publishCommentEvent(entityKey: string, event: CommentEvent): Promise<void> {
      const channel = `${COMMENT_CHANNEL_PREFIX}${entityKey}`;
      const message: RedisMessage = {
        instanceId,
        event,
        timestamp: Date.now(),
      };
      await publisher.publish(channel, JSON.stringify(message));
    },

    async publishNewClimbEvent(channelKey: string, event: NewClimbCreatedEvent): Promise<void> {
      const channel = `${NEW_CLIMB_CHANNEL_PREFIX}${channelKey}`;
      const message: RedisMessage = {
        instanceId,
        event,
        timestamp: Date.now(),
      };
      await publisher.publish(channel, JSON.stringify(message));
    },

    async publishBoardHistoryEvent(serial: string, event: BoardHistoryEvent): Promise<void> {
      const channel = `${BOARD_HISTORY_CHANNEL_PREFIX}${serial}`;
      const message: RedisMessage = {
        instanceId,
        event,
        timestamp: Date.now(),
      };
      logger.info(`[Redis] Publishing board history event to channel: ${serial} (type: ${event.__typename})`);
      await publisher.publish(channel, JSON.stringify(message));
    },

    async subscribeQueueChannel(sessionId: string): Promise<void> {
      const channel = `${QUEUE_CHANNEL_PREFIX}${sessionId}`;
      if (subscribedQueueChannels.has(channel)) {
        return;
      }
      await subscriber.subscribe(channel);
      subscribedQueueChannels.add(channel);
      logger.info(`[Redis] Subscribed to queue channel: ${sessionId}`);
    },

    async subscribeSessionChannel(sessionId: string): Promise<void> {
      const channel = `${SESSION_CHANNEL_PREFIX}${sessionId}`;
      if (subscribedSessionChannels.has(channel)) {
        return;
      }
      await subscriber.subscribe(channel);
      subscribedSessionChannels.add(channel);
      logger.info(`[Redis] Subscribed to session channel: ${sessionId}`);
    },

    async unsubscribeQueueChannel(sessionId: string): Promise<void> {
      const channel = `${QUEUE_CHANNEL_PREFIX}${sessionId}`;
      if (!subscribedQueueChannels.has(channel)) {
        return;
      }
      await subscriber.unsubscribe(channel);
      subscribedQueueChannels.delete(channel);
      logger.info(`[Redis] Unsubscribed from queue channel: ${sessionId}`);
    },

    async unsubscribeSessionChannel(sessionId: string): Promise<void> {
      const channel = `${SESSION_CHANNEL_PREFIX}${sessionId}`;
      if (!subscribedSessionChannels.has(channel)) {
        return;
      }
      await subscriber.unsubscribe(channel);
      subscribedSessionChannels.delete(channel);
      logger.info(`[Redis] Unsubscribed from session channel: ${sessionId}`);
    },

    async subscribeNotificationChannel(userId: string): Promise<void> {
      const channel = `${NOTIFICATION_CHANNEL_PREFIX}${userId}`;
      if (subscribedNotificationChannels.has(channel)) {
        return;
      }
      await subscriber.subscribe(channel);
      subscribedNotificationChannels.add(channel);
    },

    async subscribeCommentChannel(entityKey: string): Promise<void> {
      const channel = `${COMMENT_CHANNEL_PREFIX}${entityKey}`;
      if (subscribedCommentChannels.has(channel)) {
        return;
      }
      await subscriber.subscribe(channel);
      subscribedCommentChannels.add(channel);
    },

    async subscribeNewClimbChannel(channelKey: string): Promise<void> {
      const channel = `${NEW_CLIMB_CHANNEL_PREFIX}${channelKey}`;
      if (subscribedNewClimbChannels.has(channel)) {
        return;
      }
      await subscriber.subscribe(channel);
      subscribedNewClimbChannels.add(channel);
      logger.info(`[Redis] Subscribed to new climb channel: ${channelKey}`);
    },

    async unsubscribeNotificationChannel(userId: string): Promise<void> {
      const channel = `${NOTIFICATION_CHANNEL_PREFIX}${userId}`;
      if (!subscribedNotificationChannels.has(channel)) {
        return;
      }
      await subscriber.unsubscribe(channel);
      subscribedNotificationChannels.delete(channel);
    },

    async unsubscribeCommentChannel(entityKey: string): Promise<void> {
      const channel = `${COMMENT_CHANNEL_PREFIX}${entityKey}`;
      if (!subscribedCommentChannels.has(channel)) {
        return;
      }
      await subscriber.unsubscribe(channel);
      subscribedCommentChannels.delete(channel);
    },

    async unsubscribeNewClimbChannel(channelKey: string): Promise<void> {
      const channel = `${NEW_CLIMB_CHANNEL_PREFIX}${channelKey}`;
      if (!subscribedNewClimbChannels.has(channel)) {
        return;
      }
      await subscriber.unsubscribe(channel);
      subscribedNewClimbChannels.delete(channel);
      logger.info(`[Redis] Unsubscribed from new climb channel: ${channelKey}`);
    },

    async subscribeBoardHistoryChannel(serial: string): Promise<void> {
      const channel = `${BOARD_HISTORY_CHANNEL_PREFIX}${serial}`;
      if (subscribedBoardHistoryChannels.has(channel)) {
        return;
      }
      await subscriber.subscribe(channel);
      subscribedBoardHistoryChannels.add(channel);
      logger.info(`[Redis] Subscribed to board history channel: ${serial}`);
    },

    async unsubscribeBoardHistoryChannel(serial: string): Promise<void> {
      const channel = `${BOARD_HISTORY_CHANNEL_PREFIX}${serial}`;
      if (!subscribedBoardHistoryChannels.has(channel)) {
        return;
      }
      await subscriber.unsubscribe(channel);
      subscribedBoardHistoryChannels.delete(channel);
      logger.info(`[Redis] Unsubscribed from board history channel: ${serial}`);
    },

    onQueueMessage(callback: (sessionId: string, event: QueueEvent) => void): void {
      queueMessageCallback = callback;
    },

    onSessionMessage(callback: (sessionId: string, event: SessionEvent) => void): void {
      sessionMessageCallback = callback;
    },

    onNotificationMessage(callback: (userId: string, event: NotificationEvent) => void): void {
      notificationMessageCallback = callback;
    },

    onCommentMessage(callback: (entityKey: string, event: CommentEvent) => void): void {
      commentMessageCallback = callback;
    },

    onNewClimbMessage(callback: (channelKey: string, event: NewClimbCreatedEvent) => void): void {
      newClimbMessageCallback = callback;
    },

    onBoardHistoryMessage(callback: (serial: string, event: BoardHistoryEvent) => void): void {
      boardHistoryMessageCallback = callback;
    },

    getInstanceId(): string {
      return instanceId;
    },
  };
}
