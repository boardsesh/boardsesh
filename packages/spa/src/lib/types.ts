/**
 * Core types for the SPA.
 * Simplified versions of the full web package types for the initial port.
 */

/** A climb returned from search or detail queries. */
export interface Climb {
  uuid: string
  name: string
  setter_username: string
  description: string
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
