import { gql } from 'graphql-request';
import type {
  Gym,
  GymConnection,
  GymMemberConnection,
  CreateGymInput,
  UpdateGymInput,
  AddGymMemberInput,
  RemoveGymMemberInput,
  FollowGymInput,
  MyGymsInput,
  SearchGymsInput,
  GymMembersInput,
  LinkBoardToGymInput,
  GrantGymWriteAccessInput,
  RevokeGymWriteAccessInput,
  RequestGymClaimInput,
  RequestGymClaimResult,
  ReviewGymClaimInput,
  PendingGymClaimsInput,
  GymClaimConnection,
  FindSimilarGymsInput,
  SimilarGym,
  UserBoard,
  GymStats,
  GymStatsInput,
  DuplicateGymClustersInput,
  DuplicateGymClusterConnection,
  OrphanGymsInput,
  OrphanGymConnection,
  MergeGymsInput,
  MergeGymsResult,
  DismissGymClusterInput,
  ReportGymDuplicateInput,
  ReportGymDuplicateResult,
} from '@boardsesh/shared-schema';

// ============================================
// Gym Queries
// ============================================

const GYM_FIELDS = `
  uuid
  slug
  ownerId
  ownerDisplayName
  ownerAvatarUrl
  name
  description
  address
  website
  contactEmail
  contactPhone
  latitude
  longitude
  isPublic
  imageUrl
  logoUrl
  brandPrimaryColor
  brandAccentColor
  brandBackgroundColor
  createdAt
  boardCount
  boardTypes
  memberCount
  followerCount
  commentCount
  isFollowedByMe
  isMember
  myRole
  canEdit
  canGrantAccess
  canClaim
`;

export const GET_GYM = gql`
  query GetGym($gymUuid: ID!) {
    gym(gymUuid: $gymUuid) {
      ${GYM_FIELDS}
    }
  }
`;

export const GET_GYM_BY_SLUG = gql`
  query GetGymBySlug($slug: String!) {
    gymBySlug(slug: $slug) {
      ${GYM_FIELDS}
    }
  }
`;

