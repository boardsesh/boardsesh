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

export type GetGymMembersQueryVariables = {
  input: GymMembersInput;
};

export type GetGymMembersQueryResponse = {
  gymMembers: GymMemberConnection;
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
