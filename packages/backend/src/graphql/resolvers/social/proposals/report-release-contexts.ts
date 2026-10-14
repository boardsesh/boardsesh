import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { ConnectionContext, ProposalReportReleaseContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../../db/client';
import { ProposalReportReleaseContextsArgsSchema } from '../../../../validation/schemas/release-context';
import { applyRateLimit, validateInput } from '../../shared/helpers';
import { commentPrivacyCondition } from '../../shared/activity-privacy';
import { hasAdmin } from '../roles';
import { proposalClimbVisibilityCondition } from './privacy';

export const proposalReportReleaseContextQueries = {
  proposalReportReleaseContexts: async (
    _: unknown,
    args: unknown,
    ctx: ConnectionContext,
  ): Promise<ProposalReportReleaseContext[]> => {
    if (!ctx.isAuthenticated || !ctx.userId) return [];
    await applyRateLimit(ctx, 30, 'proposalReportReleaseContexts');
    const { proposalUuid } = validateInput(ProposalReportReleaseContextsArgsSchema, args, 'proposalUuid');
    const [proposal] = await db
      .select({ boardType: dbSchema.climbProposals.boardType })
      .from(dbSchema.climbProposals)
      .where(
        and(
          eq(dbSchema.climbProposals.uuid, proposalUuid),
          proposalClimbVisibilityCondition(dbSchema.climbProposals, ctx.userId),
        ),
      )
      .limit(1);
    if (!proposal || !(await hasAdmin(ctx.userId, proposal.boardType))) return [];

    const reports = await db
      .select({ commentUuid: dbSchema.comments.uuid, releaseContext: dbSchema.comments.releaseContext })
      .from(dbSchema.comments)
      .where(
        and(
          eq(dbSchema.comments.entityType, 'proposal'),
          eq(dbSchema.comments.entityId, proposalUuid),
          isNull(dbSchema.comments.deletedAt),
          isNotNull(dbSchema.comments.releaseContext),
          commentPrivacyCondition(ctx.userId, dbSchema.comments, { entityType: 'proposal', entityId: proposalUuid }),
        ),
      )
      .orderBy(desc(dbSchema.comments.createdAt), desc(dbSchema.comments.id))
      .limit(100);
    return reports.flatMap((report) =>
      report.releaseContext ? [{ ...report, releaseContext: report.releaseContext }] : [],
    );
  },
};
