import { gql } from 'graphql-request';

export type PrivacyAudience = 'public' | 'followers' | 'only_me';
export type PrivacyResourceAudience = PrivacyAudience | 'unlisted' | 'invite_only';
export type PrivacyContentType = 'tick' | 'session' | 'comment' | 'playlist' | 'beta';
export type PrivacySettings = {
  isPrivate: boolean;
  privacyRevision: number;
  defaultSessionAudience: PrivacyResourceAudience;
  anonymousOnForeignBoards: boolean;
  enabled: boolean;
};
export type PrivacyRelationship = {
  userId: string;
  isPrivate: boolean;
  isFollowing: boolean;
  requestPending: boolean;
};
export type PrivacyFollowRequest = {
  requesterId: string;
  recipientId: string;
  createdAt: string;
  displayName: string | null;
  avatarUrl: string | null;
};
export type UpdatePrivacySettingsInput = Partial<Pick<PrivacySettings, 'isPrivate' | 'defaultSessionAudience'>>;

export const GET_PRIVACY_SETTINGS = gql`
  query PrivacySettings {
    privacySettings {
      isPrivate
      privacyRevision
      defaultSessionAudience
      anonymousOnForeignBoards
      enabled
    }
  }
`;
export const UPDATE_PRIVACY_SETTINGS = gql`
  mutation UpdatePrivacySettings($input: UpdatePrivacySettingsInput!) {
    updatePrivacySettings(input: $input) {
      isPrivate
      privacyRevision
      defaultSessionAudience
      anonymousOnForeignBoards
      enabled
    }
  }
`;
export const SET_ANONYMOUS_ON_FOREIGN_BOARDS = gql`
  mutation SetAnonymousOnForeignBoards($enabled: Boolean!) {
    setAnonymousOnForeignBoards(enabled: $enabled) {
      isPrivate
      privacyRevision
      defaultSessionAudience
      anonymousOnForeignBoards
      enabled
    }
  }
`;
export const GET_INCOMING_FOLLOW_REQUESTS = gql`
  query IncomingFollowRequests {
    incomingFollowRequests {
      requesterId
      recipientId
      createdAt
      displayName
      avatarUrl
    }
  }
`;
export const GET_PRIVACY_RELATIONSHIP = gql`
  query PrivacyRelationship($userId: ID!) {
    privacyRelationship(userId: $userId) {
      userId
      isPrivate
      isFollowing
      requestPending
    }
  }
`;
export const REQUEST_FOLLOW = gql`
  mutation RequestFollow($userId: ID!) {
    requestFollow(userId: $userId) {
      userId
      isPrivate
      isFollowing
      requestPending
    }
  }
`;
export const CANCEL_FOLLOW_REQUEST = gql`
  mutation CancelFollowRequest($userId: ID!) {
    cancelFollowRequest(userId: $userId)
  }
`;
export const APPROVE_FOLLOW_REQUEST = gql`
  mutation ApproveFollowRequest($userId: ID!) {
    approveFollowRequest(userId: $userId)
  }
`;
export const DECLINE_FOLLOW_REQUEST = gql`
  mutation DeclineFollowRequest($userId: ID!) {
    declineFollowRequest(userId: $userId)
  }
`;
export const REMOVE_FOLLOWER = gql`
  mutation RemoveFollower($userId: ID!) {
    removeFollower(userId: $userId)
  }
`;
export const SET_CONTENT_AUDIENCE = gql`
  mutation SetContentAudience($input: SetContentAudienceInput!) {
    setContentAudience(input: $input)
  }
`;
export type PrivacyContentAudience = { audience: PrivacyAudience; isExplicit: boolean; canEdit: boolean };
export type PrivacyLocationAudience = 'public' | 'followers' | 'members' | 'only_me';
export type ResourcePrivacySettings = {
  kind: 'board' | 'session';
  resourceId: string;
  ownerId: string | null;
  audience: PrivacyResourceAudience;
  locationAudience: PrivacyLocationAudience;
  inheritFollowers: boolean;
  revision: number;
};
export type PrivacyPublicationInput = { audience: PrivacyAudience; privacyRevision: number };
export const GET_CONTENT_AUDIENCE = gql`
  query ContentAudience($entityType: PrivacyContentType!, $entityId: ID!) {
    contentAudience(entityType: $entityType, entityId: $entityId) {
      audience
      isExplicit
      canEdit
    }
  }
`;
export const GET_RESOURCE_PRIVACY = gql`
  query ResourcePrivacy($kind: PrivacyResourceKind!, $resourceId: ID!) {
    resourcePrivacy(kind: $kind, resourceId: $resourceId) {
      kind
      resourceId
      ownerId
      audience
      locationAudience
      inheritFollowers
      revision
    }
  }
`;
export const UPDATE_RESOURCE_PRIVACY = gql`
  mutation UpdateResourcePrivacy($input: UpdateResourcePrivacyInput!) {
    updateResourcePrivacy(input: $input) {
      kind
      resourceId
      ownerId
      audience
      locationAudience
      inheritFollowers
      revision
    }
  }
`;
export const GET_RESOURCE_ACCESS_REQUESTS = gql`
  query ResourceAccessRequests($kind: PrivacyResourceKind!, $resourceId: ID!, $offset: Int, $userIds: [ID!]) {
    resourceAccessRequests(kind: $kind, resourceId: $resourceId, offset: $offset, userIds: $userIds) {
      userId
      status
      invitedBy
      displayName
      avatarUrl
    }
  }
`;
export const APPROVE_RESOURCE_ACCESS = gql`
  mutation ApproveResourceAccess($kind: PrivacyResourceKind!, $resourceId: ID!, $userId: ID!) {
    approveResourceAccess(kind: $kind, resourceId: $resourceId, userId: $userId)
  }
`;
export const REVOKE_RESOURCE_ACCESS = gql`
  mutation RevokeResourceAccess($kind: PrivacyResourceKind!, $resourceId: ID!, $userId: ID!) {
    revokeResourceAccess(kind: $kind, resourceId: $resourceId, userId: $userId)
  }
`;
export const REQUEST_RESOURCE_ACCESS = gql`
  mutation RequestResourceAccess($kind: PrivacyResourceKind!, $resourceId: ID!) {
    requestResourceAccess(kind: $kind, resourceId: $resourceId)
  }
`;
export const INVITE_RESOURCE_MEMBER = gql`
  mutation InviteResourceMember($kind: PrivacyResourceKind!, $resourceId: ID!, $userId: ID!) {
    inviteResourceMember(kind: $kind, resourceId: $resourceId, userId: $userId)
  }
`;
export const GET_PROFILE_PRIVACY = gql`
  query ProfilePrivacy($userId: ID!) {
    publicProfile(userId: $userId) {
      isPrivate
      canViewActivity
    }
  }
`;

/**
 * A home board's share link (`/b/{slug}?invite={token}`). The token is a
 * capability: pass it to these documents and nowhere else, never to a log line
 * or an analytics property.
 */
export type BoardShareLink = { boardUuid: string; token: string; path: string; createdAt: string };
export type BoardShareLinkRedemption = { boardUuid: string; slug: string };
export const GET_BOARD_SHARE_LINK = gql`
  query BoardShareLink($boardUuid: ID!) {
    boardShareLink(boardUuid: $boardUuid) {
      boardUuid
      token
      path
      createdAt
    }
  }
`;
export const RESET_BOARD_SHARE_LINK = gql`
  mutation ResetBoardShareLink($boardUuid: ID!) {
    resetBoardShareLink(boardUuid: $boardUuid) {
      boardUuid
      token
      path
      createdAt
    }
  }
`;
export const REDEEM_BOARD_SHARE_LINK = gql`
  mutation RedeemBoardShareLink($token: String!) {
    redeemBoardShareLink(token: $token) {
      boardUuid
      slug
    }
  }
`;
export const GET_BOARD_SHARE_LINK_PREVIEW = gql`
  query BoardShareLinkPreview($token: String!) {
    boardShareLinkPreview(token: $token) {
      name
    }
  }
`;
