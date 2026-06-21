// Community Proposals + Admin Roles types

export type ProposalType = 'grade' | 'classic' | 'benchmark';
export type ProposalStatus = 'open' | 'approved' | 'rejected' | 'superseded';
export type CommunityRoleType = 'admin' | 'community_leader' | 'tester';

export type Proposal = {
  uuid: string;
  climbUuid: string;
  boardType: string;
  angle?: number | null;
  proposerId: string;
  proposerDisplayName?: string | null;
  proposerAvatarUrl?: string | null;
  type: ProposalType;
  proposedValue: string;
  currentValue: string;
  status: ProposalStatus;
  reason?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  createdAt: string;
  weightedUpvotes: number;
  weightedDownvotes: number;
  requiredUpvotes: number;
  userVote: number;
  climbName?: string | null;
  frames?: string | null;
  layoutId?: number | null;
  climbSetterUsername?: string | null;
  climbDifficulty?: string | null;
  climbQualityAverage?: string | null;
  climbAscensionistCount?: number | null;
  climbDifficultyError?: string | null;
  climbBenchmarkDifficulty?: string | null;
  climbIsNoMatch?: boolean | null;
};

export type ProposalConnection = {
  proposals: Proposal[];
  totalCount: number;
  hasMore: boolean;
};

export type ProposalVoteSummary = {
  weightedUpvotes: number;
  weightedDownvotes: number;
  requiredUpvotes: number;
  isApproved: boolean;
};

export type OutlierAnalysis = {
  isOutlier: boolean;
  currentGrade: number;
  neighborAverage: number;
  neighborCount: number;
  gradeDifference: number;
};

export type ClimbCommunityStatusType = {
  climbUuid: string;
  boardType: string;
  angle: number;
  communityGrade?: string | null;
  isBenchmark: boolean;
  isClassic: boolean;
  isFrozen: boolean;
  freezeReason?: string | null;
  openProposalCount: number;
  outlierAnalysis?: OutlierAnalysis | null;
  updatedAt?: string | null;
};

export type ClimbClassicStatusType = {
  climbUuid: string;
  boardType: string;
  isClassic: boolean;
  updatedAt?: string | null;
};

export type CommunityRoleAssignment = {
  id: number;
  userId: string;
  userDisplayName?: string | null;
  userAvatarUrl?: string | null;
  role: CommunityRoleType;
  boardType?: string | null;
  grantedBy?: string | null;
  grantedByDisplayName?: string | null;
  createdAt: string;
};

export type CommunitySettingType = {
  id: number;
  scope: string;
  scopeKey: string;
  key: string;
  value: string;
  setBy?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateProposalInput = {
  climbUuid: string;
  boardType: string;
  angle?: number | null;
  type: ProposalType;
  proposedValue: string;
  reason?: string | null;
};

export type VoteOnProposalInput = {
  proposalUuid: string;
  value: number; // +1 or -1
};

export type ResolveProposalInput = {
  proposalUuid: string;
  status: 'approved' | 'rejected';
  reason?: string | null;
};

export type SetterOverrideInput = {
  climbUuid: string;
  boardType: string;
  angle: number;
  communityGrade?: string | null;
  isBenchmark?: boolean | null;
};

export type FreezeClimbInput = {
  climbUuid: string;
  boardType: string;
  frozen: boolean;
  reason?: string | null;
};

export type GrantRoleInput = {
  userId: string;
  role: CommunityRoleType;
  boardType?: string | null;
};

export type RevokeRoleInput = {
  userId: string;
  role: CommunityRoleType;
  boardType?: string | null;
};

export type SetCommunitySettingInput = {
  scope: string;
  scopeKey: string;
  key: string;
  value: string;
};

export type GetClimbProposalsInput = {
  climbUuid: string;
  boardType: string;
  angle?: number | null;
  type?: ProposalType | null;
  status?: ProposalStatus | null;
  limit?: number;
  offset?: number;
};

export type BrowseProposalsInput = {
  boardType?: string | null;
  type?: ProposalType | null;
  status?: ProposalStatus | null;
  limit?: number;
  offset?: number;
};
