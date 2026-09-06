import { z } from 'zod';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { UUIDSchema, ExternalUUIDSchema, BoardNameSchema } from './primitives';
import { BOARD_ANGLE_VALIDATION_MESSAGE, isBoardAngleSupported } from './board-angles';

/**
 * Proposal type validation schema
 */
export const ProposalTypeSchema = z.enum(['grade', 'classic', 'benchmark', 'hide']);

/**
 * Every grade label the grades query can hand a client, e.g. `6b+/V4`. A grade
 * proposal stores the label verbatim, so the reporter's choice has to come from
 * this list or the proposal would name a grade nothing else can resolve.
 */
const BOULDER_GRADE_LABELS = BOULDER_GRADES.map((grade) => grade.difficulty_name);

/**
 * Proposal status validation schema
 */
export const ProposalStatusSchema = z.enum(['open', 'approved', 'rejected', 'superseded']);

/**
 * Community role type validation schema
 */
export const CommunityRoleTypeSchema = z.enum(['admin', 'community_leader', 'tester']);

const BOOLEAN_PROPOSAL_VALUES: ReadonlySet<string> = new Set(['true', 'false']);
const GRADE_LABEL_VALUES: ReadonlySet<string> = new Set(BOULDER_GRADE_LABELS);

export const CreateProposalInputSchema = z
  .object({
    climbUuid: ExternalUUIDSchema,
    boardType: BoardNameSchema,
    angle: z.number().int().min(-5).max(90).optional().nullable(),
    type: ProposalTypeSchema,
    proposedValue: z.string().min(1, 'Proposed value cannot be empty').max(100),
    reason: z.string().max(500).optional().nullable(),
  })
  .refine((input) => isBoardAngleSupported(input.boardType, input.angle), {
    message: BOARD_ANGLE_VALIDATION_MESSAGE,
    path: ['angle'],
  })
  // Boolean proposal types carry 'true' | 'false'; grade carries a grade label.
  .refine(
    (input) =>
      input.type === 'grade'
        ? GRADE_LABEL_VALUES.has(input.proposedValue)
        : BOOLEAN_PROPOSAL_VALUES.has(input.proposedValue),
    {
      message: 'Proposed value must be a known grade label for grade proposals, or true/false otherwise',
      path: ['proposedValue'],
    },
  );

export const VoteOnProposalInputSchema = z.object({
  proposalUuid: UUIDSchema,
  value: z
    .number()
    .int()
    .refine((v) => v === 1 || v === -1, {
      message: 'Vote value must be +1 or -1',
    }),
});

export const ResolveProposalInputSchema = z.object({
  proposalUuid: UUIDSchema,
  status: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional().nullable(),
});

export const DeleteProposalInputSchema = z.object({
  proposalUuid: UUIDSchema,
});

export const SetterOverrideInputSchema = z
  .object({
    climbUuid: ExternalUUIDSchema,
    boardType: BoardNameSchema,
    angle: z.number().int().min(-5).max(90),
    communityGrade: z.string().max(100).optional().nullable(),
    isBenchmark: z.boolean().optional().nullable(),
  })
  .refine((input) => isBoardAngleSupported(input.boardType, input.angle), {
    message: BOARD_ANGLE_VALIDATION_MESSAGE,
    path: ['angle'],
  });

export const FreezeClimbInputSchema = z.object({
  climbUuid: ExternalUUIDSchema,
  boardType: BoardNameSchema,
  frozen: z.boolean(),
  reason: z.string().max(500).optional().nullable(),
});

export const GrantRoleInputSchema = z
  .object({
    userId: z.string().min(1, 'User ID cannot be empty'),
    role: CommunityRoleTypeSchema,
    boardType: BoardNameSchema.optional().nullable(),
  })
  // Tester access is global (userIsTester ignores board scope), so a board-scoped
  // tester row would be a misleading no-op. Enforce the global invariant here rather
  // than relying on the admin UI hiding the board picker.
  .refine((input) => input.role !== 'tester' || input.boardType == null, {
    message: 'Tester role is global and cannot be scoped to a board',
    path: ['boardType'],
  });

export const RevokeRoleInputSchema = z.object({
  userId: z.string().min(1, 'User ID cannot be empty'),
  role: CommunityRoleTypeSchema,
  boardType: BoardNameSchema.optional().nullable(),
});

export const SetCommunitySettingInputSchema = z.object({
  scope: z.enum(['global', 'board', 'climb']),
  scopeKey: z.string().max(200),
  key: z.string().min(1).max(100),
  value: z.string().max(1000),
});

export const GetClimbProposalsInputSchema = z
  .object({
    climbUuid: ExternalUUIDSchema,
    boardType: BoardNameSchema,
    angle: z.number().int().min(-5).max(90).optional().nullable(),
    type: ProposalTypeSchema.optional().nullable(),
    status: ProposalStatusSchema.optional().nullable(),
    limit: z.number().int().min(1).max(50).optional().default(20),
    offset: z.number().int().min(0).optional().default(0),
  })
  .refine((input) => isBoardAngleSupported(input.boardType, input.angle), {
    message: BOARD_ANGLE_VALIDATION_MESSAGE,
    path: ['angle'],
  });

export const BrowseProposalsInputSchema = z.object({
  boardType: BoardNameSchema.optional().nullable(),
  boardUuid: z.string().max(100).optional().nullable(),
  type: ProposalTypeSchema.optional().nullable(),
  // Capped at the number of proposal types — a longer list can only repeat
  // itself, and an unbounded array is an IN-list the planner has to chew on.
  types: z.array(ProposalTypeSchema).max(4).optional().nullable(),
  status: ProposalStatusSchema.optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Reporting a climb.
 *
 * A hide report is climb-wide, so any angle the client happens to be looking at
 * is dropped rather than rejected — reporting from the 40° view shouldn't open a
 * 40°-only hide. A grade report is per-angle and needs both the angle and the
 * grade the reporter thinks is right.
 *
 * The reason is mandatory and has a floor: "wrong" tells a moderator nothing,
 * and these reports can hide a climb from everyone.
 */
export const ReportClimbInputSchema = z
  .object({
    climbUuid: ExternalUUIDSchema,
    boardType: BoardNameSchema,
    angle: z.number().int().min(-5).max(90).optional().nullable(),
    kind: z.enum(['hide', 'grade']),
    proposedGrade: z.enum(BOULDER_GRADE_LABELS).optional().nullable(),
    reason: z
      .string()
      .trim()
      .min(10, 'Give us a bit more detail: at least 10 characters')
      .max(500, 'Keep the reason under 500 characters'),
  })
  .superRefine((input, ctx) => {
    if (input.kind !== 'grade') return;

    if (input.angle == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Angle is required for grade reports',
        path: ['angle'],
      });
    } else if (!isBoardAngleSupported(input.boardType, input.angle)) {
      ctx.addIssue({
        code: 'custom',
        message: BOARD_ANGLE_VALIDATION_MESSAGE,
        path: ['angle'],
      });
    }

    if (!input.proposedGrade) {
      ctx.addIssue({
        code: 'custom',
        message: 'A proposed grade is required for grade reports',
        path: ['proposedGrade'],
      });
    }
  })
  .transform((input) => (input.kind === 'hide' ? { ...input, angle: null, proposedGrade: null } : input));
