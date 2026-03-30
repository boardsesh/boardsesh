/**
 * Core types for the SPA.
 * Simplified versions of the full web package types for the initial port.
 */

/** A climb returned from search queries. */
export interface Climb {
  uuid: string
  name: string
  setter_username: string
  frames: string
  angle: number
  ascensionist_count: number
  difficulty: string
  quality_average: string
  stars: number
  difficulty_error: string
  litUpHoldsMap: Record<string, unknown>
  mirrored?: boolean
  benchmark_difficulty: string | null
  userAscents?: number
  userAttempts?: number
}

/** Result of a climb search query. */
export interface ClimbSearchResult {
  climbs: Climb[]
  totalCount: number
  hasMore: boolean
}

/** Climb detail returned from the climbDetail query. */
export interface ClimbDetail {
  uuid: string
  setter_username: string
  name: string
  description: string
  frames: string
  angle: number
  ascensionist_count: number
  difficulty: string
  quality_average: string
  difficulty_error: string
  benchmark_difficulty: string | null
  litUpHoldsMap: Record<string, unknown>
}

/** Stats for a climb at a specific angle. */
export interface ClimbStatsForAngle {
  angle: number
  ascensionistCount: number
  qualityAverage: number | null
  difficultyAverage: number | null
  displayDifficulty: number | null
  faUsername: string | null
  faAt: string | null
  difficulty: string | null
}

/** A beta (video) link for a climb. */
export interface BetaLink {
  climbUuid: string
  link: string
  foreignUsername: string | null
  angle: number | null
  thumbnail: string | null
  isListed: boolean | null
  createdAt: string | null
}

/** A difficulty grade. */
export interface Grade {
  difficultyId: number
  name: string
}

/** A playlist. */
export interface Playlist {
  id: string
  uuid: string
  boardType: string
  layoutId: number | null
  name: string
  description: string | null
  isPublic: boolean
  color: string | null
  icon: string | null
  createdAt: string
  updatedAt: string
  climbCount: number
  userRole: string | null
  followerCount: number
  isFollowedByMe: boolean
}

/** Public user profile. */
export interface PublicUserProfile {
  id: string
  displayName: string | null
  avatarUrl: string | null
  followerCount: number
  followingCount: number
  isFollowedByMe: boolean
}

/** Grade count for profile stats. */
export interface GradeCount {
  grade: string
  count: number
}

/** Profile statistics. */
export interface ProfileStats {
  totalSends: number
  totalAttempts: number
  distinctClimbsSent: number
  gradeCounts: GradeCount[]
}

/** Setter profile. */
export interface SetterProfile {
  username: string
  climbCount: number
  boardTypes: string[]
  followerCount: number
  isFollowedByMe: boolean
  linkedUserId: string | null
  linkedUserDisplayName: string | null
  linkedUserAvatarUrl: string | null
}

/** Setter climb. */
export interface SetterClimb {
  uuid: string
  name: string | null
  boardType: string
  layoutId: number
  angle: number | null
  difficultyName: string | null
  qualityAverage: number | null
  ascensionistCount: number | null
  createdAt: string | null
}

/** Setter climbs connection. */
export interface SetterClimbsConnection {
  climbs: SetterClimb[]
  totalCount: number
  hasMore: boolean
}

/** Session user. */
export interface SessionUser {
  id: string
  username: string
  isLeader: boolean
  avatarUrl: string | null
}

/** Session. */
export interface Session {
  id: string
  name: string | null
  boardPath: string
  users: SessionUser[]
  isLeader: boolean
  isPublic: boolean
  startedAt: string | null
  endedAt: string | null
  goal: string | null
}

/** Session grade count. */
export interface SessionGradeCount {
  grade: string
  count: number
}

/** Session hardest climb. */
export interface SessionHardestClimb {
  climbUuid: string
  climbName: string
  grade: string
}

/** Session participant. */
export interface SessionParticipant {
  userId: string
  displayName: string | null
  avatarUrl: string | null
  sends: number
  attempts: number
}

/** Session summary. */
export interface SessionSummary {
  sessionId: string
  totalSends: number
  totalAttempts: number
  gradeDistribution: SessionGradeCount[]
  hardestClimb: SessionHardestClimb | null
  participants: SessionParticipant[]
  startedAt: string | null
  endedAt: string | null
  durationMinutes: number | null
  goal: string | null
}

/** Grouped notification actor. */
export interface GroupedNotificationActor {
  id: string
  displayName: string | null
  avatarUrl: string | null
}

/** Grouped notification. */
export interface GroupedNotification {
  uuid: string
  type: string
  entityType: string | null
  entityId: string | null
  actorCount: number
  actors: GroupedNotificationActor[]
  commentBody: string | null
  climbName: string | null
  climbUuid: string | null
  boardType: string | null
  proposalUuid: string | null
  setterUsername: string | null
  isRead: boolean
  createdAt: string
}

/** Grouped notification connection. */
export interface GroupedNotificationConnection {
  groups: GroupedNotification[]
  totalCount: number
  unreadCount: number
  hasMore: boolean
}

/** User profile (current user). */
export interface UserProfile {
  id: string
  email: string
  displayName: string | null
  avatarUrl: string | null
}

/** Aurora credential status. */
export interface AuroraCredentialStatus {
  boardType: string
  username: string
  userId: number | null
  syncedAt: string | null
  hasToken: boolean
}

/** Board entity resolved from slug. */
export interface UserBoard {
  uuid: string
  slug: string
  ownerId: string
  boardType: string
  layoutId: number
  sizeId: number
  setIds: string
  name: string
  description: string | null
  locationName: string | null
  isPublic: boolean
  isOwned: boolean
  angle: number
  isAngleAdjustable: boolean
  layoutName: string | null
  sizeName: string | null
  sizeDescription: string | null
  setNames: string[] | null
}
