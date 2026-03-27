import { z } from 'zod';

export const REDIS_IMPORT_STREAM = 'boardsesh:import-jobs';
export const REDIS_IMPORT_GROUP = 'import-workers';

const importUserSchema = z.object({
  username: z.string(),
  email_address: z.string().email(),
  created_at: z.string(),
});

const importFollowSchema = z.object({
  followee_username: z.string(),
  follower_username: z.string(),
  state: z.string(),
  created_at: z.string(),
});

const importCircuitSchema = z.object({
  name: z.string(),
  color: z.string(),
  created_at: z.string(),
  climbs: z.array(z.string()),
});

const importLikeSchema = z.object({
  climb: z.string(),
  created_at: z.string(),
});

const importAttemptSchema = z.object({
  climb: z.string(),
  angle: z.number(),
  count: z.number(),
  climbed_at: z.string(),
  created_at: z.string(),
});

const importAscentSchema = z.object({
  climb: z.string(),
  angle: z.number(),
  count: z.number(),
  stars: z.number(),
  climbed_at: z.string(),
  created_at: z.string(),
  grade: z.string(),
  comment: z.string().optional(),
});

const importClimbHoldSchema = z.object({
  x: z.number(),
  y: z.number(),
  role: z.enum(['start', 'middle', 'finish', 'foot']),
});

const importClimbSchema = z.object({
  name: z.string(),
  layout: z.string(),
  created_at: z.string(),
  is_draft: z.boolean().optional().default(false),
  holds: z.array(importClimbHoldSchema),
});

export const importDataSchema = z.object({
  user: importUserSchema,
  follows: z.array(importFollowSchema).optional().default([]),
  walls: z.array(z.unknown()).optional().default([]),
  circuits: z.array(importCircuitSchema).optional().default([]),
  likes: z.array(importLikeSchema).optional().default([]),
  blocks: z.array(z.unknown()).optional().default([]),
  beta_links: z.array(z.unknown()).optional().default([]),
  attempts: z.array(importAttemptSchema).optional().default([]),
  ascents: z.array(importAscentSchema).optional().default([]),
  climbs: z.array(importClimbSchema).optional().default([]),
  agreements: z.array(z.unknown()).optional().default([]),
});

export type ImportData = z.infer<typeof importDataSchema>;
