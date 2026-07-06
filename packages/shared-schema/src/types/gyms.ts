// Gym entity types

export type GymMemberRole = 'admin' | 'editor' | 'member';

export type GymClaimMethod = 'domain' | 'admin';

export type GymClaimStatus = 'pending' | 'approved' | 'denied' | 'expired';

export type GymClaimRequestStatus = 'email_sent' | 'admin_review';

export type GymClaimDecision = 'approve' | 'deny';

export type Gym = {
  uuid: string;
  slug?: string | null;
  ownerId: string;
  ownerDisplayName?: string | null;
  ownerAvatarUrl?: string | null;
  name: string;
  description?: string | null;
  address?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic: boolean;
  imageUrl?: string | null;
  createdAt: string;
  boardCount: number;
  boardTypes: string[];
  memberCount: number;
  followerCount: number;
  commentCount: number;
  isFollowedByMe: boolean;
  isMember: boolean;
  myRole?: GymMemberRole | null;
  /** Whether the current viewer may edit this gym (owner, gym admin, gym editor, or community admin/leader for one of its board types). */
  canEdit: boolean;
  /** Whether the current viewer may grant/revoke write access to other users. */
  canGrantAccess: boolean;
  /** Whether the current viewer may start an ownership claim for this gym. */
  canClaim: boolean;
};

export type GymConnection = {
  gyms: Gym[];
  totalCount: number;
  hasMore: boolean;
};

export type GymMember = {
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  role: GymMemberRole;
  createdAt: string;
};

export type GymMemberConnection = {
  members: GymMember[];
  totalCount: number;
  hasMore: boolean;
};

export type CreateGymInput = {
  name: string;
  description?: string;
  address?: string;
  website?: string;
  contactEmail?: string;
  contactPhone?: string;
  latitude?: number;
  longitude?: number;
  isPublic?: boolean;
  imageUrl?: string;
  boardUuid?: string;
};

export type UpdateGymInput = {
  gymUuid: string;
  name?: string;
  slug?: string;
  description?: string | null;
  address?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  imageUrl?: string;
};

export type GrantGymWriteAccessInput = {
  gymUuid: string;
  userId: string;
};

export type RevokeGymWriteAccessInput = {
  gymUuid: string;
  userId: string;
};

export type RequestGymClaimInput = {
  gymUuid: string;
  claimEmail?: string;
  message?: string;
};

export type RequestGymClaimResult = {
  status: GymClaimRequestStatus;
  email?: string | null;
};

export type GymClaim = {
  id: string;
  gymUuid: string;
  gymName: string;
  claimantUserId: string;
  claimantDisplayName?: string | null;
  claimantAvatarUrl?: string | null;
  method: GymClaimMethod;
  status: GymClaimStatus;
  claimEmail?: string | null;
  message?: string | null;
  createdAt: string;
};

export type GymClaimConnection = {
  claims: GymClaim[];
  totalCount: number;
  hasMore: boolean;
};

export type ReviewGymClaimInput = {
  claimId: string;
  decision: GymClaimDecision;
};

export type PendingGymClaimsInput = {
  limit?: number;
  offset?: number;
};

export type AddGymMemberInput = {
  gymUuid: string;
  userId: string;
  role: GymMemberRole;
};

export type RemoveGymMemberInput = {
  gymUuid: string;
  userId: string;
};

export type FollowGymInput = {
  gymUuid: string;
};

export type MyGymsInput = {
  includeFollowed?: boolean;
  limit?: number;
  offset?: number;
};

export type SearchGymsInput = {
  query?: string;
  boardTypes?: string[];
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit?: number;
  offset?: number;
};

export type GymMembersInput = {
  gymUuid: string;
  limit?: number;
  offset?: number;
};

export type LinkBoardToGymInput = {
  boardUuid: string;
  gymUuid?: string | null;
};
