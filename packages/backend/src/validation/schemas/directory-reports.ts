import { z } from 'zod';
import {
  BOARD_REPORT_REASONS,
  DIRECTORY_REPORT_STATUSES,
  DIRECTORY_REPORT_TARGET_KINDS,
  GYM_REPORT_REASONS,
  RESOLVED_DIRECTORY_REPORT_STATUSES,
} from '@boardsesh/directory-moderation';
import { UUIDSchema } from './primitives';

// Directory reports (docs/product/directory-reports.md). Notes are capped
// loosely here and checked properly after trimming (`reportNoteProblem`), so a
// note padded with spaces is judged on what it says.
const RawNoteSchema = z.string().max(2000, 'Note too long').optional().nullable();

export const ReportBoardInputSchema = z.object({
  boardUuid: UUIDSchema,
  reason: z.enum(BOARD_REPORT_REASONS),
  duplicateOfBoardUuid: UUIDSchema.optional().nullable(),
  note: RawNoteSchema,
});

export const ReportGymInputSchema = z.object({
  gymUuid: UUIDSchema,
  reason: z.enum(GYM_REPORT_REASONS),
  duplicateOfGymUuid: UUIDSchema.optional().nullable(),
  note: RawNoteSchema,
});

export const ResolveDirectoryReportInputSchema = z.object({
  reportUuid: UUIDSchema,
  outcome: z.enum(RESOLVED_DIRECTORY_REPORT_STATUSES),
  note: RawNoteSchema,
});

export const MyDirectoryReportsToReviewArgsSchema = z.object({
  includeResolved: z.boolean().optional().nullable(),
  first: z.number().int().min(1).max(100).optional().nullable(),
});

export const AdminDirectoryReportsArgsSchema = z.object({
  status: z.enum(DIRECTORY_REPORT_STATUSES).optional().nullable(),
  targetKind: z.enum(DIRECTORY_REPORT_TARGET_KINDS).optional().nullable(),
  first: z.number().int().min(1).max(100).optional().nullable(),
  after: z
    .string()
    .regex(/^\d{1,15}_\d{1,19}$/, 'Invalid cursor')
    .optional()
    .nullable(),
});
