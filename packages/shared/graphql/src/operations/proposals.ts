import { gql } from 'graphql-request';
import type {
  ProposalType,
  ProposalStatus,
  Proposal,
  ProposalConnection,
  ClimbCommunityStatusType,
  CommunityRoleAssignment,
  CommunityRoleType,
  CommunitySettingType,
  ReportClimbInput,
  ReportClimbResult,
} from '@boardsesh/shared-schema';

// ============================================
// Proposal Queries
// ============================================

export const GET_CLIMB_PROPOSALS = gql`
  query GetClimbProposals($input: GetClimbProposalsInput!) {
    climbProposals(input: $input) {
      proposals {
        uuid
        climbUuid
        boardType
        angle
        proposerId
        proposerDisplayName
        proposerAvatarUrl
        type
        proposedValue
        currentValue
        status
        reason
        resolvedAt
        resolvedBy
        createdAt
        weightedUpvotes
        weightedDownvotes
        requiredUpvotes
        userVote
        climbName
        frames
        layoutId
        climbSetterUsername
        climbDifficulty
        climbQualityAverage
        climbAscensionistCount
        climbDifficultyError
        climbBenchmarkDifficulty
        climbIsNoMatch
        upvoterCount
        commentCount
        climbIsHidden
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_CLIMB_COMMUNITY_STATUS = gql`
  query GetClimbCommunityStatus($climbUuid: String!, $boardType: String!, $angle: Int!) {
    climbCommunityStatus(climbUuid: $climbUuid, boardType: $boardType, angle: $angle) {
      climbUuid
      boardType
      angle
      communityGrade
      isBenchmark
      isClassic
      isFrozen
      freezeReason
      openProposalCount
      outlierAnalysis {
        isOutlier
        currentGrade
        neighborAverage
        neighborCount
        gradeDifference
      }
      updatedAt
    }
  }
`;

export const GET_BULK_CLIMB_COMMUNITY_STATUS = gql`
  query GetBulkClimbCommunityStatus($climbUuids: [String!]!, $boardType: String!, $angle: Int!) {
    bulkClimbCommunityStatus(climbUuids: $climbUuids, boardType: $boardType, angle: $angle) {
      climbUuid
      boardType
      angle
      communityGrade
      isBenchmark
      isClassic
      isFrozen
      freezeReason
      openProposalCount
      updatedAt
    }
  }
