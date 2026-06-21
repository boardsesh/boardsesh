import { z } from 'zod';
import { UUIDSchema, ExternalUUIDSchema, BoardNameSchema } from './primitives';

/**
 * Proposal type validation schema
 */
export const ProposalTypeSchema = z.enum(['grade', 'classic', 'benchmark']);

/**
 * Proposal status validation schema
 */
export const ProposalStatusSchema = z.enum(['open', 'approved', 'rejected', 'superseded']);

/**
 * Community role type validation schema
 */
export const CommunityRoleTypeSchema = z.enum(['admin', 'community_leader', 'tester']);

export const CreateProposalInputSchema = z.object({
  climbUuid: ExternalUUIDSchema,
  boardType: BoardNameSchema,
  angle: z.number().int().min(0).max(90).optional().nullable(),
  type: ProposalTypeSchema,
  proposedValue: z.string().min(1, 'Proposed value cannot be empty').max(100),
  reason: z.string().max(500).optional().nullable(),
});

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

export const SetterOverrideInputSchema = z.object({
  climbUuid: ExternalUUIDSchema,
  boardType: BoardNameSchema,
  angle: z.number().int().min(0).max(90),
  communityGrade: z.string().max(100).optional().nullable(),
  isBenchmark: z.boolean().optional().nullable(),
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

export const GetClimbProposalsInputSchema = z.object({
  climbUuid: ExternalUUIDSchema,
  boardType: BoardNameSchema,
  angle: z.number().int().min(0).max(90).optional().nullable(),
  type: ProposalTypeSchema.optional().nullable(),
  status: ProposalStatusSchema.optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export const BrowseProposalsInputSchema = z.object({
  boardType: BoardNameSchema.optional().nullable(),
  boardUuid: z.string().max(100).optional().nullable(),
  type: ProposalTypeSchema.optional().nullable(),
  status: ProposalStatusSchema.optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});
