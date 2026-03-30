/**
 * Types for the new Kilter API at portal.kiltergrips.com
 * Uses OAuth2/Keycloak authentication instead of the old Aurora /sessions endpoint.
 */

/** Kilter OAuth2 token response from Keycloak IDP */
export interface KilterTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_expires_in: number;
  refresh_token?: string;
  token_type: string;
  scope?: string;
}

/** Result of a successful Kilter login */
export interface KilterLoginResult {
  /** JWT access token for API calls */
  accessToken: string;
  /** User UUID extracted from the JWT `sub` claim */
  userUuid: string;
  /** Username passed at login (Keycloak doesn't return it in the token response) */
  username: string;
}

/** A log entry (ascent or attempt) from the Kilter API */
export interface KilterLogEntry {
  uuid?: string;
  climbUuid: string;
  angle?: number;
  topped: boolean;
  flashed: boolean;
  bidCount: number;
  createdAt?: string;
  date?: string;
}

/** A climb from the Kilter API */
export interface KilterClimb {
  climbUuid: string;
  name: string;
  productLayoutUuid: string;
  [key: string]: unknown;
}

/** Grade entry from /grades */
export interface KilterGradeEntry {
  difficultyGradeId: number;
  fontScale: string;
}

/** A circuit/playlist from the Kilter API */
export interface KilterCircuit {
  circuitUuid: string;
  name: string;
  description: string;
  color: string;
  isPrivate: boolean;
  userUuid: string;
  creatorName: string;
  productLayoutUuid: string;
  createdAt: string;
  updatedAt: string;
}

/** Sync stream request tables and timestamps — same format as old Aurora /sync */
export interface KilterSyncOptions {
  tables?: string[];
  sharedSyncs?: Array<{ table_name: string; last_synchronized_at: string }>;
  userSyncs?: Array<{ table_name: string; last_synchronized_at: string; user_id: number }>;
}

/**
 * Sync stream response — the new Kilter sync endpoint returns the same
 * table-keyed JSON structure as the old Aurora /sync, just at a different URL
 * and with Bearer auth instead of Cookie auth.
 */
export interface KilterSyncData {
  [tableName: string]: unknown;
  _complete?: boolean;
  user_syncs?: Array<{
    table_name: string;
    last_synchronized_at: string;
    user_id: number;
  }>;
}

/** User tables available through the sync stream */
export const KILTER_USER_TABLES = [
  'users',
  'walls',
  'wall_expungements',
  'draft_climbs',
  'ascents',
  'bids',
  'tags',
  'circuits',
];

/** Shared (global) tables available through the sync stream */
export const KILTER_SHARED_SYNC_TABLES = [
  'products',
  'product_sizes',
  'holes',
  'leds',
  'products_angles',
  'layouts',
  'product_sizes_layouts_sets',
  'placements',
  'sets',
  'placement_roles',
  'climbs',
  'climb_stats',
  'beta_links',
  'attempts',
  'kits',
];
