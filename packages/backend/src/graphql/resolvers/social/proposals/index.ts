export { socialProposalQueries } from './queries';
export { socialProposalMutations } from './mutations';

// Re-export helpers for potential external use
export { enrichProposal, batchEnrichProposals } from './enrichment';
export { applyProposalEffect, revertProposalEffect } from './effects';
export { analyzeGradeOutlier, checkAutoApproval, resolveApprovalThreshold } from './grade-analysis';
export { setterOverrideCommunityStatus, freezeClimb } from './setter-overrides';
export {
  addWeightedUpvote,
  assertAngleForType,
  assertNotFrozen,
  findOpenProposal,
  insertProposalWithProposerVote,
  loadTargetClimb,
  normalizeAngleForType,
  publishProposalCreated,
  publishProposalVoted,
  resolveCurrentValue,
  runAutoApproval,
  withProposalLock,
  type ProposalExecutor,
  type ProposalRow,
  type ProposalTypeName,
  type TargetClimb,
} from './lifecycle';