export const GET_MY_GYMS = gql`
  query GetMyGyms($input: MyGymsInput) {
    myGyms(input: $input) {
      gyms {
        ${GYM_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export const SEARCH_GYMS = gql`
  query SearchGyms($input: SearchGymsInput!) {
    searchGyms(input: $input) {
      gyms {
        ${GYM_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export const FIND_SIMILAR_GYMS = gql`
  query FindSimilarGyms($input: FindSimilarGymsInput!) {
    findSimilarGyms(input: $input) {
      uuid
      slug
      name
      address
      website
      distanceMeters
      ownerType
      isClaimable
      providerOrigins
    }
  }
`;

export const GET_GYM_MEMBERS = gql`
  query GetGymMembers($input: GymMembersInput!) {
    gymMembers(input: $input) {
      members {
        userId
        displayName
        avatarUrl
        role
        createdAt
      }
      totalCount
      hasMore
    }
  }
`;

// Board fields the manage-gym board pickers and the leaderboard embed read from
// gymBoards. `boardId` is the numeric board-presence channel id (null unless the
// board is public or the viewer can edit it) — it feeds boardNowPlaying(boardId).
const GYM_BOARD_FIELDS = `
  uuid
  slug
  ownerId
  name
  boardType
  layoutId
  sizeId
  setIds
  angle
  isAngleAdjustable
  isPublic
  isUnlisted
  locationName
  gymId
  gymUuid
  boardId
  canEdit
`;

export const GET_GYM_BOARDS = gql`
  query GetGymBoards($gymUuid: ID!) {
    gymBoards(gymUuid: $gymUuid) {
      ${GYM_BOARD_FIELDS}
    }
  }
`;

// Owner Insights dashboard: current + prior window counts (for week-over-week
// deltas), the top-10 climbs, and busiest weekdays. Requires gym edit access.
export const GET_GYM_STATS = gql`
  query GetGymStats($input: GymStatsInput!) {
    gymStats(input: $input) {
      gymUuid
      periodDays
      current {
        uniqueClimbers
        ascentCount
      }
      previous {
        uniqueClimbers
        ascentCount
      }
      topClimbs {
        climbUuid
        boardType
        angle
        name
        gradeName
        ascentCount
      }
      busiestDays {
        dayOfWeek
        ascentCount
      }
    }
  }
`;

// ============================================
// Gym Mutations
// ============================================

export const CREATE_GYM = gql`
  mutation CreateGym($input: CreateGymInput!) {
    createGym(input: $input) {
      ${GYM_FIELDS}
    }
  }
`;

export const UPDATE_GYM = gql`
  mutation UpdateGym($input: UpdateGymInput!) {
    updateGym(input: $input) {
      ${GYM_FIELDS}
    }
  }
`;

export const DELETE_GYM = gql`
  mutation DeleteGym($gymUuid: ID!) {
    deleteGym(gymUuid: $gymUuid)
  }
`;

export const ADD_GYM_MEMBER = gql`
  mutation AddGymMember($input: AddGymMemberInput!) {
    addGymMember(input: $input)
  }
`;

export const REMOVE_GYM_MEMBER = gql`
  mutation RemoveGymMember($input: RemoveGymMemberInput!) {
    removeGymMember(input: $input)
  }
`;

export const FOLLOW_GYM = gql`
  mutation FollowGym($input: FollowGymInput!) {
    followGym(input: $input)
  }
`;

export const UNFOLLOW_GYM = gql`
  mutation UnfollowGym($input: FollowGymInput!) {
    unfollowGym(input: $input)
  }
`;

export const LINK_BOARD_TO_GYM = gql`
  mutation LinkBoardToGym($input: LinkBoardToGymInput!) {
    linkBoardToGym(input: $input)
  }
`;

export const GRANT_GYM_WRITE_ACCESS = gql`
  mutation GrantGymWriteAccess($input: GrantGymWriteAccessInput!) {
    grantGymWriteAccess(input: $input)
  }
`;

export const REVOKE_GYM_WRITE_ACCESS = gql`
  mutation RevokeGymWriteAccess($input: RevokeGymWriteAccessInput!) {
    revokeGymWriteAccess(input: $input)
  }
`;

export const REQUEST_GYM_CLAIM = gql`
  mutation RequestGymClaim($input: RequestGymClaimInput!) {
    requestGymClaim(input: $input) {
      status
      email
    }
  }
`;

export const REVIEW_GYM_CLAIM = gql`
  mutation ReviewGymClaim($input: ReviewGymClaimInput!) {
    reviewGymClaim(input: $input)
  }
`;

// ============================================
// Gym Claim Admin Queue
// ============================================

const GYM_CLAIM_FIELDS = `
  id
  gymUuid
  gymName
  claimantUserId
  claimantDisplayName
  claimantAvatarUrl
  method
  status
  claimEmail
  message
  createdAt
`;

export const PENDING_GYM_CLAIMS = gql`
  query PendingGymClaims($input: PendingGymClaimsInput) {
    pendingGymClaims(input: $input) {
      claims {
        ${GYM_CLAIM_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

// ============================================
// Gym Duplicate Review Admin Queue
// ============================================

const DUPLICATE_GYM_CLUSTER_FIELDS = `
  signature
  tier
  normalizedName
  suggestedCanonicalGymUuid
  maxDistanceMeters
  members {
    gymUuid
    name
    address
    ownerType
    claimStatus
    providerOrigins
    boardCount
    followerCount
    memberCount
    kioskCount
    claimCount
    createdAt
    latitude
    longitude
    distanceToCanonicalMeters
    isSuggestedCanonical
  }
`;

export const DUPLICATE_GYM_CLUSTERS = gql`
  query DuplicateGymClusters($input: DuplicateGymClustersInput) {
    duplicateGymClusters(input: $input) {
      clusters {
        ${DUPLICATE_GYM_CLUSTER_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export const ORPHAN_GYMS = gql`
  query OrphanGyms($input: OrphanGymsInput) {
    orphanGyms(input: $input) {
      gyms {
        gymUuid
        slug
        name
        address
        boardCount
        followerCount
        memberCount
        kioskCount
        createdAt
      }
      totalCount
      hasMore
    }
  }
`;

export const MERGE_GYMS = gql`
  mutation MergeGyms($input: MergeGymsInput!) {
    mergeGyms(input: $input) {
      canonicalGymUuid
      results {
        duplicateGymUuid
        counts {
          boards
          follows
          members
          claims
          kiosks
          comments
        }
        warnings {
          kioskUuid
          kioskName
          previousSlug
          newSlug
        }
      }
    }
  }
`;

export const DISMISS_GYM_CLUSTER = gql`
  mutation DismissGymCluster($input: DismissGymClusterInput!) {
    dismissGymCluster(input: $input)
  }
`;

export const REPORT_GYM_DUPLICATE = gql`
  mutation ReportGymDuplicate($input: ReportGymDuplicateInput!) {
    reportGymDuplicate(input: $input) {
      status
    }
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export type GetGymQueryVariables = {
  gymUuid: string;
};

export type GetGymQueryResponse = {
  gym: Gym | null;
};

export type GetGymBySlugQueryVariables = {
  slug: string;
};

export type GetGymBySlugQueryResponse = {
  gymBySlug: Gym | null;
};

export type GetMyGymsQueryVariables = {
  input?: MyGymsInput;
};

export type GetMyGymsQueryResponse = {
  myGyms: GymConnection;
};

export type SearchGymsQueryVariables = {
  input: SearchGymsInput;
};

export type SearchGymsQueryResponse = {
  searchGyms: GymConnection;
};

export type FindSimilarGymsQueryVariables = {
  input: FindSimilarGymsInput;
};

export type FindSimilarGymsQueryResponse = {
  findSimilarGyms: SimilarGym[];
};

export type GetGymMembersQueryVariables = {
  input: GymMembersInput;
};

export type GetGymMembersQueryResponse = {
  gymMembers: GymMemberConnection;
};

export type GetGymBoardsQueryVariables = {
  gymUuid: string;
};

export type GetGymBoardsQueryResponse = {
  gymBoards: UserBoard[];
};

export type GetGymStatsQueryVariables = {
  input: GymStatsInput;
};

export type GetGymStatsQueryResponse = {
  gymStats: GymStats;
};

export type CreateGymMutationVariables = {
  input: CreateGymInput;
};

export type CreateGymMutationResponse = {
  createGym: Gym;
};

export type UpdateGymMutationVariables = {
  input: UpdateGymInput;
};

export type UpdateGymMutationResponse = {
  updateGym: Gym;
};

export type DeleteGymMutationVariables = {
  gymUuid: string;
};

export type DeleteGymMutationResponse = {
  deleteGym: boolean;
};

export type AddGymMemberMutationVariables = {
  input: AddGymMemberInput;
};

export type AddGymMemberMutationResponse = {
  addGymMember: boolean;
};

export type RemoveGymMemberMutationVariables = {
  input: RemoveGymMemberInput;
};

export type RemoveGymMemberMutationResponse = {
  removeGymMember: boolean;
};

export type FollowGymMutationVariables = {
  input: FollowGymInput;
};

export type FollowGymMutationResponse = {
  followGym: boolean;
};

export type UnfollowGymMutationVariables = {
  input: FollowGymInput;
};

export type UnfollowGymMutationResponse = {
  unfollowGym: boolean;
};

export type LinkBoardToGymMutationVariables = {
  input: LinkBoardToGymInput;
};

export type LinkBoardToGymMutationResponse = {
  linkBoardToGym: boolean;
};

export type GrantGymWriteAccessMutationVariables = {
  input: GrantGymWriteAccessInput;
};

export type GrantGymWriteAccessMutationResponse = {
  grantGymWriteAccess: boolean;
};

export type RevokeGymWriteAccessMutationVariables = {
  input: RevokeGymWriteAccessInput;
};

export type RevokeGymWriteAccessMutationResponse = {
  revokeGymWriteAccess: boolean;
};

export type RequestGymClaimMutationVariables = {
  input: RequestGymClaimInput;
};

export type RequestGymClaimMutationResponse = {
  requestGymClaim: RequestGymClaimResult;
};

export type ReviewGymClaimMutationVariables = {
  input: ReviewGymClaimInput;
};

export type ReviewGymClaimMutationResponse = {
  reviewGymClaim: boolean;
};

export type PendingGymClaimsQueryVariables = {
  input?: PendingGymClaimsInput;
};

export type PendingGymClaimsQueryResponse = {
  pendingGymClaims: GymClaimConnection;
};

export type DuplicateGymClustersQueryVariables = {
  input?: DuplicateGymClustersInput;
};

export type DuplicateGymClustersQueryResponse = {
  duplicateGymClusters: DuplicateGymClusterConnection;
};

export type OrphanGymsQueryVariables = {
  input?: OrphanGymsInput;
};

export type OrphanGymsQueryResponse = {
  orphanGyms: OrphanGymConnection;
};

export type MergeGymsMutationVariables = {
  input: MergeGymsInput;
};

export type MergeGymsMutationResponse = {
  mergeGyms: MergeGymsResult;
};

export type DismissGymClusterMutationVariables = {
  input: DismissGymClusterInput;
};

export type DismissGymClusterMutationResponse = {
  dismissGymCluster: boolean;
};

export type ReportGymDuplicateMutationVariables = {
  input: ReportGymDuplicateInput;
};

export type ReportGymDuplicateMutationResponse = {
  reportGymDuplicate: ReportGymDuplicateResult;
};
