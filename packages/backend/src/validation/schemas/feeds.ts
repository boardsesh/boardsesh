import { z } from 'zod';
import { notificationTypeEnum, socialEntityTypeEnum } from '@boardsesh/db/schema';

/**
 * Activity feed input validation schema
 */
export const ActivityFeedInputSchema = z.object({
  cursor: z.string().max(500).optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  boardUuid: z.string().max(100).optional().nullable(),
  userId: z.string().max(100).optional().nullable(),
  followingOnly: z.boolean().optional().nullable(),
  includeDailyHighlights: z.boolean().optional().nullable(),
});

/**
 * Global comment feed input validation schema
 */
export const GlobalCommentFeedInputSchema = z.object({
  cursor: z.string().max(500).optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  boardUuid: z.string().max(100).optional().nullable(),
});

/**
 * Grouped notifications query input validation schema
 */
export const GroupedNotificationsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Actors behind one notification group. The (type, entityType, entityId) triple
 * is the same key `groupedNotifications` groups by; the client passes back the
 * fields off the row it tapped, so `entityType`/`entityId` are nullable exactly
 * where a notification carries none (`new_follower` sets no entity type).
 */
export const NotificationActorsInputSchema = z.object({
  type: z.enum(notificationTypeEnum.enumValues),
  entityType: z.enum(socialEntityTypeEnum.enumValues).optional().nullable(),
  entityId: z.string().max(100).optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().default(30),
  offset: z.number().int().min(0).optional().default(0),
});
