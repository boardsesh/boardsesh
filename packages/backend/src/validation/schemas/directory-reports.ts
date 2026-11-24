import { z } from 'zod';
import {
  BOARD_REPORT_REASONS,
  DIRECTORY_REPORT_STATUSES,
  DIRECTORY_REPORT_TARGET_KINDS,
  GYM_REPORT_REASONS,
  RESOLVED_DIRECTORY_REPORT_STATUSES,
} from '@boardsesh/directory-moderation';
import { UUIDSchema } from './primitives';
import { UpdateBoardInputSchema } from './boards';

// Directory reports (docs/product/directory-reports.md). Notes are capped
// loosely here and checked properly after trimming (`reportNoteProblem`), so a
// note padded with spaces is judged on what it says.
const RawNoteSchema = z.string().max(2000, 'Note too long').optional().nullable();

// A suggested setup on "Set up wrong" (docs/product/directory-reports.md,
// "Suggested setup"): `updateBoard`'s own rules for these four fields, so a
// suggestion can never carry a value an edit would refuse. Which reason and
// board type may carry one, and whether it is a real setup of the board's type
// and differs from its setup now, need the board: `prepareBoardReport` checks
// those and refuses with BAD_USER_INPUT.
const UpdateBoardSetupFields = UpdateBoardInputSchema.pick({ layoutId: true, sizeId: true, setIds: true, angle: true });
export const BoardSetupInputSchema = UpdateBoardSetupFields.required({
  layoutId: true,
  sizeId: true,
  setIds: true,
}).extend({ angle: UpdateBoardSetupFields.shape.angle.nullable() });

export const ReportBoardInputSchema = z.object({
  boardUuid: UUIDSchema,
  reason: z.enum(BOARD_REPORT_REASONS),
  duplicateOfBoardUuid: UUIDSchema.optional().nullable(),
  note: RawNoteSchema,
  suggestedSetup: BoardSetupInputSchema.optional().nullable(),
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

/** The setup changes list pages by event id, which only grows: `after` is the last id of the page before. */
export const AdminBoardSetupChangesArgsSchema = z.object({
  first: z.number().int().min(1).max(100).optional().nullable(),
  after: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Invalid cursor')
    .optional()
    .nullable(),
});

/** A `board_moderation_events` id, as the GraphQL `ID` carries it. */
export const BoardModerationEventIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'Invalid event id')
  .transform(Number);