`;

export const BROWSE_PROPOSALS = gql`
  query BrowseProposals($input: BrowseProposalsInput!) {
    browseProposals(input: $input) {
      proposals {
        uuid
        climbUuid
        boardType
        angle
        proposerId
        proposerDisplayName
        proposerAvatarUrl
        type
        proposedValue
        currentValue
        status
        reason
        resolvedAt
        resolvedBy
        createdAt
        weightedUpvotes
        weightedDownvotes
        requiredUpvotes
        userVote
        climbName
        frames
        layoutId
        climbSetterUsername
        climbDifficulty
        climbQualityAverage
        climbAscensionistCount
        climbDifficultyError
        climbBenchmarkDifficulty
        climbIsNoMatch
        upvoterCount
        commentCount
        climbIsHidden
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_CLIMB_CLASSIC_STATUS = gql`
  query GetClimbClassicStatus($climbUuid: String!, $boardType: String!) {
    climbClassicStatus(climbUuid: $climbUuid, boardType: $boardType) {
      climbUuid
      boardType
      isClassic
      updatedAt
    }
  }
`;

// ============================================
// Proposal Mutations
// ============================================

export const CREATE_PROPOSAL = gql`
  mutation CreateProposal($input: CreateProposalInput!) {
    createProposal(input: $input) {
      uuid
      climbUuid
      boardType
      angle
      proposerId
      proposerDisplayName
      proposerAvatarUrl
      type
      proposedValue
      currentValue
      status
      reason
      createdAt
      weightedUpvotes
      weightedDownvotes
      requiredUpvotes
      userVote
      climbName
      frames
      layoutId
      climbSetterUsername
      climbDifficulty
      climbQualityAverage
      climbAscensionistCount
      climbDifficultyError
      climbBenchmarkDifficulty
      climbIsNoMatch
      upvoterCount
      commentCount
      climbIsHidden
    }
  }
`;

export const VOTE_ON_PROPOSAL = gql`
  mutation VoteOnProposal($input: VoteOnProposalInput!) {
    voteOnProposal(input: $input) {
      uuid
      climbUuid
      boardType
      angle
      proposerId
      proposerDisplayName
      proposerAvatarUrl
      type
      proposedValue
      currentValue
      status
      reason
      resolvedAt
      resolvedBy
      createdAt
      weightedUpvotes
      weightedDownvotes
      requiredUpvotes
      userVote
      climbName
      frames
      layoutId
      climbSetterUsername
      climbDifficulty
      climbQualityAverage
      climbAscensionistCount
      climbDifficultyError
      climbBenchmarkDifficulty
      climbIsNoMatch
      upvoterCount
      commentCount
      climbIsHidden
    }
  }
`;

export const RESOLVE_PROPOSAL = gql`
  mutation ResolveProposal($input: ResolveProposalInput!) {
    resolveProposal(input: $input) {
      uuid
      status
      resolvedAt
      resolvedBy
      weightedUpvotes
      weightedDownvotes
      requiredUpvotes
      userVote
      climbName
      frames
      layoutId
      climbSetterUsername
      climbDifficulty
      climbQualityAverage
      climbAscensionistCount
      climbDifficultyError
      climbBenchmarkDifficulty
      climbIsNoMatch
      upvoterCount
      commentCount
      climbIsHidden
    }
  }
`;

export const DELETE_PROPOSAL = gql`
  mutation DeleteProposal($input: DeleteProposalInput!) {
    deleteProposal(input: $input)
  }
`;

/**
 * One-tap climb report. The server decides whether this opens a proposal, joins
 * the open one, or does nothing because the reporter already reported it — the
 * returned `status` says which, and `proposal` is always the live proposal.
 */
export const REPORT_CLIMB = gql`
  mutation ReportClimb($input: ReportClimbInput!) {
    reportClimb(input: $input) {
      status
      proposal {
        uuid
        climbUuid
        boardType
        angle
        proposerId
        proposerDisplayName
        proposerAvatarUrl
        type
        proposedValue
        currentValue
        status
        reason
        resolvedAt
        resolvedBy
        createdAt
        weightedUpvotes
        weightedDownvotes
        requiredUpvotes
        userVote
        climbName
        frames
        layoutId
        climbSetterUsername
        climbDifficulty
        climbQualityAverage
        climbAscensionistCount
        climbDifficultyError
        climbBenchmarkDifficulty
        climbIsNoMatch
        upvoterCount
        commentCount
        climbIsHidden
      }
    }
  }
`;

export const SETTER_OVERRIDE = gql`
  mutation SetterOverrideCommunityStatus($input: SetterOverrideInput!) {
    setterOverrideCommunityStatus(input: $input) {
      climbUuid
      boardType
      angle
      communityGrade
      isBenchmark
      isClassic
      isFrozen
      updatedAt
    }
  }
`;

export const FREEZE_CLIMB = gql`
  mutation FreezeClimb($input: FreezeClimbInput!) {
    freezeClimb(input: $input)
  }
`;

// ============================================
// Role Queries & Mutations
// ============================================

export const GET_COMMUNITY_ROLES = gql`
  query GetCommunityRoles($boardType: String) {
    communityRoles(boardType: $boardType) {
      id
      userId
      userDisplayName
      userAvatarUrl
      role
      boardType
      grantedBy
      grantedByDisplayName
      createdAt
    }
  }
`;

export const GET_MY_ROLES = gql`
  query GetMyRoles {
    myRoles {
      id
      userId
      role
      boardType
      createdAt
    }
  }
`;

export const GRANT_ROLE = gql`
  mutation GrantRole($input: GrantRoleInput!) {
    grantRole(input: $input) {
      id
      userId
      userDisplayName
      userAvatarUrl
      role
      boardType
      grantedBy
      grantedByDisplayName
      createdAt
    }
  }
`;

export const REVOKE_ROLE = gql`
  mutation RevokeRole($input: RevokeRoleInput!) {
    revokeRole(input: $input)
  }
`;

// ============================================
// Community Settings Queries & Mutations
// ============================================

export const GET_COMMUNITY_SETTINGS = gql`
  query GetCommunitySettings($scope: String!, $scopeKey: String!) {
    communitySettings(scope: $scope, scopeKey: $scopeKey) {
      id
      scope
      scopeKey
      key
      value
      setBy
      createdAt
      updatedAt
    }
  }
`;

export const SET_COMMUNITY_SETTING = gql`
  mutation SetCommunitySettings($input: SetCommunitySettingInput!) {
    setCommunitySettings(input: $input) {
      id
      scope
      scopeKey
      key
      value
      setBy
      createdAt
      updatedAt
    }
  }
`;

// ============================================
// Variable & Response Types
// ============================================

export type GetClimbProposalsVariables = {
  input: {
    climbUuid: string;
    boardType: string;
    angle?: number | null;
    type?: ProposalType | null;
    status?: ProposalStatus | null;
    limit?: number;
    offset?: number;
  };
};

export type GetClimbProposalsResponse = {
  climbProposals: ProposalConnection;
};

export type GetClimbCommunityStatusVariables = {
  climbUuid: string;
  boardType: string;
  angle: number;
};

export type GetClimbCommunityStatusResponse = {
  climbCommunityStatus: ClimbCommunityStatusType;
};

export type GetBulkClimbCommunityStatusVariables = {
  climbUuids: string[];
  boardType: string;
  angle: number;
};

export type GetBulkClimbCommunityStatusResponse = {
  bulkClimbCommunityStatus: ClimbCommunityStatusType[];
};

export type BrowseProposalsVariables = {
  input: {
    boardType?: string | null;
    boardUuid?: string | null;
    type?: ProposalType | null;
    /** Filter by several proposal types (the moderation feed passes `['hide']`). */
    types?: ProposalType[] | null;
    status?: ProposalStatus | null;
    limit?: number;
    offset?: number;
  };
};

export type BrowseProposalsResponse = {
  browseProposals: ProposalConnection;
};

export type CreateProposalVariables = {
  input: {
    climbUuid: string;
    boardType: string;
    angle?: number | null;
    type: ProposalType;
    proposedValue: string;
    reason?: string | null;
  };
};

export type CreateProposalResponse = {
  createProposal: Proposal;
};

export type VoteOnProposalVariables = {
  input: {
    proposalUuid: string;
    value: number;
  };
};

export type VoteOnProposalResponse = {
  voteOnProposal: Proposal;
};

export type ResolveProposalVariables = {
  input: {
    proposalUuid: string;
    status: 'approved' | 'rejected';
    reason?: string | null;
  };
};

export type ResolveProposalResponse = {
  resolveProposal: Proposal;
};

export type DeleteProposalVariables = {
  input: {
    proposalUuid: string;
  };
};

export type DeleteProposalResponse = {
  deleteProposal: boolean;
};

export type ReportClimbVariables = {
  input: ReportClimbInput;
};

export type ReportClimbResponse = {
  reportClimb: ReportClimbResult;
};

export type FreezeClimbVariables = {
  input: {
    climbUuid: string;
    boardType: string;
    frozen: boolean;
    reason?: string | null;
  };
};

export type FreezeClimbResponse = {
  freezeClimb: boolean;
};

export type GetCommunityRolesVariables = {
  boardType?: string;
};

export type GetCommunityRolesResponse = {
  communityRoles: CommunityRoleAssignment[];
};

export type GetMyRolesResponse = {
  myRoles: CommunityRoleAssignment[];
};

export type GrantRoleVariables = {
  input: {
    userId: string;
    role: CommunityRoleType;
    boardType?: string | null;
  };
};

export type GrantRoleResponse = {
  grantRole: CommunityRoleAssignment;
};

export type RevokeRoleVariables = {
  input: {
    userId: string;
    role: CommunityRoleType;
    boardType?: string | null;
  };
};

export type RevokeRoleResponse = {
  revokeRole: boolean;
};

export type GetCommunitySettingsVariables = {
  scope: string;
  scopeKey: string;
};

export type GetCommunitySettingsResponse = {
  communitySettings: CommunitySettingType[];
};

export type SetCommunitySettingVariables = {
  input: {
    scope: string;
    scopeKey: string;
    key: string;
    value: string;
  };
};

export type SetCommunitySettingResponse = {
  setCommunitySettings: CommunitySettingType;
};
