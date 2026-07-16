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
  /** Square gym logo (transparent brand mark) for the kiosk and embeds — distinct from imageUrl, the gym photo. */
  logoUrl?: string | null;
  /** Kiosk/embed brand primary colour as #RRGGBB (null when unset). */
  brandPrimaryColor?: string | null;
  /** Kiosk/embed brand accent colour as #RRGGBB (null when unset). */
  brandAccentColor?: string | null;
  /** Kiosk/embed brand background colour as #RRGGBB (null when unset). */
  brandBackgroundColor?: string | null;
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

export type GymOwnerType = 'SYSTEM' | 'USER';

export type SimilarGym = {
  uuid: string;
  slug?: string | null;
  name: string;
  address?: string | null;
  website?: string | null;
  /** Distance in metres from the supplied coordinates; null when no coordinates were given. */
  distanceMeters?: number | null;
  ownerType: GymOwnerType;
  isClaimable: boolean;
  /** Upstream provider origins for a synced gym (e.g. "kilter"); empty for user-created gyms. */
  providerOrigins: string[];
};

export type FindSimilarGymsInput = {
  name: string;
  latitude?: number;
  longitude?: number;
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
  // Branding: `undefined` leaves the column untouched; explicit `null` clears it
  // (reset-to-default in the manage UI).
  logoUrl?: string | null;
  brandPrimaryColor?: string | null;
  brandAccentColor?: string | null;
  brandBackgroundColor?: string | null;
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

// ============================================
// Gym Insights (owner activity dashboard)
// ============================================

export type GymStatsPeriod = 'week' | 'month';

export type GymTopClimb = {
  climbUuid: string;
  boardType: string;
  angle: number;
  name?: string | null;
  gradeName?: string | null;
  ascentCount: number;
};

export type GymDayActivity = {
  /** Postgres EXTRACT(DOW): 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  ascentCount: number;
};

export type GymStatsWindow = {
  uniqueClimbers: number;
  ascentCount: number;
};

export type GymStats = {
  gymUuid: string;
  periodDays: number;
  current: GymStatsWindow;
  previous: GymStatsWindow;
  /** Top 10 climbs by ascents in the current window. */
  topClimbs: GymTopClimb[];
  /** Ascents per day of week in the current window (non-empty days only). */
  busiestDays: GymDayActivity[];
};

export type GymStatsInput = {
  gymUuid: string;
  period?: GymStatsPeriod;
};

// ============================================
// Gym duplicate review (admin)
// ============================================

// Distinct from the similar-gyms search's GymOwnerType ('SYSTEM' | 'USER').
export type DuplicateGymOwnerType = 'system' | 'user';

export type GymClusterClaimStatus = 'none' | 'pending' | 'approved';

export type DuplicateClusterTier = 'A' | 'B';

export type DuplicateGymMember = {
  gymUuid: string;
  name: string;
  address?: string | null;
  ownerType: DuplicateGymOwnerType;
  claimStatus: GymClusterClaimStatus;
  providerOrigins: string[];
  boardCount: number;
  followerCount: number;
  memberCount: number;
  kioskCount: number;
  claimCount: number;
  createdAt: string;
  latitude: number;
  longitude: number;
  distanceToCanonicalMeters: number;
  isSuggestedCanonical: boolean;
};

export type DuplicateGymCluster = {
  signature: string;
  tier: DuplicateClusterTier;
  normalizedName: string;
  suggestedCanonicalGymUuid: string;
  maxDistanceMeters: number;
  members: DuplicateGymMember[];
};

export type DuplicateGymClusterConnection = {
  clusters: DuplicateGymCluster[];
  totalCount: number;
  hasMore: boolean;
};

export type DuplicateGymClustersInput = {
  limit?: number;
  offset?: number;
};

export type OrphanGym = {
  gymUuid: string;
  slug?: string | null;
  name: string;
  address?: string | null;
  boardCount: number;
  followerCount: number;
  memberCount: number;
  kioskCount: number;
  createdAt: string;
};

export type OrphanGymConnection = {
  gyms: OrphanGym[];
  totalCount: number;
  hasMore: boolean;
};

export type OrphanGymsInput = {
  limit?: number;
  offset?: number;
};

export type MergeGymsInput = {
  canonicalGymUuid: string;
  duplicateGymUuids: string[];
  /** Explicit acknowledgement to keep a SYSTEM listing as the survivor over a user-owned/claim-approved duplicate. */
  allowSystemCanonicalOverride?: boolean;
};

export type KioskSlugWarning = {
  kioskUuid: string;
  kioskName: string;
  previousSlug: string;
  newSlug: string;
};

export type GymMergeCounts = {
  boards: number;
  follows: number;
  members: number;
  claims: number;
  kiosks: number;
  comments: number;
};

export type GymMergeDuplicateResult = {
  duplicateGymUuid: string;
  counts: GymMergeCounts;
  warnings: KioskSlugWarning[];
};

export type MergeGymsResult = {
  canonicalGymUuid: string;
  results: GymMergeDuplicateResult[];
};

export type DismissGymClusterInput = {
  gymUuids: string[];
  canonicalGymUuid: string;
};
