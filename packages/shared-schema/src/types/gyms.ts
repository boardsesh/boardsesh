// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Gym entity types

/**
 * Max length of the free-text opening-hours line, shared by the backend
 * validator and every client that renders the field. A client capping below the
 * backend limit silently truncates; one capping above it lets the owner type
 * hours the mutation then rejects with no inline explanation.
 */
export const GYM_HOURS_MAX_LENGTH = 500;

/**
 * Hard byte cap on the gym PHOTO (`image_url`) upload, shared by the backend's
 * Busboy limit and the manage-console uploader that pre-checks before POSTing.
 * One number, one import: a client cap below the server's would reject photos
 * the server would have taken, and a client cap above it lets an owner sit
 * through a full upload only to get a 400 back.
 */
export const GYM_PHOTO_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type GymMemberRole = 'admin' | 'editor' | 'member';

export type GymClaimMethod = 'domain' | 'admin';

export type GymClaimStatus = 'pending' | 'approved' | 'denied' | 'expired';

export type GymClaimRequestStatus = 'email_sent' | 'admin_review' | 'approved';

export type GymClaimDecision = 'approve' | 'deny';

/**
 * One board-type + angle pair present at a gym, for the directory's board chips.
 * Distinct pairs only — two Kilter boards both at 40° collapse into one summary.
 */
export type GymBoardSummary = {
  boardType: string;
  angle: number;
};

/**
 * The viewer's own claim on a gym that is still waiting on an outcome — the
 * emailed domain link or a Boardsesh admin's decision.
 */
export type MyGymClaim = {
  id: string;
  method: GymClaimMethod;
  createdAt: string;
};

export type Gym = {
  uuid: string;
  slug?: string | null;
  ownerId: string;
  ownerDisplayName?: string | null;
  ownerAvatarUrl?: string | null;
  name: string;
  description?: string | null;
  /** Opening hours as one free-text line the gym maintains itself (no structured per-day model). */
  hours?: string | null;
  /** ISO timestamp of the last time someone with edit access confirmed `hours` — shown publicly so a stale schedule reads as stale. */
  hoursUpdatedAt?: string | null;
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
  /**
   * Distinct board-type + angle pairs at this gym, ordered by type then angle
   * and capped per board type. Non-null on the server, but OPTIONAL here because
   * only SEARCH_GYMS_DIRECTORY selects it — the shared GYM_FIELDS selection set
   * deliberately leaves it out, so a required type would promise a value that
   * GET_GYM / GET_GYM_BY_SLUG / GET_MY_GYMS / SEARCH_GYMS never return.
   */
  boardSummaries?: GymBoardSummary[];
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
  /**
   * Whether a real person owns this gym rather than the system import user.
   * Viewer-independent, and required here because GYM_FIELDS selects it — every
   * document typed `Gym` genuinely returns it.
   */
  isClaimed: boolean;
  /**
   * The viewer's unresolved claim on this gym, or null when they have none.
   * OPTIONAL on purpose: only GET_GYM_BY_SLUG selects it. Adding it to the
   * shared GYM_FIELDS would put it in documents the mobile app ships, where a
   * production OTA can reach devices before the backend deploy that answers the
   * field — and every mobile gym view would then fail GraphQL validation.
   */
  myPendingClaim?: MyGymClaim | null;
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

/** Why a board is surfaced as a candidate to attach to a gym. */
export type StrayBoardReason = 'MERGED_TWIN' | 'NEARBY';

export type StrayBoard = {
  uuid: string;
  name: string;
  /** The gym the board is currently linked to (a merged twin or a synced listing); null when unlinked. */
  currentGymUuid?: string | null;
  /** Name of the gym the board is currently linked to; null when unlinked. */
  currentGymName?: string | null;
  /** Metres from this gym's location to the board; null when either lacks coordinates. */
  distanceMeters?: number | null;
  reason: StrayBoardReason;
  /**
   * True when attaching this board empties the auto-synced listing it sits on,
   * which then folds into this gym. False for an unlinked board, and for a
   * listing that never folds (already merged, or owned by a person).
   */
  isLastBoardAtCurrentGym: boolean;
};

export type AttachBoardToGymInput = {
  gymUuid: string;
  boardUuid: string;
};

export type DetachBoardFromGymInput = {
  gymUuid: string;
  boardUuid: string;
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
  /** Free-text opening hours. Writing this stamps `hoursUpdatedAt`; explicit null clears both. */
  hours?: string | null;
  address?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  /** Gym photo. `undefined` leaves the column untouched; explicit `null` clears it. */
  imageUrl?: string | null;
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
  /** Only gyms with a slug, i.e. linkable at /gym/[slug]. Opt-in; omitting it leaves the emitted SQL unchanged. */
  requireSlug?: boolean;
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

export type ReportGymDuplicateInput = {
  gymUuid: string;
  duplicateGymUuid: string;
  note?: string;
};

export type ReportGymDuplicateStatus = 'reported' | 'already_reported';

export type ReportGymDuplicateResult = {
  status: ReportGymDuplicateStatus;
};
