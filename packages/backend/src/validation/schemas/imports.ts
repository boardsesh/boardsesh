import { z } from 'zod';
import { BoardNameSchema } from './primitives';

export const ImportTickRowSchema = z.object({
  climbUuid: z.string().optional().nullable(),
  climbName: z.string().min(1).max(500),
  angle: z.number().int().min(0).max(90),
  date: z.string().min(1),
  loggedGrade: z.string().optional().nullable(),
  displayedGrade: z.string().optional().nullable(),
  isBenchmark: z.boolean(),
  tries: z.number().int().min(0).max(9999),
  isMirror: z.boolean(),
  isAscent: z.boolean(),
  comment: z.string().max(2000).optional().nullable(),
});

export const ImportTicksBatchInputSchema = z.object({
  boardType: BoardNameSchema,
  rows: z.array(ImportTickRowSchema).min(1).max(100),
  buildSessions: z.boolean().optional(),
});
