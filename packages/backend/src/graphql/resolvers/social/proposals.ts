export { socialProposalQueries, socialProposalMutations } from './proposals/index';

// Re-export helpers for any external consumers
export { enrichProposal, batchEnrichProposals } from './proposals/enrichment';
export { applyProposalEffect, revertProposalEffect } from './proposals/effects';
export { analyzeGradeOutlier, checkAutoApproval, resolveApprovalThreshold } from './proposals/grade-analysis';
export { setterOverrideCommunityStatus, freezeClimb } from './proposals/setter-overrides';
