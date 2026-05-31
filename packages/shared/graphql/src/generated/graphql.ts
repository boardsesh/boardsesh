/* eslint-disable */
import { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  /** Arbitrary JSON data */
  JSON: { input: unknown; output: unknown };
};

/** Input for activity feed queries. */
export type ActivityFeedInput = {
  /** Filter by board UUID */
  boardUuid?: InputMaybe<Scalars['String']['input']>;
  /** Cursor from previous page */
  cursor?: InputMaybe<Scalars['String']['input']>;
  /** Maximum number of items to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Filter sessions where this user is a participant */
  userId?: InputMaybe<Scalars['String']['input']>;
};

/** A materialized activity feed item. */
export type ActivityFeedItem = {
  __typename?: 'ActivityFeedItem';
  /** Actor avatar URL */
  actorAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Actor display name */
  actorDisplayName?: Maybe<Scalars['String']['output']>;
  /** Actor user ID */
  actorId?: Maybe<Scalars['String']['output']>;
  /** Board angle */
  angle?: Maybe<Scalars['Int']['output']>;
  /** Number of attempts */
  attemptCount?: Maybe<Scalars['Int']['output']>;
  /** Board type (kilter, tension, moonboard) */
  boardType?: Maybe<Scalars['String']['output']>;
  /** Board UUID (for board-scoped filtering) */
  boardUuid?: Maybe<Scalars['String']['output']>;
  /** Name of the climb */
  climbName?: Maybe<Scalars['String']['output']>;
  /** UUID of the climb */
  climbUuid?: Maybe<Scalars['String']['output']>;
  /** User comment on the ascent */
  comment?: Maybe<Scalars['String']['output']>;
  /** Comment body preview */
  commentBody?: Maybe<Scalars['String']['output']>;
  /** When this feed item was created (ISO 8601) */
  createdAt: Scalars['String']['output'];
  /** Difficulty rating */
  difficulty?: Maybe<Scalars['Int']['output']>;
  /** Human-readable difficulty name */
  difficultyName?: Maybe<Scalars['String']['output']>;
  /** Entity ID */
  entityId: Scalars['String']['output'];
  /** Entity type this item relates to */
  entityType: SocialEntityType;
  /** Encoded hold frames for thumbnail */
  frames?: Maybe<Scalars['String']['output']>;
  /** Grade name */
  gradeName?: Maybe<Scalars['String']['output']>;
  /** Feed item ID */
  id: Scalars['ID']['output'];
  /** Whether this is a benchmark climb */
  isBenchmark?: Maybe<Scalars['Boolean']['output']>;
  /** Whether climb was mirrored */
  isMirror?: Maybe<Scalars['Boolean']['output']>;
  /** Whether matching is disallowed on this climb */
  isNoMatch?: Maybe<Scalars['Boolean']['output']>;
  /** Layout ID */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** JSON-encoded metadata for type-specific data (e.g., session summary stats) */
  metadata?: Maybe<Scalars['String']['output']>;
  /** Quality rating */
  quality?: Maybe<Scalars['Int']['output']>;
  /** Setter username */
  setterUsername?: Maybe<Scalars['String']['output']>;
  /** Ascent status (flash, send, attempt) */
  status?: Maybe<Scalars['String']['output']>;
  /** Type of activity */
  type: ActivityFeedItemType;
};

export type ActivityFeedItemType = 'ascent' | 'comment' | 'new_climb' | 'proposal_approved' | 'session_summary';

/** Cursor-based paginated activity feed result. */
export type ActivityFeedResult = {
  __typename?: 'ActivityFeedResult';
  /** Cursor for next page */
  cursor?: Maybe<Scalars['String']['output']>;
  /** Whether more items are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of feed items */
  items: Array<ActivityFeedItem>;
};

/** Input for adding a climb to a playlist. */
export type AddClimbToPlaylistInput = {
  /** Board angle for this entry */
  angle: Scalars['Int']['input'];
  /** Climb UUID to add */
  climbUuid: Scalars['String']['input'];
  /** Target playlist ID */
  playlistId: Scalars['ID']['input'];
};

/** Input for adding a comment. */
export type AddCommentInput = {
  /** Comment body text */
  body: Scalars['String']['input'];
  /** Entity ID to comment on */
  entityId: Scalars['String']['input'];
  /** Entity type to comment on */
  entityType: SocialEntityType;
  /** Parent comment UUID for replies */
  parentCommentUuid?: InputMaybe<Scalars['String']['input']>;
};

/** Input for adding a climb to favorites (idempotent, sync-safe). */
export type AddFavoriteInput = {
  /** Board angle */
  angle: Scalars['Int']['input'];
  /** Board type */
  boardName: Scalars['String']['input'];
  /** Climb UUID to favorite */
  climbUuid: Scalars['String']['input'];
};

/** Input for adding a member to a gym. */
export type AddGymMemberInput = {
  /** Gym UUID */
  gymUuid: Scalars['ID']['input'];
  /** Role for the new member */
  role: GymMemberRole;
  /** User ID to add */
  userId: Scalars['ID']['input'];
};

/** Input for adding a user to an inferred session. */
export type AddUserToSessionInput = {
  /** ID of the inferred session */
  sessionId: Scalars['ID']['input'];
  /** User ID to add */
  userId: Scalars['ID']['input'];
};

/** Result of fetching the authenticated user's playlists, paginated. */
export type AllUserPlaylistsResult = {
  __typename?: 'AllUserPlaylistsResult';
  /** Whether more are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of playlists */
  playlists: Array<Playlist>;
  /** Total count across all pages */
  totalCount: Scalars['Int']['output'];
};

/** A supported board angle. */
export type Angle = {
  __typename?: 'Angle';
  /** Angle in degrees */
  angle: Scalars['Int']['output'];
};

/** Pagination input for ascent feeds. */
export type AscentFeedInput = {
  /** When true, only include benchmark climbs */
  benchmarkOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Optional board type filter (kilter, tension, moonboard) */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Optional board type filter for multiple board types */
  boardTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Optional climb name search (case-insensitive partial match) */
  climbName?: InputMaybe<Scalars['String']['input']>;
  /** When true, only include flashes within the selected status mode */
  flashOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Optional start date filter (ISO date string, inclusive) */
  fromDate?: InputMaybe<Scalars['String']['input']>;
  /** Optional layout filters within the selected board type */
  layoutIds?: InputMaybe<Array<Scalars['Int']['input']>>;
  /** Maximum number of items to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Optional maximum wall angle filter */
  maxAngle?: InputMaybe<Scalars['Int']['input']>;
  /** Optional maximum difficulty filter (difficulty_id) */
  maxDifficulty?: InputMaybe<Scalars['Int']['input']>;
  /** Optional minimum wall angle filter */
  minAngle?: InputMaybe<Scalars['Int']['input']>;
  /** Optional minimum difficulty filter (difficulty_id) */
  minDifficulty?: InputMaybe<Scalars['Int']['input']>;
  /** Number of items to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Optional secondary sort field */
  secondarySortBy?: InputMaybe<Scalars['String']['input']>;
  /** Optional secondary sort order */
  secondarySortOrder?: InputMaybe<Scalars['String']['input']>;
  /** Primary sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Primary sort order: desc (default) or asc */
  sortOrder?: InputMaybe<Scalars['String']['input']>;
  /** Legacy status filter (flash, send, attempt) */
  status?: InputMaybe<Scalars['String']['input']>;
  /** Status mode filter: both, send, attempt */
  statusMode?: InputMaybe<Scalars['String']['input']>;
  /** Optional end date filter (ISO date string, inclusive) */
  toDate?: InputMaybe<Scalars['String']['input']>;
};

/** A climb ascent with enriched data for activity feeds. */
export type AscentFeedItem = {
  __typename?: 'AscentFeedItem';
  /** Board angle */
  angle: Scalars['Int']['output'];
  /** Number of attempts */
  attemptCount: Scalars['Int']['output'];
  /** Board type */
  boardType: Scalars['String']['output'];
  /** Name of the climb */
  climbName: Scalars['String']['output'];
  /** UUID of the climb */
  climbUuid: Scalars['String']['output'];
  /** When climbed (ISO 8601) */
  climbedAt: Scalars['String']['output'];
  /** Comment */
  comment: Scalars['String']['output'];
  /** Consensus difficulty rounded to the nearest grade ID */
  consensusDifficulty?: Maybe<Scalars['Int']['output']>;
  /** Human-readable consensus difficulty name */
  consensusDifficultyName?: Maybe<Scalars['String']['output']>;
  /** Difficulty rating */
  difficulty?: Maybe<Scalars['Int']['output']>;
  /** Human-readable difficulty name */
  difficultyName?: Maybe<Scalars['String']['output']>;
  /** Encoded hold frames for thumbnail display */
  frames?: Maybe<Scalars['String']['output']>;
  /** Whether this is a benchmark climb */
  isBenchmark: Scalars['Boolean']['output'];
  /** Whether climb was mirrored */
  isMirror: Scalars['Boolean']['output'];
  /** Whether matching is disallowed on this climb */
  isNoMatch: Scalars['Boolean']['output'];
  /** Layout ID */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** Quality rating */
  quality?: Maybe<Scalars['Int']['output']>;
  /** Average quality rating from all users */
  qualityAverage?: Maybe<Scalars['Float']['output']>;
  /** Username of the setter */
  setterUsername?: Maybe<Scalars['String']['output']>;
  /** Result of the attempt */
  status: TickStatus;
  /** Tick UUID */
  uuid: Scalars['ID']['output'];
};

/** Paginated ascent feed result. */
export type AscentFeedResult = {
  __typename?: 'AscentFeedResult';
  /** Whether more items are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of ascent feed items */
  items: Array<AscentFeedItem>;
  /** Total count for pagination */
  totalCount: Scalars['Int']['output'];
};

/** Input for attaching an Instagram video as beta for a climb. */
export type AttachBetaLinkInput = {
  /** Optional angle the video was climbed at */
  angle?: InputMaybe<Scalars['Int']['input']>;
  /** Board type */
  boardType: Scalars['String']['input'];
  /** Climb UUID */
  climbUuid: Scalars['String']['input'];
  /** Instagram post or reel URL */
  link: Scalars['String']['input'];
};

/** Stored credentials for an Aurora Climbing board account. */
export type AuroraCredential = {
  __typename?: 'AuroraCredential';
  /** Board type ('kilter' or 'tension') */
  boardType: Scalars['String']['output'];
  /** When credentials were last synced (ISO 8601) */
  syncedAt?: Maybe<Scalars['String']['output']>;
  /** Aurora API token (only returned when needed) */
  token?: Maybe<Scalars['String']['output']>;
  /** Aurora user ID (after successful sync) */
  userId?: Maybe<Scalars['Int']['output']>;
  /** Aurora account username */
  username: Scalars['String']['output'];
};

/** Status of Aurora credentials without sensitive data. */
export type AuroraCredentialStatus = {
  __typename?: 'AuroraCredentialStatus';
  /** Board type ('kilter' or 'tension') */
  boardType: Scalars['String']['output'];
  /** Whether a valid token is stored */
  hasToken: Scalars['Boolean']['output'];
  /** When credentials were last synced (ISO 8601) */
  syncedAt?: Maybe<Scalars['String']['output']>;
  /** Aurora user ID (after successful sync) */
  userId?: Maybe<Scalars['Int']['output']>;
  /** Aurora account username */
  username: Scalars['String']['output'];
};

/**
 * An external Instagram or TikTok beta link attached to a climb.
 * Thumbnail (when present) is served from our own S3 bucket.
 */
export type BetaLink = {
  __typename?: 'BetaLink';
  angle?: Maybe<Scalars['Int']['output']>;
  climbUuid: Scalars['String']['output'];
  createdAt?: Maybe<Scalars['String']['output']>;
  foreignUsername?: Maybe<Scalars['String']['output']>;
  isListed?: Maybe<Scalars['Boolean']['output']>;
  link: Scalars['String']['output'];
  thumbnail?: Maybe<Scalars['String']['output']>;
};

/** Board leaderboard result. */
export type BoardLeaderboard = {
  __typename?: 'BoardLeaderboard';
  /** Board UUID */
  boardUuid: Scalars['ID']['output'];
  /** Leaderboard entries */
  entries: Array<BoardLeaderboardEntry>;
  /** Whether more entries are available */
  hasMore: Scalars['Boolean']['output'];
  /** Label for the time period */
  periodLabel: Scalars['String']['output'];
  /** Total number of entries */
  totalCount: Scalars['Int']['output'];
};

/** A leaderboard entry for a board. */
export type BoardLeaderboardEntry = {
  __typename?: 'BoardLeaderboardEntry';
  /** Hardest grade sent (difficulty ID) */
  hardestGrade?: Maybe<Scalars['Int']['output']>;
  /** Human-readable hardest grade name */
  hardestGradeName?: Maybe<Scalars['String']['output']>;
  /** Rank on the leaderboard */
  rank: Scalars['Int']['output'];
  /** Total flashes */
  totalFlashes: Scalars['Int']['output'];
  /** Total sends (flash + send) */
  totalSends: Scalars['Int']['output'];
  /** Total sessions */
  totalSessions: Scalars['Int']['output'];
  /** Avatar URL */
  userAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name */
  userDisplayName?: Maybe<Scalars['String']['output']>;
  /** User ID */
  userId: Scalars['ID']['output'];
};

/** Input for board leaderboard query. */
export type BoardLeaderboardInput = {
  /** Board UUID */
  boardUuid: Scalars['ID']['input'];
  /** Max entries to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Offset for pagination */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Time period (week, month, year, all) */
  period?: InputMaybe<Scalars['String']['input']>;
};

/**
 * Auto-recorded board configuration that the current user was on the last time
 * they connected to a controller with the given serial. Acts as a fallback for
 * serial→board lookups when no deliberately-saved `UserBoard` matches.
 */
export type BoardSerialConfig = {
  __typename?: 'BoardSerialConfig';
  /** Board type (kilter, tension, ...) */
  boardName: Scalars['String']['output'];
  /** Linked saved board slug (resolved from boardUuid) */
  boardSlug?: Maybe<Scalars['String']['output']>;
  /** Linked saved board UUID (when the connect happened from a /b/{slug}/... route) */
  boardUuid?: Maybe<Scalars['ID']['output']>;
  /** Layout ID at last connect */
  layoutId: Scalars['Int']['output'];
  /** Controller box serial number */
  serialNumber: Scalars['String']['output'];
  /** Comma-separated set IDs at last connect */
  setIds: Scalars['String']['output'];
  /** Size ID at last connect */
  sizeId: Scalars['Int']['output'];
  /** When the recording was last updated */
  updatedAt: Scalars['String']['output'];
};

export type BrowseProposalsInput = {
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Filter by board UUID (resolves to boardType internally) */
  boardUuid?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<ProposalStatus>;
  type?: InputMaybe<ProposalType>;
};

/** Input for fetching vote summaries in bulk. */
export type BulkVoteSummaryInput = {
  /** List of entity IDs */
  entityIds: Array<Scalars['String']['input']>;
  /** Entity type */
  entityType: SocialEntityType;
};

export type CheckMoonBoardClimbDuplicatesInput = {
  angle: Scalars['Int']['input'];
  climbs: Array<MoonBoardClimbDuplicateCandidateInput>;
  layoutId: Scalars['Int']['input'];
};

/**
 * A climbing problem/route on an interactive training board.
 * Contains all information needed to display and light up the climb on the board.
 */
export type Climb = {
  __typename?: 'Climb';
  /** Board angle in degrees when this climb was set */
  angle: Scalars['Int']['output'];
  /** Number of people who have completed this climb */
  ascensionist_count: Scalars['Int']['output'];
  /** Official benchmark difficulty if this is a benchmark climb */
  benchmark_difficulty?: Maybe<Scalars['String']['output']>;
  /** Board type this climb belongs to (e.g. 'kilter', 'tension'). Populated in multi-board contexts. */
  boardType?: Maybe<Scalars['String']['output']>;
  /** ISO timestamp of when this climb row was created */
  created_at?: Maybe<Scalars['String']['output']>;
  /** Description or notes about the climb (nullable - omitted from search results, fetch separately via climb detail query) */
  description?: Maybe<Scalars['String']['output']>;
  /** Difficulty grade of the climb (e.g., 'V5', '6B+') */
  difficulty: Scalars['String']['output'];
  /** Difficulty uncertainty/spread */
  difficulty_error: Scalars['String']['output'];
  /** Encoded hold positions and colors for lighting up the board */
  frames: Scalars['String']['output'];
  /** Whether this climb is a draft (unpublished) */
  is_draft?: Maybe<Scalars['Boolean']['output']>;
  /** Whether this climb disallows matching (both hands on the same hold) */
  is_no_match?: Maybe<Scalars['Boolean']['output']>;
  /** Layout ID the climb belongs to (used to identify cross-layout climbs) */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** Whether the climb should be displayed mirrored */
  mirrored?: Maybe<Scalars['Boolean']['output']>;
  /** Name/title of the climb */
  name: Scalars['String']['output'];
  /** ISO timestamp of when this climb was first published (null while still a draft) */
  published_at?: Maybe<Scalars['String']['output']>;
  /** Average quality rating from users */
  quality_average: Scalars['String']['output'];
  /** Username of the person who created this climb */
  setter_username: Scalars['String']['output'];
  /** Star rating (0-3) */
  stars: Scalars['Float']['output'];
  /** Number of times the current user has sent this climb */
  userAscents?: Maybe<Scalars['Int']['output']>;
  /** Number of times the current user has attempted this climb */
  userAttempts?: Maybe<Scalars['Int']['output']>;
  /** Boardsesh user ID of the climb owner (null for Aurora-synced climbs). Used as the stable identity for ownership gates like the post-publish edit window. */
  userId?: Maybe<Scalars['ID']['output']>;
  /** Unique identifier for the climb */
  uuid: Scalars['ID']['output'];
};

/** Classic status for a climb (angle-independent). */
export type ClimbClassicStatus = {
  __typename?: 'ClimbClassicStatus';
  boardType: Scalars['String']['output'];
  climbUuid: Scalars['String']['output'];
  isClassic: Scalars['Boolean']['output'];
  updatedAt?: Maybe<Scalars['String']['output']>;
};

/** Community status for a climb at a specific angle. */
export type ClimbCommunityStatus = {
  __typename?: 'ClimbCommunityStatus';
  angle: Scalars['Int']['output'];
  boardType: Scalars['String']['output'];
  climbUuid: Scalars['String']['output'];
  communityGrade?: Maybe<Scalars['String']['output']>;
  freezeReason?: Maybe<Scalars['String']['output']>;
  isBenchmark: Scalars['Boolean']['output'];
  isClassic: Scalars['Boolean']['output'];
  isFrozen: Scalars['Boolean']['output'];
  openProposalCount: Scalars['Int']['output'];
  outlierAnalysis?: Maybe<OutlierAnalysis>;
  updatedAt?: Maybe<Scalars['String']['output']>;
};

/** Input type for creating or updating a climb. */
export type ClimbInput = {
  angle: Scalars['Int']['input'];
  ascensionist_count: Scalars['Int']['input'];
  benchmark_difficulty?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  difficulty: Scalars['String']['input'];
  difficulty_error: Scalars['String']['input'];
  frames: Scalars['String']['input'];
  /** Whether this climb is still a draft. */
  is_draft?: InputMaybe<Scalars['Boolean']['input']>;
  is_no_match?: InputMaybe<Scalars['Boolean']['input']>;
  mirrored?: InputMaybe<Scalars['Boolean']['input']>;
  name: Scalars['String']['input'];
  /** ISO timestamp of when this climb was first published. */
  published_at?: InputMaybe<Scalars['String']['input']>;
  quality_average: Scalars['String']['input'];
  setter_username: Scalars['String']['input'];
  stars: Scalars['Float']['input'];
  userAscents?: InputMaybe<Scalars['Int']['input']>;
  userAttempts?: InputMaybe<Scalars['Int']['input']>;
  /** Boardsesh user ID of the climb owner (null for Aurora-synced climbs). */
  userId?: InputMaybe<Scalars['ID']['input']>;
  uuid: Scalars['ID']['input'];
};

export type ClimbMatchResult = {
  __typename?: 'ClimbMatchResult';
  climbName?: Maybe<Scalars['String']['output']>;
  climbUuid?: Maybe<Scalars['String']['output']>;
  matched: Scalars['Boolean']['output'];
};

/** Event when the current climb's mirror state changes. */
export type ClimbMirrored = {
  __typename?: 'ClimbMirrored';
  /** New mirror state */
  mirrored: Scalars['Boolean']['output'];
  /** Sequence number of this event */
  sequence: Scalars['Int']['output'];
  /** Queue state hash after this event is applied */
  stateHash: Scalars['String']['output'];
  /** UUID of the mirrored queue item, when a current climb exists */
  uuid?: Maybe<Scalars['ID']['output']>;
};

/** Playlist membership for a single climb in a batch query. */
export type ClimbPlaylistMembership = {
  __typename?: 'ClimbPlaylistMembership';
  /** Climb UUID */
  climbUuid: Scalars['String']['output'];
  /** UUIDs of playlists containing this climb */
  playlistUuids: Array<Scalars['ID']['output']>;
};

/** An item in the climb queue, representing a climb that someone wants to attempt. */
export type ClimbQueueItem = {
  __typename?: 'ClimbQueueItem';
  /** Username of who added this to the queue (legacy) */
  addedBy?: Maybe<Scalars['String']['output']>;
  /** User who added this climb to the queue */
  addedByUser?: Maybe<QueueItemUser>;
  /** The climb data */
  climb: Climb;
  /** Whether this climb was suggested by the system */
  suggested?: Maybe<Scalars['Boolean']['output']>;
  /** List of user IDs who have completed (ticked) this climb in the session */
  tickedBy?: Maybe<Array<Scalars['String']['output']>>;
  /** Unique identifier for this queue item */
  uuid: Scalars['ID']['output'];
};

/** Input type for adding items to the queue. */
export type ClimbQueueItemInput = {
  addedBy?: InputMaybe<Scalars['String']['input']>;
  addedByUser?: InputMaybe<QueueItemUserInput>;
  climb: ClimbInput;
  suggested?: InputMaybe<Scalars['Boolean']['input']>;
  tickedBy?: InputMaybe<Array<Scalars['String']['input']>>;
  uuid: Scalars['ID']['input'];
};

/**
 * Input parameters for searching climbs.
 * Supports filtering, sorting, and pagination.
 */
export type ClimbSearchInput = {
  /** Board angle in degrees */
  angle: Scalars['Int']['input'];
  /** Board type (e.g., 'kilter', 'tension') */
  boardName: Scalars['String']['input'];
  /** Grade accuracy filter ('tight', 'moderate', 'loose') */
  gradeAccuracy?: InputMaybe<Scalars['String']['input']>;
  /** Hide climbs the user has attempted (requires auth) */
  hideAttempted?: InputMaybe<Scalars['Boolean']['input']>;
  /** Hide climbs the user has completed (requires auth) */
  hideCompleted?: InputMaybe<Scalars['Boolean']['input']>;
  /** Hold filter object: { holdId: 'ANY' | 'NOT', ... } */
  holdsFilter?: InputMaybe<Scalars['JSON']['input']>;
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
  /** Maximum difficulty grade ID */
  maxGrade?: InputMaybe<Scalars['Int']['input']>;
  /** Minimum number of ascents */
  minAscents?: InputMaybe<Scalars['Int']['input']>;
  /** Minimum difficulty grade ID */
  minGrade?: InputMaybe<Scalars['Int']['input']>;
  /** Minimum quality rating */
  minRating?: InputMaybe<Scalars['Float']['input']>;
  /** Filter by climb name (partial match) */
  name?: InputMaybe<Scalars['String']['input']>;
  /** Only show benchmark climbs */
  onlyBenchmarks?: InputMaybe<Scalars['Boolean']['input']>;
  /** Show only the user's draft climbs (requires auth) */
  onlyDrafts?: InputMaybe<Scalars['Boolean']['input']>;
  /** Only show tall/steep climbs */
  onlyTallClimbs?: InputMaybe<Scalars['Boolean']['input']>;
  /** Only show Kilter Homewall climbs that use the 10x10 side expansion */
  onlyWideClimbs?: InputMaybe<Scalars['Boolean']['input']>;
  /** Page number for pagination (1-indexed) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Number of results per page */
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  /** Show only unclimbed projects (climbs with 0 ascents) */
  projectsOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Comma-separated set IDs */
  setIds: Scalars['String']['input'];
  /** Filter by setter usernames */
  setter?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Filter by setter ID */
  setterId?: InputMaybe<Scalars['Int']['input']>;
  /** Only show climbs the user has attempted (requires auth) */
  showOnlyAttempted?: InputMaybe<Scalars['Boolean']['input']>;
  /** Only show climbs the user has completed (requires auth) */
  showOnlyCompleted?: InputMaybe<Scalars['Boolean']['input']>;
  /** Size ID */
  sizeId: Scalars['Int']['input'];
  /** Field to sort by ('ascents', 'difficulty', 'name', 'quality', 'popular') */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction ('asc' or 'desc') */
  sortOrder?: InputMaybe<Scalars['String']['input']>;
  /** Restrict results using this drawn zone */
  zoneBox?: InputMaybe<ZoneBoxInput>;
  /** How the zone should match climb holds. Defaults to allHolds when omitted. */
  zoneMode?: InputMaybe<ZoneMatchMode>;
};

/** Result of a climb search query. */
export type ClimbSearchResult = {
  __typename?: 'ClimbSearchResult';
  /** List of climbs matching the search criteria */
  climbs: Array<Climb>;
  /** Whether there are more results available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of climbs matching (for pagination) */
  totalCount: Scalars['Int']['output'];
};

/**
 * A single snapshot of climb statistics from the history table.
 * Captured during shared sync to track trends over time.
 */
export type ClimbStatsHistoryEntry = {
  __typename?: 'ClimbStatsHistoryEntry';
  /** Board angle in degrees */
  angle: Scalars['Int']['output'];
  /** Number of people who have completed this climb at this angle */
  ascensionistCount?: Maybe<Scalars['Int']['output']>;
  /** When this snapshot was recorded */
  createdAt: Scalars['String']['output'];
  /** Average difficulty rating */
  difficultyAverage?: Maybe<Scalars['Float']['output']>;
  /** Display difficulty value */
  displayDifficulty?: Maybe<Scalars['Float']['output']>;
  /** Average quality rating */
  qualityAverage?: Maybe<Scalars['Float']['output']>;
};

/** A comment on a social entity (climb, tick, playlist_climb, etc). */
export type Comment = {
  __typename?: 'Comment';
  /** Comment body text (null if deleted) */
  body?: Maybe<Scalars['String']['output']>;
  /** When the comment was created (ISO 8601) */
  createdAt: Scalars['String']['output'];
  /** Number of downvotes */
  downvotes: Scalars['Int']['output'];
  /** Entity ID this comment belongs to */
  entityId: Scalars['String']['output'];
  /** Entity type this comment belongs to */
  entityType: SocialEntityType;
  /** Whether this comment has been deleted */
  isDeleted: Scalars['Boolean']['output'];
  /** Parent comment UUID for replies (null for top-level) */
  parentCommentUuid?: Maybe<Scalars['String']['output']>;
  /** Number of replies to this comment */
  replyCount: Scalars['Int']['output'];
  /** When the comment was last updated (ISO 8601) */
  updatedAt: Scalars['String']['output'];
  /** Number of upvotes */
  upvotes: Scalars['Int']['output'];
  /** Avatar URL of the comment author */
  userAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name of the comment author */
  userDisplayName?: Maybe<Scalars['String']['output']>;
  /** User who posted the comment */
  userId: Scalars['ID']['output'];
  /** Current user's vote (-1, 0, or 1) */
  userVote: Scalars['Int']['output'];
  /** Public unique identifier */
  uuid: Scalars['ID']['output'];
  /** Net vote score (upvotes - downvotes) */
  voteScore: Scalars['Int']['output'];
};

/** Event when a new comment is added. */
export type CommentAdded = {
  __typename?: 'CommentAdded';
  /** The comment that was added */
  comment: Comment;
};

/** Paginated list of comments. */
export type CommentConnection = {
  __typename?: 'CommentConnection';
  /** List of comments */
  comments: Array<Comment>;
  /** Cursor for next page (used by globalCommentFeed) */
  cursor?: Maybe<Scalars['String']['output']>;
  /** Whether more comments are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of matching comments */
  totalCount: Scalars['Int']['output'];
};

/** Event when a comment is deleted. */
export type CommentDeleted = {
  __typename?: 'CommentDeleted';
  /** UUID of the deleted comment */
  commentUuid: Scalars['ID']['output'];
  /** Entity ID the comment belonged to */
  entityId: Scalars['String']['output'];
  /** Entity type the comment belonged to */
  entityType: SocialEntityType;
};

/** Union of possible comment update events. */
export type CommentEvent = CommentAdded | CommentDeleted | CommentUpdated;

/** Event when a comment is updated. */
export type CommentUpdated = {
  __typename?: 'CommentUpdated';
  /** The comment that was updated */
  comment: Comment;
};

/** Input for fetching comments. */
export type CommentsInput = {
  /** Entity ID */
  entityId: Scalars['String']['input'];
  /** Entity type */
  entityType: SocialEntityType;
  /** Maximum number of comments to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of comments to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Parent comment UUID to fetch replies for */
  parentCommentUuid?: InputMaybe<Scalars['String']['input']>;
  /** Sort mode */
  sortBy?: InputMaybe<SortMode>;
  /** Time period filter */
  timePeriod?: InputMaybe<TimePeriod>;
};

/** A community role assignment for a user. */
export type CommunityRoleAssignment = {
  __typename?: 'CommunityRoleAssignment';
  boardType?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['String']['output'];
  grantedBy?: Maybe<Scalars['String']['output']>;
  grantedByDisplayName?: Maybe<Scalars['String']['output']>;
  id: Scalars['Int']['output'];
  role: CommunityRoleType;
  userAvatarUrl?: Maybe<Scalars['String']['output']>;
  userDisplayName?: Maybe<Scalars['String']['output']>;
  userId: Scalars['ID']['output'];
};

export type CommunityRoleType = 'admin' | 'community_leader';

/** A community setting key-value pair. */
export type CommunitySetting = {
  __typename?: 'CommunitySetting';
  createdAt: Scalars['String']['output'];
  id: Scalars['Int']['output'];
  key: Scalars['String']['output'];
  scope: Scalars['String']['output'];
  scopeKey: Scalars['String']['output'];
  setBy?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['String']['output'];
  value: Scalars['String']['output'];
};

export type ControllerEvent = ControllerPing | ControllerQueueSync | LedUpdate;

export type ControllerInfo = {
  __typename?: 'ControllerInfo';
  boardName: Scalars['String']['output'];
  createdAt: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isOnline: Scalars['Boolean']['output'];
  lastSeen?: Maybe<Scalars['String']['output']>;
  layoutId: Scalars['Int']['output'];
  name?: Maybe<Scalars['String']['output']>;
  setIds: Scalars['String']['output'];
  sizeId: Scalars['Int']['output'];
};

export type ControllerPing = {
  __typename?: 'ControllerPing';
  timestamp: Scalars['String']['output'];
};

export type ControllerQueueItem = {
  __typename?: 'ControllerQueueItem';
  /** Climb UUID (for display matching) */
  climbUuid: Scalars['ID']['output'];
  /** Grade string */
  grade: Scalars['String']['output'];
  /** Grade color as hex string */
  gradeColor: Scalars['String']['output'];
  /** Climb name (truncated for display) */
  name: Scalars['String']['output'];
  /** Queue item UUID (unique per queue position, used for navigation) */
  uuid: Scalars['ID']['output'];
};

export type ControllerQueueSync = {
  __typename?: 'ControllerQueueSync';
  /** Index of current climb in queue (-1 if none) */
  currentIndex: Scalars['Int']['output'];
  /** Complete queue state for controller */
  queue: Array<ControllerQueueItem>;
};

export type ControllerRegistration = {
  __typename?: 'ControllerRegistration';
  apiKey: Scalars['String']['output'];
  controllerId: Scalars['ID']['output'];
};

/** Input for creating a board. */
export type CreateBoardInput = {
  /** Default angle for this board (default 40) */
  angle?: InputMaybe<Scalars['Int']['input']>;
  /** Board type */
  boardType: Scalars['String']['input'];
  /** Optional description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Optional gym UUID to link board to */
  gymUuid?: InputMaybe<Scalars['String']['input']>;
  /** Hide from proximity search unless owner follows searcher (default false) */
  hideLocation?: InputMaybe<Scalars['Boolean']['input']>;
  /** Whether the board's angle is physically adjustable (default true) */
  isAngleAdjustable?: InputMaybe<Scalars['Boolean']['input']>;
  /** Whether user owns the physical board (default true) */
  isOwned?: InputMaybe<Scalars['Boolean']['input']>;
  /** Whether publicly visible (default true) */
  isPublic?: InputMaybe<Scalars['Boolean']['input']>;
  /** Hide from search results (default false) */
  isUnlisted?: InputMaybe<Scalars['Boolean']['input']>;
  /** GPS latitude */
  latitude?: InputMaybe<Scalars['Float']['input']>;
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
  /** Location name */
  locationName?: InputMaybe<Scalars['String']['input']>;
  /** GPS longitude */
  longitude?: InputMaybe<Scalars['Float']['input']>;
  /** Board name */
  name: Scalars['String']['input'];
  /** Controller box serial number */
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  /** Comma-separated set IDs */
  setIds: Scalars['String']['input'];
  /** Size ID */
  sizeId: Scalars['Int']['input'];
};

/** Input for creating a gym. */
export type CreateGymInput = {
  /** Physical address */
  address?: InputMaybe<Scalars['String']['input']>;
  /** Optional board UUID to link on creation */
  boardUuid?: InputMaybe<Scalars['String']['input']>;
  /** Contact email */
  contactEmail?: InputMaybe<Scalars['String']['input']>;
  /** Contact phone */
  contactPhone?: InputMaybe<Scalars['String']['input']>;
  /** Optional description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Image URL */
  imageUrl?: InputMaybe<Scalars['String']['input']>;
  /** Whether publicly visible (default true) */
  isPublic?: InputMaybe<Scalars['Boolean']['input']>;
  /** GPS latitude */
  latitude?: InputMaybe<Scalars['Float']['input']>;
  /** GPS longitude */
  longitude?: InputMaybe<Scalars['Float']['input']>;
  /** Gym name */
  name: Scalars['String']['input'];
};

/** Input for creating a playlist. */
export type CreatePlaylistInput = {
  /** Board type */
  boardType: Scalars['String']['input'];
  /** Display color */
  color?: InputMaybe<Scalars['String']['input']>;
  /** Optional description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Display icon */
  icon?: InputMaybe<Scalars['String']['input']>;
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
  /** Playlist name */
  name: Scalars['String']['input'];
  /** Optional client-supplied UUID for idempotent offline replay (ON CONFLICT (uuid) DO NOTHING). When omitted, the server generates one. */
  uuid?: InputMaybe<Scalars['ID']['input']>;
};

export type CreateProposalInput = {
  angle?: InputMaybe<Scalars['Int']['input']>;
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
  proposedValue: Scalars['String']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  type: ProposalType;
};

/** Input for creating a new climbing session. */
export type CreateSessionInput = {
  /** Board entity IDs for multi-board sessions */
  boardIds?: InputMaybe<Array<Scalars['Int']['input']>>;
  /** Board configuration path (e.g., 'kilter/1/1/1,2/40') */
  boardPath: Scalars['String']['input'];
  /** Hex color for multi-session display */
  color?: InputMaybe<Scalars['String']['input']>;
  /** Whether this session should appear in nearby searches */
  discoverable: Scalars['Boolean']['input'];
  /** Optional session goal text */
  goal?: InputMaybe<Scalars['String']['input']>;
  /** Whether session is exempt from auto-end */
  isPermanent?: InputMaybe<Scalars['Boolean']['input']>;
  /** GPS latitude for session discovery */
  latitude: Scalars['Float']['input'];
  /** GPS longitude for session discovery */
  longitude: Scalars['Float']['input'];
  /** Optional session name */
  name?: InputMaybe<Scalars['String']['input']>;
};

/** Event when the current climb changes. */
export type CurrentClimbChanged = {
  __typename?: 'CurrentClimbChanged';
  /** ID of the client that made this change */
  clientId?: Maybe<Scalars['ID']['output']>;
  /** Correlation ID for request tracking */
  correlationId?: Maybe<Scalars['ID']['output']>;
  /** New current climb (null to clear) */
  item?: Maybe<ClimbQueueItem>;
  /** Sequence number of this event */
  sequence: Scalars['Int']['output'];
  /** Queue state hash after this event is applied */
  stateHash: Scalars['String']['output'];
};

/** Information needed before account deletion. */
export type DeleteAccountInfo = {
  __typename?: 'DeleteAccountInfo';
  /** Number of published (non-draft) climbs the user has created */
  publishedClimbCount: Scalars['Int']['output'];
};

/** Input for the deleteAccount mutation. */
export type DeleteAccountInput = {
  /** Whether to remove the setter name from published climbs */
  removeSetterName: Scalars['Boolean']['input'];
};

export type DeleteProposalInput = {
  proposalUuid: Scalars['ID']['input'];
};

export type DeviceLogEntry = {
  component: Scalars['String']['input'];
  level: Scalars['String']['input'];
  message: Scalars['String']['input'];
  metadata?: InputMaybe<Scalars['String']['input']>;
  ts: Scalars['Float']['input'];
};

/** Input for discovering public playlists. */
export type DiscoverPlaylistsInput = {
  /** Board type (optional — omit to discover across all boards) */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Filter by creator IDs */
  creatorIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  /** Layout ID (optional — omit to discover across all layouts) */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** Filter by name (partial match) */
  name?: InputMaybe<Scalars['String']['input']>;
  /** Page number */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Page size */
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  /** Sort by: 'recent' (default) or 'popular' */
  sortBy?: InputMaybe<Scalars['String']['input']>;
};

/** Result of playlist discovery. */
export type DiscoverPlaylistsResult = {
  __typename?: 'DiscoverPlaylistsResult';
  /** Whether more are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of playlists */
  playlists: Array<DiscoverablePlaylist>;
  /** Total count */
  totalCount: Scalars['Int']['output'];
};

/** A public playlist with creator information. */
export type DiscoverablePlaylist = {
  __typename?: 'DiscoverablePlaylist';
  /** Board type */
  boardType: Scalars['String']['output'];
  /** Number of climbs */
  climbCount: Scalars['Int']['output'];
  /** Display color */
  color?: Maybe<Scalars['String']['output']>;
  /** When created */
  createdAt: Scalars['String']['output'];
  /** Creator's user ID */
  creatorId: Scalars['ID']['output'];
  /** Creator's display name */
  creatorName: Scalars['String']['output'];
  /** Description */
  description?: Maybe<Scalars['String']['output']>;
  /** Display icon */
  icon?: Maybe<Scalars['String']['output']>;
  /** Database ID */
  id: Scalars['ID']['output'];
  /** Layout ID */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** Playlist name */
  name: Scalars['String']['output'];
  /** When last updated */
  updatedAt: Scalars['String']['output'];
  /** Unique identifier */
  uuid: Scalars['ID']['output'];
};

/** A session that can be discovered by nearby users via GPS. */
export type DiscoverableSession = {
  __typename?: 'DiscoverableSession';
  /** Board configuration path */
  boardPath: Scalars['String']['output'];
  /** Hex color for multi-session display */
  color?: Maybe<Scalars['String']['output']>;
  /** When the session was created (ISO 8601) */
  createdAt: Scalars['String']['output'];
  /** User ID of the session creator */
  createdByUserId?: Maybe<Scalars['ID']['output']>;
  /** Distance from the querying user's location (meters) */
  distance?: Maybe<Scalars['Float']['output']>;
  /** Optional session goal */
  goal?: Maybe<Scalars['String']['output']>;
  /** Unique session identifier */
  id: Scalars['ID']['output'];
  /** Whether the session is still active */
  isActive: Scalars['Boolean']['output'];
  /** Whether session is exempt from auto-end */
  isPermanent?: Maybe<Scalars['Boolean']['output']>;
  /** Whether session is publicly discoverable */
  isPublic?: Maybe<Scalars['Boolean']['output']>;
  /** GPS latitude of the session location */
  latitude: Scalars['Float']['output'];
  /** GPS longitude of the session location */
  longitude: Scalars['Float']['output'];
  /** Optional session name */
  name?: Maybe<Scalars['String']['output']>;
  /** Number of users currently in the session */
  participantCount: Scalars['Int']['output'];
};

/** Event when the wall driver changes (the participant authorized to drive the wall via the queue-control-bar pivot's lightbulb). Null when no member is currently driving. */
export type DriverChanged = {
  __typename?: 'DriverChanged';
  /** Stable participant id of the new driver, or null when control was released */
  driverParticipantId?: Maybe<Scalars['ID']['output']>;
  /** Stable participant id of the previous driver, or null when there was none (e.g. the very first take of the session, or after a release). Lets clients render 'X took the wall from Y' toasts and populate the Phase 5 previousDriver analytics property without local bookkeeping. */
  previousDriverParticipantId?: Maybe<Scalars['ID']['output']>;
};

/**
 * Response containing events since a given sequence number.
 * Used for delta synchronization when reconnecting.
 */
export type EventsReplayResponse = {
  __typename?: 'EventsReplayResponse';
  /** Current sequence number after all events */
  currentSequence: Scalars['Int']['output'];
  /** List of events since the requested sequence */
  events: Array<QueueEvent>;
};

/** Count of favorited climbs per board. */
export type FavoritesCount = {
  __typename?: 'FavoritesCount';
  /** Board name */
  boardName: Scalars['String']['output'];
  /** Number of favorited climbs */
  count: Scalars['Int']['output'];
};

/**
 * Free-form debug context attached to a feedback submission. Stored as jsonb.
 * Every field is optional — anonymous submissions made outside a board route
 * may carry only `url` / `userAgent`.
 */
export type FeedbackContextInput = {
  climbName?: InputMaybe<Scalars['String']['input']>;
  climbUuid?: InputMaybe<Scalars['String']['input']>;
  difficulty?: InputMaybe<Scalars['String']['input']>;
  sessionId?: InputMaybe<Scalars['String']['input']>;
  sessionName?: InputMaybe<Scalars['String']['input']>;
  url?: InputMaybe<Scalars['String']['input']>;
  userAgent?: InputMaybe<Scalars['String']['input']>;
};

/** Input for following/unfollowing a board. */
export type FollowBoardInput = {
  /** Board UUID */
  boardUuid: Scalars['ID']['input'];
};

/** Paginated list of user profiles (for follower/following lists). */
export type FollowConnection = {
  __typename?: 'FollowConnection';
  /** Whether more users are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of users */
  totalCount: Scalars['Int']['output'];
  /** List of user profiles */
  users: Array<PublicUserProfile>;
};

/** Input for following/unfollowing a gym. */
export type FollowGymInput = {
  /** Gym UUID */
  gymUuid: Scalars['ID']['input'];
};

/** Input for follow/unfollow operations. */
export type FollowInput = {
  /** User ID to follow/unfollow */
  userId: Scalars['ID']['input'];
};

/** Input for listing followers or following. */
export type FollowListInput = {
  /** Maximum number of users to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of users to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** User ID whose followers/following to list */
  userId: Scalars['ID']['input'];
};

/** Input for following/unfollowing a playlist. */
export type FollowPlaylistInput = {
  /** The playlist UUID */
  playlistUuid: Scalars['ID']['input'];
};

/** Input for following/unfollowing a setter. */
export type FollowSetterInput = {
  /** The setter's Aurora username */
  setterUsername: Scalars['String']['input'];
};

/** An ascent from a followed user, enriched with user and climb data. */
export type FollowingAscentFeedItem = {
  __typename?: 'FollowingAscentFeedItem';
  /** Board angle */
  angle: Scalars['Int']['output'];
  /** Number of attempts */
  attemptCount: Scalars['Int']['output'];
  /** Board type */
  boardType: Scalars['String']['output'];
  /** Name of the climb */
  climbName: Scalars['String']['output'];
  /** UUID of the climb */
  climbUuid: Scalars['String']['output'];
  /** When climbed (ISO 8601) */
  climbedAt: Scalars['String']['output'];
  /** Comment */
  comment: Scalars['String']['output'];
  /** Number of (non-deleted) comments on this tick. Null if the resolver doesn't compute it. */
  commentCount?: Maybe<Scalars['Int']['output']>;
  /** Difficulty rating */
  difficulty?: Maybe<Scalars['Int']['output']>;
  /** Human-readable difficulty name */
  difficultyName?: Maybe<Scalars['String']['output']>;
  /** Number of downvotes on this tick. Null if the resolver doesn't compute it. */
  downvotes?: Maybe<Scalars['Int']['output']>;
  /** Encoded hold frames for thumbnail display */
  frames?: Maybe<Scalars['String']['output']>;
  /** Whether this is a benchmark climb */
  isBenchmark: Scalars['Boolean']['output'];
  /** Whether climb was mirrored */
  isMirror: Scalars['Boolean']['output'];
  /** Whether matching is disallowed on this climb */
  isNoMatch: Scalars['Boolean']['output'];
  /** Layout ID */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** Quality rating */
  quality?: Maybe<Scalars['Int']['output']>;
  /** Username of the setter */
  setterUsername?: Maybe<Scalars['String']['output']>;
  /** Result of the attempt */
  status: Scalars['String']['output'];
  /** Number of upvotes (likes) on this tick. Null if the resolver doesn't compute it. */
  upvotes?: Maybe<Scalars['Int']['output']>;
  /** Avatar URL of the user */
  userAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name of the user */
  userDisplayName?: Maybe<Scalars['String']['output']>;
  /** User who climbed */
  userId: Scalars['ID']['output'];
  /** Tick UUID */
  uuid: Scalars['ID']['output'];
};

/** Input for following ascents feed pagination. */
export type FollowingAscentsFeedInput = {
  /** Maximum number of items to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of items to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
};

/** Paginated feed of ascents from followed users. */
export type FollowingAscentsFeedResult = {
  __typename?: 'FollowingAscentsFeedResult';
  /** Whether more items are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of feed items */
  items: Array<FollowingAscentFeedItem>;
  /** Total count for pagination */
  totalCount: Scalars['Int']['output'];
};

/** Input for fetching followed users' ticks on a specific climb. */
export type FollowingClimbAscentsInput = {
  /** Board type (kilter, tension, moonboard) */
  boardType: Scalars['String']['input'];
  /** Climb UUID */
  climbUuid: Scalars['String']['input'];
};

/** Unpaginated result: all ticks from followed users for a given climb. */
export type FollowingClimbAscentsResult = {
  __typename?: 'FollowingClimbAscentsResult';
  /** List of feed items */
  items: Array<FollowingAscentFeedItem>;
};

export type FreezeClimbInput = {
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
  frozen: Scalars['Boolean']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

/**
 * Full queue state sync event.
 * Sent on initial connection or when delta sync isn't possible.
 */
export type FullSync = {
  __typename?: 'FullSync';
  /** Current sequence number */
  sequence: Scalars['Int']['output'];
  /** Complete queue state */
  state: QueueState;
};

/** Input for getting all user's playlists across boards. */
export type GetAllUserPlaylistsInput = {
  /** Optional filter by board type */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Optional filter by layout ID (includes playlists with null layoutId) */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (0-indexed) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Page size */
  pageSize?: InputMaybe<Scalars['Int']['input']>;
};

export type GetClimbProposalsInput = {
  angle?: InputMaybe<Scalars['Int']['input']>;
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<ProposalStatus>;
  type?: InputMaybe<ProposalType>;
};

/** Input for getting the authenticated user's pinned playlists. */
export type GetMyPinnedPlaylistsInput = {
  /** Optional filter by board type */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Optional filter by layout ID (includes playlists with null layoutId) */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
};

/** Input for getting climbs in a playlist with full data. */
export type GetPlaylistClimbsInput = {
  /** Board angle */
  angle?: InputMaybe<Scalars['Int']['input']>;
  /** Board name for climb lookup (omit for all-boards mode) */
  boardName?: InputMaybe<Scalars['String']['input']>;
  /** Layout ID */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** Page number */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Page size */
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  /** Playlist ID */
  playlistId: Scalars['ID']['input'];
  /** Set IDs */
  setIds?: InputMaybe<Scalars['String']['input']>;
  /** Size ID */
  sizeId?: InputMaybe<Scalars['Int']['input']>;
};

/** Input for getting playlist creators. */
export type GetPlaylistCreatorsInput = {
  /** Board type */
  boardType: Scalars['String']['input'];
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
  /** Search query for autocomplete */
  searchQuery?: InputMaybe<Scalars['String']['input']>;
};

/** Input for getting playlists containing a climb. */
export type GetPlaylistsForClimbInput = {
  /** Board type */
  boardType: Scalars['String']['input'];
  /** Climb UUID to search for */
  climbUuid: Scalars['String']['input'];
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
};

/** Input for getting playlists containing multiple climbs (batch). */
export type GetPlaylistsForClimbsInput = {
  /** Board type */
  boardType: Scalars['String']['input'];
  /** Climb UUIDs to search for */
  climbUuids: Array<Scalars['String']['input']>;
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
};

/** Input for fetching a smart playlist. */
export type GetSmartPlaylistInput = {
  /** Filter to a board type (optional) */
  boardName?: InputMaybe<Scalars['String']['input']>;
  /** Page number */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Page size */
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  /** Smart playlist type */
  type: SmartPlaylistType;
  /** User whose logbook to compute from */
  userId: Scalars['ID']['input'];
};

/** Input for fetching user's ticks. */
export type GetTicksInput = {
  /** Board type to filter by */
  boardType: Scalars['String']['input'];
  /** Optional list of climb UUIDs to filter by */
  climbUuids?: InputMaybe<Array<Scalars['String']['input']>>;
};

/** Input for getting user's favorite climbs with full data. */
export type GetUserFavoriteClimbsInput = {
  /** Board angle */
  angle: Scalars['Int']['input'];
  /** Board type */
  boardName: Scalars['String']['input'];
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
  /** Page number */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Page size */
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  /** Set IDs */
  setIds: Scalars['String']['input'];
  /** Size ID */
  sizeId: Scalars['Int']['input'];
};

/** Input for getting user's playlists. */
export type GetUserPlaylistsInput = {
  /** Filter by board type */
  boardType: Scalars['String']['input'];
  /** Filter by layout ID */
  layoutId: Scalars['Int']['input'];
};

/** Input for the global comment feed query. */
export type GlobalCommentFeedInput = {
  /** Filter by board UUID */
  boardUuid?: InputMaybe<Scalars['String']['input']>;
  /** Cursor from previous page */
  cursor?: InputMaybe<Scalars['String']['input']>;
  /** Maximum number of comments to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
};

/** A difficulty grade for a board type. */
export type Grade = {
  __typename?: 'Grade';
  /** Numeric difficulty identifier */
  difficultyId: Scalars['Int']['output'];
  /** Human-readable grade name (e.g., 'V5', '6B+') */
  name: Scalars['String']['output'];
};

/** Count of distinct climbs at a specific grade. */
export type GradeCount = {
  __typename?: 'GradeCount';
  /** Number of distinct climbs sent at this grade */
  count: Scalars['Int']['output'];
  /** Grade name */
  grade: Scalars['String']['output'];
};

export type GrantRoleInput = {
  boardType?: InputMaybe<Scalars['String']['input']>;
  role: CommunityRoleType;
  userId: Scalars['ID']['input'];
};

/**
 * Grouped climb attempts for a single climb on a single day.
 * Useful for displaying activity summaries.
 */
export type GroupedAscentFeedItem = {
  __typename?: 'GroupedAscentFeedItem';
  /** Board angle */
  angle: Scalars['Int']['output'];
  /** Number of attempts without send */
  attemptCount: Scalars['Int']['output'];
  /** Best quality rating from any attempt */
  bestQuality?: Maybe<Scalars['Int']['output']>;
  /** Board type */
  boardType: Scalars['String']['output'];
  /** Name of the climb */
  climbName: Scalars['String']['output'];
  /** UUID of the climb */
  climbUuid: Scalars['String']['output'];
  /** Date of the attempts (YYYY-MM-DD) */
  date: Scalars['String']['output'];
  /** Human-readable difficulty name */
  difficultyName?: Maybe<Scalars['String']['output']>;
  /** Number of flash sends */
  flashCount: Scalars['Int']['output'];
  /** Encoded hold frames for thumbnail */
  frames?: Maybe<Scalars['String']['output']>;
  /** Whether this is a benchmark climb */
  isBenchmark: Scalars['Boolean']['output'];
  /** Whether climb was mirrored */
  isMirror: Scalars['Boolean']['output'];
  /** Whether matching is disallowed on this climb */
  isNoMatch: Scalars['Boolean']['output'];
  /** Individual items in this group */
  items: Array<AscentFeedItem>;
  /** Unique key for this group (climbUuid-date) */
  key: Scalars['String']['output'];
  /** Most recent comment */
  latestComment?: Maybe<Scalars['String']['output']>;
  /** Layout ID */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** Number of regular sends */
  sendCount: Scalars['Int']['output'];
  /** Username of the setter */
  setterUsername?: Maybe<Scalars['String']['output']>;
};

/** Paginated grouped ascent feed result. */
export type GroupedAscentFeedResult = {
  __typename?: 'GroupedAscentFeedResult';
  /** List of grouped items */
  groups: Array<GroupedAscentFeedItem>;
  /** Whether more groups are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total count */
  totalCount: Scalars['Int']['output'];
};

/** A grouped notification combining multiple notifications of the same type on the same entity. */
export type GroupedNotification = {
  __typename?: 'GroupedNotification';
  /** Number of distinct actors */
  actorCount: Scalars['Int']['output'];
  /** First few actors (up to 3) */
  actors: Array<GroupedNotificationActor>;
  /** Board type */
  boardType?: Maybe<Scalars['String']['output']>;
  /** Climb name */
  climbName?: Maybe<Scalars['String']['output']>;
  /** Climb UUID */
  climbUuid?: Maybe<Scalars['String']['output']>;
  /** Preview of comment body */
  commentBody?: Maybe<Scalars['String']['output']>;
  /** When the most recent notification was created */
  createdAt: Scalars['String']['output'];
  /** Entity ID */
  entityId?: Maybe<Scalars['String']['output']>;
  /** Entity type */
  entityType?: Maybe<SocialEntityType>;
  /** Whether all notifications in the group are read */
  isRead: Scalars['Boolean']['output'];
  /** Proposal UUID (for deep-linking to a specific proposal) */
  proposalUuid?: Maybe<Scalars['String']['output']>;
  /** Setter username (for new_climbs_synced notifications) */
  setterUsername?: Maybe<Scalars['String']['output']>;
  /** Type of notification */
  type: NotificationType;
  /** UUID of the most recent notification in the group */
  uuid: Scalars['ID']['output'];
};

/** An actor in a grouped notification. */
export type GroupedNotificationActor = {
  __typename?: 'GroupedNotificationActor';
  /** Avatar URL */
  avatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name */
  displayName?: Maybe<Scalars['String']['output']>;
  /** User ID */
  id: Scalars['ID']['output'];
};

/** Paginated grouped notification list. */
export type GroupedNotificationConnection = {
  __typename?: 'GroupedNotificationConnection';
  /** List of grouped notifications */
  groups: Array<GroupedNotification>;
  /** Whether more groups are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of groups */
  totalCount: Scalars['Int']['output'];
  /** Number of unread notifications */
  unreadCount: Scalars['Int']['output'];
};

/** A physical gym location that can contain multiple boards. */
export type Gym = {
  __typename?: 'Gym';
  /** Physical address */
  address?: Maybe<Scalars['String']['output']>;
  /** Number of linked boards */
  boardCount: Scalars['Int']['output'];
  /** Number of comments */
  commentCount: Scalars['Int']['output'];
  /** Contact email */
  contactEmail?: Maybe<Scalars['String']['output']>;
  /** Contact phone */
  contactPhone?: Maybe<Scalars['String']['output']>;
  /** When created */
  createdAt: Scalars['String']['output'];
  /** Optional description */
  description?: Maybe<Scalars['String']['output']>;
  /** Number of followers */
  followerCount: Scalars['Int']['output'];
  /** Image URL */
  imageUrl?: Maybe<Scalars['String']['output']>;
  /** Whether the current user follows this gym */
  isFollowedByMe: Scalars['Boolean']['output'];
  /** Whether the current user is a member */
  isMember: Scalars['Boolean']['output'];
  /** Whether publicly visible */
  isPublic: Scalars['Boolean']['output'];
  /** GPS latitude */
  latitude?: Maybe<Scalars['Float']['output']>;
  /** GPS longitude */
  longitude?: Maybe<Scalars['Float']['output']>;
  /** Number of members */
  memberCount: Scalars['Int']['output'];
  /** Current user's role (null if not a member/owner) */
  myRole?: Maybe<GymMemberRole>;
  /** Gym name */
  name: Scalars['String']['output'];
  /** Owner avatar URL */
  ownerAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Owner display name */
  ownerDisplayName?: Maybe<Scalars['String']['output']>;
  /** Owner user ID */
  ownerId: Scalars['ID']['output'];
  /** URL slug for this gym */
  slug?: Maybe<Scalars['String']['output']>;
  /** Unique identifier */
  uuid: Scalars['ID']['output'];
};

/** Paginated list of gyms. */
export type GymConnection = {
  __typename?: 'GymConnection';
  /** List of gyms */
  gyms: Array<Gym>;
  /** Whether more gyms are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of gyms */
  totalCount: Scalars['Int']['output'];
};

/** A member of a gym. */
export type GymMember = {
  __typename?: 'GymMember';
  /** Avatar URL */
  avatarUrl?: Maybe<Scalars['String']['output']>;
  /** When the member joined */
  createdAt: Scalars['String']['output'];
  /** Display name */
  displayName?: Maybe<Scalars['String']['output']>;
  /** Role in the gym */
  role: GymMemberRole;
  /** User ID */
  userId: Scalars['ID']['output'];
};

/** Paginated list of gym members. */
export type GymMemberConnection = {
  __typename?: 'GymMemberConnection';
  /** Whether more members are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of members */
  members: Array<GymMember>;
  /** Total number of members */
  totalCount: Scalars['Int']['output'];
};

export type GymMemberRole = 'admin' | 'member';

/** Input for listing gym members. */
export type GymMembersInput = {
  /** Gym UUID */
  gymUuid: Scalars['ID']['input'];
  /** Max members to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Offset for pagination */
  offset?: InputMaybe<Scalars['Int']['input']>;
};

/** Statistics for a specific board layout. */
export type LayoutStats = {
  __typename?: 'LayoutStats';
  /** Board type */
  boardType: Scalars['String']['output'];
  /** Total distinct climbs sent */
  distinctClimbCount: Scalars['Int']['output'];
  /** Breakdown by grade */
  gradeCounts: Array<GradeCount>;
  /** Layout ID */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** Unique key for this layout configuration */
  layoutKey: Scalars['String']['output'];
};

/** Event when session leadership changes. */
export type LeaderChanged = {
  __typename?: 'LeaderChanged';
  /** Connection ID of the new leader, for current-client leadership checks */
  leaderConnectionId?: Maybe<Scalars['ID']['output']>;
  /** Stable participant ID of the new leader */
  leaderId: Scalars['ID']['output'];
};

export type LedCommand = {
  __typename?: 'LedCommand';
  b: Scalars['Int']['output'];
  g: Scalars['Int']['output'];
  position: Scalars['Int']['output'];
  r: Scalars['Int']['output'];
};

export type LedCommandInput = {
  b: Scalars['Int']['input'];
  g: Scalars['Int']['input'];
  position: Scalars['Int']['input'];
  r: Scalars['Int']['input'];
  role?: InputMaybe<Scalars['Int']['input']>;
};

export type LedUpdate = {
  __typename?: 'LedUpdate';
  /**
   * Board angle in degrees. Nullable - null means angle not specified.
   * Note: 0 is a valid angle value, so null should be used to indicate "no angle"
   * rather than defaulting to 0.
   */
  angle?: Maybe<Scalars['Int']['output']>;
  boardPath?: Maybe<Scalars['String']['output']>;
  /** ID of client that triggered this update (null if system-initiated). ESP32 uses this to decide whether to disconnect BLE client. */
  clientId?: Maybe<Scalars['String']['output']>;
  climbGrade?: Maybe<Scalars['String']['output']>;
  climbName?: Maybe<Scalars['String']['output']>;
  climbUuid?: Maybe<Scalars['String']['output']>;
  commands: Array<LedCommand>;
  gradeColor?: Maybe<Scalars['String']['output']>;
  navigation?: Maybe<QueueNavigationContext>;
  /** Queue item UUID (for reconciling optimistic UI) */
  queueItemUuid?: Maybe<Scalars['String']['output']>;
};

/** Input for linking a board to a gym. */
export type LinkBoardToGymInput = {
  /** Board UUID */
  boardUuid: Scalars['ID']['input'];
  /** Gym UUID (null to unlink) */
  gymUuid?: InputMaybe<Scalars['String']['input']>;
};

export type MoonBoardClimbDuplicateCandidateInput = {
  clientKey: Scalars['String']['input'];
  holds: MoonBoardHoldsInput;
};

export type MoonBoardClimbDuplicateMatch = {
  __typename?: 'MoonBoardClimbDuplicateMatch';
  clientKey: Scalars['String']['output'];
  existingClimbName?: Maybe<Scalars['String']['output']>;
  existingClimbUuid?: Maybe<Scalars['ID']['output']>;
  exists: Scalars['Boolean']['output'];
};

export type MoonBoardHoldsInput = {
  finish: Array<Scalars['String']['input']>;
  hand: Array<Scalars['String']['input']>;
  start: Array<Scalars['String']['input']>;
};

/** Root mutation type for all write operations. */
export type Mutation = {
  __typename?: 'Mutation';
  /** Add a climb to a playlist. */
  addClimbToPlaylist: PlaylistClimb;
  /** Add a comment to an entity. */
  addComment: Comment;
  /**
   * Add a climb to favorites. Idempotent (ON CONFLICT DO NOTHING) so the offline
   * mutation queue can safely retry. Always returns true.
   */
  addFavorite: Scalars['Boolean']['output'];
  /** Add a member to a gym. */
  addGymMember: Scalars['Boolean']['output'];
  /**
   * Add a climb to the queue.
   * Optional position parameter for inserting at specific index.
   */
  addQueueItem: ClimbQueueItem;
  /**
   * Add a user to an inferred session by reassigning their overlapping ticks.
   * Must be a participant of the session.
   */
  addUserToSession?: Maybe<SessionDetail>;
  /**
   * Attach an Instagram post or reel as beta for a climb. Idempotent on
   * (boardType, climbUuid, link).
   */
  attachBetaLink: Scalars['Boolean']['output'];
  authorizeControllerForSession: Scalars['Boolean']['output'];
  /**
   * Confirm to all session participants that a climb was successfully relayed to the wall
   * over BLE from this client's phone. Any session participant may call (no driver
   * requirement) — the BLE-capable phone that handled the send is the source of truth for
   * confirmation. The server stamps `confirmedAt` and `confirmedByParticipantId` from
   * the caller's identity; clients cannot forge either field. Publishes
   * `WallConfirmedClimb`. The optional `queueItemUuid` disambiguates the press when
   * the same climb is queued twice. Returns the resolved Session so optimistic-UI callers
   * can apply server-derived state without a follow-up query (symmetric with
   * `takeControl` / `releaseControl`). Session identity is resolved from the WebSocket
   * connection context — no `sessionId` argument is required.
   */
  confirmClimbOnWall: Session;
  controllerHeartbeat: Scalars['Boolean']['output'];
  /** Create a new board. */
  createBoard: UserBoard;
  /** Create a new gym. */
  createGym: Gym;
  /** Create a new playlist. */
  createPlaylist: Playlist;
  /** Create a proposal for a climb grade/classic/benchmark change. */
  createProposal: Proposal;
  /** Create a new session with GPS coordinates for discovery. */
  createSession: Session;
  /**
   * Delete the current user's account.
   * Deletes draft climbs, optionally removes setter name from published climbs,
   * then deletes the user row (cascading all related data).
   * Requires authentication.
   */
  deleteAccount: Scalars['Boolean']['output'];
  /** Delete stored Aurora credentials for a board type. */
  deleteAuroraCredential: Scalars['Boolean']['output'];
  /** Soft-delete a board. */
  deleteBoard: Scalars['Boolean']['output'];
  /** Delete a comment (soft-delete if it has replies). */
  deleteComment: Scalars['Boolean']['output'];
  deleteController: Scalars['Boolean']['output'];
  /**
   * Delete one of the current user's unpublished draft climbs.
   * Published climbs cannot be deleted through this mutation.
   */
  deleteDraftClimb: Scalars['Boolean']['output'];
  /** Soft-delete a gym. */
  deleteGym: Scalars['Boolean']['output'];
  /** Delete a playlist (owner only). */
  deletePlaylist: Scalars['Boolean']['output'];
  /** Delete an accepted proposal and revert its effects (admin/leader only). */
  deleteProposal: Scalars['Boolean']['output'];
  /** Delete a tick (climb attempt record). Only the owner can delete. */
  deleteTick: Scalars['Boolean']['output'];
  /** End a session (active participant only). */
  endSession?: Maybe<SessionSummary>;
  /** Follow a board. */
  followBoard: Scalars['Boolean']['output'];
  /** Follow a gym. */
  followGym: Scalars['Boolean']['output'];
  /** Follow a playlist. Idempotent. Only public playlists can be followed. */
  followPlaylist: Scalars['Boolean']['output'];
  /** Follow a setter by username. Idempotent. */
  followSetter: Scalars['Boolean']['output'];
  /** Follow a user. Idempotent (no error if already following). */
  followUser: Scalars['Boolean']['output'];
  /** Freeze or unfreeze a climb from receiving proposals (admin/leader only). */
  freezeClimb: Scalars['Boolean']['output'];
  /** Grant a community role to a user (admin only). */
  grantRole: CommunityRoleAssignment;
  /**
   * Join an existing session or create it if it doesn't exist.
   * Returns the session with current state.
   */
  joinSession: Session;
  /** Leave the current session. */
  leaveSession: Scalars['Boolean']['output'];
  /** Link or unlink a board to/from a gym. */
  linkBoardToGym: Scalars['Boolean']['output'];
  /** Mark all notifications as read. */
  markAllNotificationsRead: Scalars['Boolean']['output'];
  /**
   * Mark all notifications in a group as read.
   * Returns the number of notifications that were marked as read.
   */
  markGroupNotificationsRead: Scalars['Int']['output'];
  /** Mark a notification as read. */
  markNotificationRead: Scalars['Boolean']['output'];
  /** Toggle mirrored display for the current climb. */
  mirrorCurrentClimb?: Maybe<ClimbQueueItem>;
  navigateQueue?: Maybe<ClimbQueueItem>;
  /**
   * Pin a playlist to the authenticated user's library. Idempotent.
   * Pinning is per-user; the same playlist can be pinned by many users.
   * Only playlists the user can access (own or public) may be pinned.
   */
  pinPlaylist: Scalars['Boolean']['output'];
  /**
   * Register an APNs device token for Live Activity push updates in a session.
   * Caller must be authenticated and be a participant in the session.
   * Upserts: if the token already exists, updates the associated session.
   */
  registerActivityPushToken: Scalars['Boolean']['output'];
  registerController: ControllerRegistration;
  /**
   * Release wall-control authority. Clears the driver only when the caller is the current
   * driver (idempotent otherwise). Publishes `DriverChanged { driverParticipantId: null }`.
   */
  releaseControl: Session;
  /** Remove a climb from a playlist. */
  removeClimbFromPlaylist: Scalars['Boolean']['output'];
  /**
   * Remove a climb from favorites. Idempotent (deleting a nonexistent row is a
   * no-op) so the offline mutation queue can safely retry. Always returns true.
   */
  removeFavorite: Scalars['Boolean']['output'];
  /** Remove a member from a gym. */
  removeGymMember: Scalars['Boolean']['output'];
  /** Remove a climb from the queue by its queue item UUID. */
  removeQueueItem: Scalars['Boolean']['output'];
  /**
   * Remove a user from an inferred session, restoring their ticks to original sessions.
   * Must be a participant of the session.
   */
  removeUserFromSession?: Maybe<SessionDetail>;
  /** Move a queue item from one position to another. */
  reorderQueueItem: Scalars['Boolean']['output'];
  /** Replace a queue item with a new one (same UUID). */
  replaceQueueItem: ClimbQueueItem;
  /** Resolve a proposal (admin/leader only). */
  resolveProposal: Proposal;
  /** Revoke a community role from a user (admin only). */
  revokeRole: Scalars['Boolean']['output'];
  /**
   * Save Aurora climbing credentials.
   * Validates with Aurora API before saving.
   */
  saveAuroraCredential: AuroraCredentialStatus;
  /** Save a new climb for an Aurora-style board. */
  saveClimb: SaveClimbResult;
  /** Save a new MoonBoard climb. */
  saveMoonBoardClimb: SaveClimbResult;
  /** Save a new tick (climb attempt record). */
  saveTick: Tick;
  sendDeviceLogs: SendDeviceLogsResponse;
  setClimbFromLedPositions: ClimbMatchResult;
  /** Set a community setting (admin/leader only). */
  setCommunitySettings: CommunitySetting;
  /**
   * Set the currently displayed climb.
   * Optionally adds it to the queue if not already present.
   */
  setCurrentClimb?: Maybe<ClimbQueueItem>;
  /**
   * Record that an inferred session has been mirrored to Apple HealthKit,
   * storing the workout UUID for de-duplication and UI status.
   * Must be a participant of the session.
   */
  setInferredSessionHealthKitWorkoutId: Scalars['Boolean']['output'];
  /**
   * Replace the entire queue state.
   * Used for bulk operations or syncing from external sources.
   */
  setQueue: QueueState;
  /**
   * Update the session's stored boardPath so every participant follows the same
   * angle (and any future presentational route-segment changes). Today the
   * angle is the only route-level dimension that members observe as a group;
   * climb URLs are managed by setCurrentClimb. Any participant may call —
   * angle is presentational and doesn't drive BLE (hold positions are sent
   * per-climb), so the queue-control-bar pivot's "only driver moves the wall"
   * rule doesn't apply. Idempotent: when the stored boardPath already matches,
   * no event fires. Publishes `SessionBoardPathChanged` on change. Returns
   * the resolved Session for optimistic-UI symmetry with takeControl /
   * releaseControl. Session identity is resolved from the WebSocket connection
   * context — no `sessionId` argument is required.
   */
  setSessionBoardPath: Session;
  /**
   * Record the BLE board serial that this client paired with so other (mobile)
   * participants can auto-connect to the same physical board. Any session participant
   * may call. Idempotent: when the stored serial already matches, no event fires.
   * Publishes `SessionBoardSerialChanged` on change. Returns the resolved Session for
   * optimistic-UI symmetry with `takeControl` / `releaseControl`. Session identity is
   * resolved from the WebSocket connection context — no `sessionId` argument is required.
   */
  setSessionBoardSerial: Session;
  /** Setter override: directly set community status for your own climb. */
  setterOverrideCommunityStatus: ClimbCommunityStatus;
  /**
   * Submit in-app rating + optional comment. Public — unauthenticated testers
   * can still rate. If the request has a valid auth token, the feedback row is
   * associated with the user.
   */
  submitAppFeedback: Scalars['Boolean']['output'];
  /** Subscribe to new climbs for a board type and layout. */
  subscribeNewClimbs: Scalars['Boolean']['output'];
  /**
   * Claim wall-control authority in the current session and optionally broadcast a climb.
   * Any session participant may call — yank-on-press by design. If `climb` is provided, also
   * appends it to the queue (when not already present) and sets it as the current climb,
   * mirroring `setCurrentClimb`'s side effects. Publishes `DriverChanged`.
   */
  takeControl: Session;
  /**
   * Toggle favorite status for a climb.
   * Returns new favorite state.
   */
  toggleFavorite: ToggleFavoriteResult;
  /** Unfollow a board. */
  unfollowBoard: Scalars['Boolean']['output'];
  /** Unfollow a gym. */
  unfollowGym: Scalars['Boolean']['output'];
  /** Unfollow a playlist. */
  unfollowPlaylist: Scalars['Boolean']['output'];
  /** Unfollow a setter by username. */
  unfollowSetter: Scalars['Boolean']['output'];
  /** Unfollow a user. */
  unfollowUser: Scalars['Boolean']['output'];
  /** Unpin a playlist. Idempotent. */
  unpinPlaylist: Scalars['Boolean']['output'];
  /**
   * Unregister an APNs device token for Live Activity push updates.
   * Caller must be authenticated and be a participant in the session.
   * The delete is scoped to (token, sessionId) so a leaked token cannot
   * be used to clear another session's registration.
   */
  unregisterActivityPushToken: Scalars['Boolean']['output'];
  /** Unsubscribe from new climbs for a board type and layout. */
  unsubscribeNewClimbs: Scalars['Boolean']['output'];
  /** Update a board's metadata. */
  updateBoard: UserBoard;
  /**
   * Update an existing climb. The caller must own the climb, and the climb
   * must either still be a draft or have been published within the last 24
   * hours. Used by the create form to let users keep tweaking a freshly
   * published climb.
   */
  updateClimb: UpdateClimbResult;
  /** Update a comment's body text. */
  updateComment: Comment;
  /** Update a gym's metadata. */
  updateGym: Gym;
  /**
   * Update an inferred session's name and/or description.
   * Must be a participant of the session.
   */
  updateInferredSession?: Maybe<SessionDetail>;
  /** Update playlist metadata. */
  updatePlaylist: Playlist;
  /** Update only lastAccessedAt for a playlist (does not update updatedAt). */
  updatePlaylistLastAccessed: Scalars['Boolean']['output'];
  /**
   * Update current user's profile.
   * Requires authentication.
   */
  updateProfile: UserProfile;
  /** Update an existing tick. Only the owner can update their own ticks. */
  updateTick: Tick;
  /** Update display name and avatar in the current session. */
  updateUsername: Scalars['Boolean']['output'];
  /** Vote on an entity. Same value toggles (removes vote). */
  vote: VoteSummary;
  /** Vote on an open proposal. */
  voteOnProposal: Proposal;
};

/** Root mutation type for all write operations. */
export type MutationAddClimbToPlaylistArgs = {
  input: AddClimbToPlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationAddCommentArgs = {
  input: AddCommentInput;
};

/** Root mutation type for all write operations. */
export type MutationAddFavoriteArgs = {
  input: AddFavoriteInput;
};

/** Root mutation type for all write operations. */
export type MutationAddGymMemberArgs = {
  input: AddGymMemberInput;
};

/** Root mutation type for all write operations. */
export type MutationAddQueueItemArgs = {
  item: ClimbQueueItemInput;
  position?: InputMaybe<Scalars['Int']['input']>;
};

/** Root mutation type for all write operations. */
export type MutationAddUserToSessionArgs = {
  input: AddUserToSessionInput;
};

/** Root mutation type for all write operations. */
export type MutationAttachBetaLinkArgs = {
  input: AttachBetaLinkInput;
};

/** Root mutation type for all write operations. */
export type MutationAuthorizeControllerForSessionArgs = {
  controllerId: Scalars['ID']['input'];
  sessionId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationConfirmClimbOnWallArgs = {
  climbUuid: Scalars['ID']['input'];
  queueItemUuid?: InputMaybe<Scalars['ID']['input']>;
};

/** Root mutation type for all write operations. */
export type MutationControllerHeartbeatArgs = {
  sessionId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationCreateBoardArgs = {
  input: CreateBoardInput;
};

/** Root mutation type for all write operations. */
export type MutationCreateGymArgs = {
  input: CreateGymInput;
};

/** Root mutation type for all write operations. */
export type MutationCreatePlaylistArgs = {
  input: CreatePlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationCreateProposalArgs = {
  input: CreateProposalInput;
};

/** Root mutation type for all write operations. */
export type MutationCreateSessionArgs = {
  input: CreateSessionInput;
};

/** Root mutation type for all write operations. */
export type MutationDeleteAccountArgs = {
  input: DeleteAccountInput;
};

/** Root mutation type for all write operations. */
export type MutationDeleteAuroraCredentialArgs = {
  boardType: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationDeleteBoardArgs = {
  boardUuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationDeleteCommentArgs = {
  commentUuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationDeleteControllerArgs = {
  controllerId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationDeleteDraftClimbArgs = {
  boardType: Scalars['String']['input'];
  uuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationDeleteGymArgs = {
  gymUuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationDeletePlaylistArgs = {
  playlistId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationDeleteProposalArgs = {
  input: DeleteProposalInput;
};

/** Root mutation type for all write operations. */
export type MutationDeleteTickArgs = {
  uuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationEndSessionArgs = {
  sessionId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationFollowBoardArgs = {
  input: FollowBoardInput;
};

/** Root mutation type for all write operations. */
export type MutationFollowGymArgs = {
  input: FollowGymInput;
};

/** Root mutation type for all write operations. */
export type MutationFollowPlaylistArgs = {
  input: FollowPlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationFollowSetterArgs = {
  input: FollowSetterInput;
};

/** Root mutation type for all write operations. */
export type MutationFollowUserArgs = {
  input: FollowInput;
};

/** Root mutation type for all write operations. */
export type MutationFreezeClimbArgs = {
  input: FreezeClimbInput;
};

/** Root mutation type for all write operations. */
export type MutationGrantRoleArgs = {
  input: GrantRoleInput;
};

/** Root mutation type for all write operations. */
export type MutationJoinSessionArgs = {
  avatarUrl?: InputMaybe<Scalars['String']['input']>;
  boardPath: Scalars['String']['input'];
  initialCurrentClimb?: InputMaybe<ClimbQueueItemInput>;
  initialQueue?: InputMaybe<Array<ClimbQueueItemInput>>;
  participantId?: InputMaybe<Scalars['ID']['input']>;
  sessionId: Scalars['ID']['input'];
  sessionName?: InputMaybe<Scalars['String']['input']>;
  username?: InputMaybe<Scalars['String']['input']>;
};

/** Root mutation type for all write operations. */
export type MutationLinkBoardToGymArgs = {
  input: LinkBoardToGymInput;
};

/** Root mutation type for all write operations. */
export type MutationMarkGroupNotificationsReadArgs = {
  entityId?: InputMaybe<Scalars['String']['input']>;
  entityType?: InputMaybe<SocialEntityType>;
  type: NotificationType;
};

/** Root mutation type for all write operations. */
export type MutationMarkNotificationReadArgs = {
  notificationUuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationMirrorCurrentClimbArgs = {
  mirrored: Scalars['Boolean']['input'];
};

/** Root mutation type for all write operations. */
export type MutationNavigateQueueArgs = {
  currentClimbUuid?: InputMaybe<Scalars['String']['input']>;
  direction: Scalars['String']['input'];
  queueItemUuid?: InputMaybe<Scalars['String']['input']>;
  sessionId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationPinPlaylistArgs = {
  input: PinPlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationRegisterActivityPushTokenArgs = {
  sessionId: Scalars['ID']['input'];
  token: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationRegisterControllerArgs = {
  input: RegisterControllerInput;
};

/** Root mutation type for all write operations. */
export type MutationRemoveClimbFromPlaylistArgs = {
  input: RemoveClimbFromPlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationRemoveFavoriteArgs = {
  input: RemoveFavoriteInput;
};

/** Root mutation type for all write operations. */
export type MutationRemoveGymMemberArgs = {
  input: RemoveGymMemberInput;
};

/** Root mutation type for all write operations. */
export type MutationRemoveQueueItemArgs = {
  uuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationRemoveUserFromSessionArgs = {
  input: RemoveUserFromSessionInput;
};

/** Root mutation type for all write operations. */
export type MutationReorderQueueItemArgs = {
  newIndex: Scalars['Int']['input'];
  oldIndex: Scalars['Int']['input'];
  uuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationReplaceQueueItemArgs = {
  item: ClimbQueueItemInput;
  uuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationResolveProposalArgs = {
  input: ResolveProposalInput;
};

/** Root mutation type for all write operations. */
export type MutationRevokeRoleArgs = {
  input: RevokeRoleInput;
};

/** Root mutation type for all write operations. */
export type MutationSaveAuroraCredentialArgs = {
  input: SaveAuroraCredentialInput;
};

/** Root mutation type for all write operations. */
export type MutationSaveClimbArgs = {
  input: SaveClimbInput;
};

/** Root mutation type for all write operations. */
export type MutationSaveMoonBoardClimbArgs = {
  input: SaveMoonBoardClimbInput;
};

/** Root mutation type for all write operations. */
export type MutationSaveTickArgs = {
  input: SaveTickInput;
};

/** Root mutation type for all write operations. */
export type MutationSendDeviceLogsArgs = {
  input: SendDeviceLogsInput;
};

/** Root mutation type for all write operations. */
export type MutationSetClimbFromLedPositionsArgs = {
  frames?: InputMaybe<Scalars['String']['input']>;
  positions?: InputMaybe<Array<LedCommandInput>>;
  sessionId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationSetCommunitySettingsArgs = {
  input: SetCommunitySettingInput;
};

/** Root mutation type for all write operations. */
export type MutationSetCurrentClimbArgs = {
  correlationId?: InputMaybe<Scalars['ID']['input']>;
  item?: InputMaybe<ClimbQueueItemInput>;
  shouldAddToQueue?: InputMaybe<Scalars['Boolean']['input']>;
};

/** Root mutation type for all write operations. */
export type MutationSetInferredSessionHealthKitWorkoutIdArgs = {
  sessionId: Scalars['ID']['input'];
  workoutId: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationSetQueueArgs = {
  currentClimbQueueItem?: InputMaybe<ClimbQueueItemInput>;
  queue: Array<ClimbQueueItemInput>;
};

/** Root mutation type for all write operations. */
export type MutationSetSessionBoardPathArgs = {
  boardPath: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationSetSessionBoardSerialArgs = {
  serial: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationSetterOverrideCommunityStatusArgs = {
  input: SetterOverrideInput;
};

/** Root mutation type for all write operations. */
export type MutationSubmitAppFeedbackArgs = {
  input: SubmitAppFeedbackInput;
};

/** Root mutation type for all write operations. */
export type MutationSubscribeNewClimbsArgs = {
  input: NewClimbSubscriptionInput;
};

/** Root mutation type for all write operations. */
export type MutationTakeControlArgs = {
  climb?: InputMaybe<ClimbQueueItemInput>;
};

/** Root mutation type for all write operations. */
export type MutationToggleFavoriteArgs = {
  input: ToggleFavoriteInput;
};

/** Root mutation type for all write operations. */
export type MutationUnfollowBoardArgs = {
  input: FollowBoardInput;
};

/** Root mutation type for all write operations. */
export type MutationUnfollowGymArgs = {
  input: FollowGymInput;
};

/** Root mutation type for all write operations. */
export type MutationUnfollowPlaylistArgs = {
  input: FollowPlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationUnfollowSetterArgs = {
  input: FollowSetterInput;
};

/** Root mutation type for all write operations. */
export type MutationUnfollowUserArgs = {
  input: FollowInput;
};

/** Root mutation type for all write operations. */
export type MutationUnpinPlaylistArgs = {
  input: PinPlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationUnregisterActivityPushTokenArgs = {
  sessionId: Scalars['ID']['input'];
  token: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationUnsubscribeNewClimbsArgs = {
  input: NewClimbSubscriptionInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdateBoardArgs = {
  input: UpdateBoardInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdateClimbArgs = {
  input: UpdateClimbInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdateCommentArgs = {
  input: UpdateCommentInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdateGymArgs = {
  input: UpdateGymInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdateInferredSessionArgs = {
  input: UpdateInferredSessionInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdatePlaylistArgs = {
  input: UpdatePlaylistInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdatePlaylistLastAccessedArgs = {
  playlistId: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationUpdateProfileArgs = {
  input: UpdateProfileInput;
};

/** Root mutation type for all write operations. */
export type MutationUpdateTickArgs = {
  input: UpdateTickInput;
  uuid: Scalars['ID']['input'];
};

/** Root mutation type for all write operations. */
export type MutationUpdateUsernameArgs = {
  avatarUrl?: InputMaybe<Scalars['String']['input']>;
  username: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationVoteArgs = {
  input: VoteInput;
};

/** Root mutation type for all write operations. */
export type MutationVoteOnProposalArgs = {
  input: VoteOnProposalInput;
};

/** Input for listing user's boards. */
export type MyBoardsInput = {
  /** Max boards to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Offset for pagination */
  offset?: InputMaybe<Scalars['Int']['input']>;
};

/** Input for listing current user's gyms. */
export type MyGymsInput = {
  /** Include gyms the user follows */
  includeFollowed?: InputMaybe<Scalars['Boolean']['input']>;
  /** Max gyms to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Offset for pagination */
  offset?: InputMaybe<Scalars['Int']['input']>;
};

export type NewClimbCreatedEvent = {
  __typename?: 'NewClimbCreatedEvent';
  climb: NewClimbFeedItem;
};

export type NewClimbFeedInput = {
  boardType: Scalars['String']['input'];
  layoutId: Scalars['Int']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};

export type NewClimbFeedItem = {
  __typename?: 'NewClimbFeedItem';
  angle?: Maybe<Scalars['Int']['output']>;
  boardType: Scalars['String']['output'];
  createdAt: Scalars['String']['output'];
  difficultyName?: Maybe<Scalars['String']['output']>;
  frames?: Maybe<Scalars['String']['output']>;
  /** Whether matching is disallowed on this climb */
  isNoMatch: Scalars['Boolean']['output'];
  layoutId: Scalars['Int']['output'];
  name?: Maybe<Scalars['String']['output']>;
  setterAvatarUrl?: Maybe<Scalars['String']['output']>;
  setterDisplayName?: Maybe<Scalars['String']['output']>;
  uuid: Scalars['ID']['output'];
};

export type NewClimbFeedResult = {
  __typename?: 'NewClimbFeedResult';
  hasMore: Scalars['Boolean']['output'];
  items: Array<NewClimbFeedItem>;
  totalCount: Scalars['Int']['output'];
};

export type NewClimbSubscription = {
  __typename?: 'NewClimbSubscription';
  boardType: Scalars['String']['output'];
  createdAt: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  layoutId: Scalars['Int']['output'];
};

export type NewClimbSubscriptionInput = {
  boardType: Scalars['String']['input'];
  layoutId: Scalars['Int']['input'];
};

/** A notification for a user about social activity. */
export type Notification = {
  __typename?: 'Notification';
  /** Avatar URL of the actor */
  actorAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name of the actor */
  actorDisplayName?: Maybe<Scalars['String']['output']>;
  /** User ID of the actor who caused the notification */
  actorId?: Maybe<Scalars['String']['output']>;
  /** Board type (for navigation) */
  boardType?: Maybe<Scalars['String']['output']>;
  /** Name of the climb (for climb-related notifications) */
  climbName?: Maybe<Scalars['String']['output']>;
  /** UUID of the climb (for navigation) */
  climbUuid?: Maybe<Scalars['String']['output']>;
  /** Preview of comment body (for comment notifications) */
  commentBody?: Maybe<Scalars['String']['output']>;
  /** When the notification was created (ISO 8601) */
  createdAt: Scalars['String']['output'];
  /** Entity ID this notification relates to */
  entityId?: Maybe<Scalars['String']['output']>;
  /** Entity type this notification relates to */
  entityType?: Maybe<SocialEntityType>;
  /** Whether the notification has been read */
  isRead: Scalars['Boolean']['output'];
  /** Proposal UUID (for proposal notifications, to deep-link to the specific proposal) */
  proposalUuid?: Maybe<Scalars['String']['output']>;
  /** Type of notification */
  type: NotificationType;
  /** Public unique identifier */
  uuid: Scalars['ID']['output'];
};

/** Paginated list of notifications with counts. */
export type NotificationConnection = {
  __typename?: 'NotificationConnection';
  /** Whether more notifications are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of notifications */
  notifications: Array<Notification>;
  /** Total number of notifications */
  totalCount: Scalars['Int']['output'];
  /** Number of unread notifications */
  unreadCount: Scalars['Int']['output'];
};

/** Subscription payload for real-time notification delivery. */
export type NotificationEvent = {
  __typename?: 'NotificationEvent';
  /** The notification that was received */
  notification: Notification;
};

export type NotificationType =
  | 'comment_on_climb'
  | 'comment_on_tick'
  | 'comment_reply'
  | 'new_climb'
  | 'new_climb_global'
  | 'new_follower'
  | 'proposal_approved'
  | 'proposal_created'
  | 'proposal_rejected'
  | 'proposal_vote'
  | 'vote_on_comment'
  | 'vote_on_tick';

/** Analysis of whether a climb's grade is an outlier compared to adjacent angles. */
export type OutlierAnalysis = {
  __typename?: 'OutlierAnalysis';
  currentGrade: Scalars['Float']['output'];
  gradeDifference: Scalars['Float']['output'];
  isOutlier: Scalars['Boolean']['output'];
  neighborAverage: Scalars['Float']['output'];
  neighborCount: Scalars['Int']['output'];
};

/** Input for pinning/unpinning a playlist. */
export type PinPlaylistInput = {
  /** The playlist UUID */
  playlistUuid: Scalars['ID']['input'];
};

/** A user-created collection of climbs. */
export type Playlist = {
  __typename?: 'Playlist';
  /** Board type */
  boardType: Scalars['String']['output'];
  /** Number of climbs in playlist */
  climbCount: Scalars['Int']['output'];
  /** Display color */
  color?: Maybe<Scalars['String']['output']>;
  /** When created (ISO 8601) */
  createdAt: Scalars['String']['output'];
  /** Optional description */
  description?: Maybe<Scalars['String']['output']>;
  /** Number of users following this playlist */
  followerCount: Scalars['Int']['output'];
  /** Display icon */
  icon?: Maybe<Scalars['String']['output']>;
  /** Database ID */
  id: Scalars['ID']['output'];
  /** Whether the current user follows this playlist */
  isFollowedByMe: Scalars['Boolean']['output'];
  /** Whether the current user has pinned this playlist (false when unauthenticated) */
  isPinnedByMe: Scalars['Boolean']['output'];
  /** Whether publicly visible */
  isPublic: Scalars['Boolean']['output'];
  /** When last accessed/viewed (ISO 8601) */
  lastAccessedAt?: Maybe<Scalars['String']['output']>;
  /** Layout ID (null for Aurora-synced circuits) */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** Playlist name */
  name: Scalars['String']['output'];
  /** When last updated (ISO 8601) */
  updatedAt: Scalars['String']['output'];
  /** Current user's role (owner/editor/viewer) */
  userRole?: Maybe<Scalars['String']['output']>;
  /** Unique identifier */
  uuid: Scalars['ID']['output'];
};

/** A climb within a playlist. */
export type PlaylistClimb = {
  __typename?: 'PlaylistClimb';
  /** When added (ISO 8601) */
  addedAt: Scalars['String']['output'];
  /** Board angle (null for Aurora circuits) */
  angle?: Maybe<Scalars['Int']['output']>;
  /** UUID of the climb */
  climbUuid: Scalars['String']['output'];
  /** Database ID */
  id: Scalars['ID']['output'];
  /** Playlist ID */
  playlistId: Scalars['ID']['output'];
  /** Position in playlist */
  position: Scalars['Int']['output'];
};

/** Result of fetching playlist climbs. */
export type PlaylistClimbsResult = {
  __typename?: 'PlaylistClimbsResult';
  /** List of climbs with full data */
  climbs: Array<Climb>;
  /** Whether more are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total count */
  totalCount: Scalars['Int']['output'];
};

/** A user who has created public playlists. */
export type PlaylistCreator = {
  __typename?: 'PlaylistCreator';
  /** Display name */
  displayName: Scalars['String']['output'];
  /** Number of public playlists */
  playlistCount: Scalars['Int']['output'];
  /** User ID */
  userId: Scalars['ID']['output'];
};

/**
 * A popular board configuration (board type + layout + size + hold sets),
 * derived from the catalog of valid configurations ranked by climb count.
 */
export type PopularBoardConfig = {
  __typename?: 'PopularBoardConfig';
  /** Number of registered boards with this layout/size combination */
  boardCount: Scalars['Int']['output'];
  /** Board type (kilter, tension, moonboard) */
  boardType: Scalars['String']['output'];
  /** Number of listed climbs for this layout */
  climbCount: Scalars['Int']['output'];
  /** Pre-formatted display name for UI (e.g. 'OG 12x12 Full Ride') */
  displayName: Scalars['String']['output'];
  /** Layout ID */
  layoutId: Scalars['Int']['output'];
  /** Human-readable layout name */
  layoutName?: Maybe<Scalars['String']['output']>;
  /** Set IDs for this configuration */
  setIds: Array<Scalars['Int']['output']>;
  /** Human-readable set names */
  setNames: Array<Scalars['String']['output']>;
  /** Human-readable size description */
  sizeDescription?: Maybe<Scalars['String']['output']>;
  /** Size ID */
  sizeId: Scalars['Int']['output'];
  /** Human-readable size name */
  sizeName?: Maybe<Scalars['String']['output']>;
  /** Total sends across all climbs and angles */
  totalAscents: Scalars['Int']['output'];
};

/** Paginated list of popular board configurations. */
export type PopularBoardConfigConnection = {
  __typename?: 'PopularBoardConfigConnection';
  /** List of configurations */
  configs: Array<PopularBoardConfig>;
  /** Whether more configurations are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of configurations */
  totalCount: Scalars['Int']['output'];
};

/** Input for querying popular board configurations. */
export type PopularBoardConfigsInput = {
  /** Filter by board type */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Max results to return (default 12) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Offset for pagination (default 0) */
  offset?: InputMaybe<Scalars['Int']['input']>;
};

/** Aggregated profile statistics across all boards. */
export type ProfileStats = {
  __typename?: 'ProfileStats';
  /** Per-layout statistics */
  layoutStats: Array<LayoutStats>;
  /** Total distinct climbs sent across all boards */
  totalDistinctClimbs: Scalars['Int']['output'];
};

/** A community proposal for changing a climb's grade, classic status, or benchmark status. */
export type Proposal = {
  __typename?: 'Proposal';
  angle?: Maybe<Scalars['Int']['output']>;
  boardType: Scalars['String']['output'];
  climbAscensionistCount?: Maybe<Scalars['Int']['output']>;
  climbBenchmarkDifficulty?: Maybe<Scalars['String']['output']>;
  climbDifficulty?: Maybe<Scalars['String']['output']>;
  climbDifficultyError?: Maybe<Scalars['String']['output']>;
  /** Whether matching is disallowed on this climb */
  climbIsNoMatch?: Maybe<Scalars['Boolean']['output']>;
  climbName?: Maybe<Scalars['String']['output']>;
  climbQualityAverage?: Maybe<Scalars['String']['output']>;
  climbSetterUsername?: Maybe<Scalars['String']['output']>;
  climbUuid: Scalars['String']['output'];
  createdAt: Scalars['String']['output'];
  currentValue: Scalars['String']['output'];
  frames?: Maybe<Scalars['String']['output']>;
  layoutId?: Maybe<Scalars['Int']['output']>;
  proposedValue: Scalars['String']['output'];
  proposerAvatarUrl?: Maybe<Scalars['String']['output']>;
  proposerDisplayName?: Maybe<Scalars['String']['output']>;
  proposerId: Scalars['ID']['output'];
  reason?: Maybe<Scalars['String']['output']>;
  requiredUpvotes: Scalars['Int']['output'];
  resolvedAt?: Maybe<Scalars['String']['output']>;
  resolvedBy?: Maybe<Scalars['String']['output']>;
  status: ProposalStatus;
  type: ProposalType;
  userVote: Scalars['Int']['output'];
  uuid: Scalars['ID']['output'];
  weightedDownvotes: Scalars['Int']['output'];
  weightedUpvotes: Scalars['Int']['output'];
};

/** Paginated list of proposals. */
export type ProposalConnection = {
  __typename?: 'ProposalConnection';
  hasMore: Scalars['Boolean']['output'];
  proposals: Array<Proposal>;
  totalCount: Scalars['Int']['output'];
};

export type ProposalStatus = 'approved' | 'open' | 'rejected' | 'superseded';

export type ProposalType = 'benchmark' | 'classic' | 'grade';

/** Vote tally for a proposal. */
export type ProposalVoteSummary = {
  __typename?: 'ProposalVoteSummary';
  isApproved: Scalars['Boolean']['output'];
  requiredUpvotes: Scalars['Int']['output'];
  weightedDownvotes: Scalars['Int']['output'];
  weightedUpvotes: Scalars['Int']['output'];
};

/** Public-facing user profile for social features. */
export type PublicUserProfile = {
  __typename?: 'PublicUserProfile';
  /** Avatar URL */
  avatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name */
  displayName?: Maybe<Scalars['String']['output']>;
  /** Number of followers */
  followerCount: Scalars['Int']['output'];
  /** Number of users being followed */
  followingCount: Scalars['Int']['output'];
  /** User ID */
  id: Scalars['ID']['output'];
  /** Whether the current user follows this user */
  isFollowedByMe: Scalars['Boolean']['output'];
};

/** Root query type for all read operations. */
export type Query = {
  __typename?: 'Query';
  /**
   * Get materialized activity feed for the authenticated user.
   * Requires authentication.
   */
  activityFeed: ActivityFeedResult;
  /**
   * Get all current user's playlists across boards/layouts, paginated.
   * Optional boardType/layoutId filter. Requires authentication.
   */
  allUserPlaylists: AllUserPlaylistsResult;
  /** Get available angles for a board layout. */
  angles: Array<Angle>;
  /**
   * Get Aurora credential for a specific board type.
   * Includes token if available. Requires authentication.
   */
  auroraCredential?: Maybe<AuroraCredential>;
  /**
   * Get status of all stored Aurora credentials.
   * Requires authentication.
   */
  auroraCredentials: Array<AuroraCredentialStatus>;
  /**
   * Get external (Instagram, TikTok) beta links for a climb.
   * Live-checks each post and omits any that have been deleted or made private.
   * Caches thumbnails to our S3 bucket on first read.
   */
  betaLinks: Array<BetaLink>;
  /** Get a board by UUID. */
  board?: Maybe<UserBoard>;
  /** Get a board by slug (for URL routing). */
  boardBySlug?: Maybe<UserBoard>;
  /** Get leaderboard for a board. */
  boardLeaderboard: BoardLeaderboard;
  /**
   * Look up boards by controller serial numbers.
   * Searches all boards (including unlisted/non-public).
   * Capped at 20 serials per request — exceeding this throws a validation
   * error rather than silently truncating, so callers must cap on their end.
   */
  boardsBySerialNumbers: Array<UserBoard>;
  /** Browse proposals across all climbs with filters. */
  browseProposals: ProposalConnection;
  /** Get community status for multiple climbs (batch). */
  bulkClimbCommunityStatus: Array<ClimbCommunityStatus>;
  /** Get vote summaries for multiple entities of the same type. */
  bulkVoteSummaries: Array<VoteSummary>;
  /**
   * Check whether MoonBoard climbs with exact hold-role selections already exist.
   * Returns one result per submitted candidate.
   */
  checkMoonBoardClimbDuplicates: Array<MoonBoardClimbDuplicateMatch>;
  /** Get a single climb by its UUID. */
  climb?: Maybe<Climb>;
  /** Get classic status for a climb (angle-independent). */
  climbClassicStatus: ClimbClassicStatus;
  /** Get community status for a specific climb at an angle. */
  climbCommunityStatus: ClimbCommunityStatus;
  /** Get proposals for a specific climb. */
  climbProposals: ProposalConnection;
  /**
   * Get climb stats history for a climb over the last 12 months.
   * Returns snapshots captured during shared sync for trend analysis.
   */
  climbStatsHistory: Array<ClimbStatsHistoryEntry>;
  /** Get comments for an entity. */
  comments: CommentConnection;
  /** Get all community role assignments. */
  communityRoles: Array<CommunityRoleAssignment>;
  /** Get community settings for a scope. */
  communitySettings: Array<CommunitySetting>;
  /**
   * Get the user's default board (first owned, then most used).
   * Requires authentication.
   */
  defaultBoard?: Maybe<UserBoard>;
  /**
   * Get info needed before account deletion (published climb count).
   * Requires authentication.
   */
  deleteAccountInfo: DeleteAccountInfo;
  /** Discover public playlists with at least 1 climb. */
  discoverPlaylists: DiscoverPlaylistsResult;
  /**
   * Get buffered events since a sequence number for delta sync.
   * Used to catch up after reconnection without full state transfer.
   */
  eventsReplay: EventsReplayResponse;
  /**
   * Check which climbs from a list are favorited by the current user.
   * Returns array of favorited climb UUIDs.
   */
  favorites: Array<Scalars['String']['output']>;
  /** Get followers of a user. */
  followers: FollowConnection;
  /** Get users that a user is following. */
  following: FollowConnection;
  /**
   * Get activity feed of ascents from followed users.
   * Requires authentication.
   * Deprecated: Use activityFeed instead.
   * @deprecated Use activityFeed query instead
   */
  followingAscentsFeed: FollowingAscentsFeedResult;
  /**
   * Get ticks from followed users for a specific climb.
   * Requires authentication.
   */
  followingClimbAscents: FollowingClimbAscentsResult;
  /**
   * Get global activity feed of all recent ascents.
   * No authentication required.
   * Deprecated: Use trendingFeed instead.
   * @deprecated Use trendingFeed query instead
   */
  globalAscentsFeed: FollowingAscentsFeedResult;
  /**
   * Get a global feed of recent comments across all entities.
   * Supports board filtering. Always chronological (newest first).
   */
  globalCommentFeed: CommentConnection;
  /** Get all difficulty grades for a board type. */
  grades: Array<Grade>;
  /**
   * Get grouped notifications for the current user.
   * Groups notifications by (type, entity_type, entity_id).
   */
  groupedNotifications: GroupedNotificationConnection;
  /** Get a gym by UUID. */
  gym?: Maybe<Gym>;
  /** Get a gym by slug (for URL routing). */
  gymBySlug?: Maybe<Gym>;
  /** Get members of a gym. */
  gymMembers: GymMemberConnection;
  /**
   * Check if the current user follows a specific user.
   * Requires authentication.
   */
  isFollowing: Scalars['Boolean']['output'];
  /**
   * Recorded board configurations for the current user keyed by controller serial.
   * Used as a fallback when boardsBySerialNumbers returns nothing for a serial,
   * and to detect connect-time config mismatches. Requires authentication.
   */
  myBoardSerialConfigs: Array<BoardSerialConfig>;
  /**
   * Get current user's boards.
   * Requires authentication.
   */
  myBoards: UserBoardConnection;
  myControllers: Array<ControllerInfo>;
  /**
   * Get current user's gyms (owned + optionally followed).
   * Requires authentication.
   */
  myGyms: GymConnection;
  /**
   * Get the current user's new climb subscriptions.
   * Requires authentication.
   */
  myNewClimbSubscriptions: Array<NewClimbSubscription>;
  /**
   * Get the authenticated user's pinned playlists, ordered by most recently pinned.
   * Capped server-side (small grid surface). Requires authentication.
   */
  myPinnedPlaylists: Array<Playlist>;
  /** Get the current user's community roles. */
  myRoles: Array<CommunityRoleAssignment>;
  /**
   * Get current user's recently joined sessions.
   * Requires authentication.
   */
  mySessions: Array<DiscoverableSession>;
  /**
   * Get climb counts for the current user's smart playlists.
   * Used to render the smart-playlist cards on the library page.
   * Requires authentication.
   */
  mySmartPlaylistCounts: Array<SmartPlaylistCount>;
  /**
   * Find discoverable sessions near a GPS location.
   * Default radius is 1000 meters.
   */
  nearbySessions: Array<DiscoverableSession>;
  /** Get a feed of newly created climbs for a board type and layout. */
  newClimbFeed: NewClimbFeedResult;
  /** Get notifications for the current user. */
  notifications: NotificationConnection;
  /**
   * Get a specific playlist by ID.
   * Checks ownership/access permissions.
   */
  playlist?: Maybe<Playlist>;
  /** Get climbs in a playlist with full climb data. */
  playlistClimbs: PlaylistClimbsResult;
  /** Get playlist creators for autocomplete suggestions. */
  playlistCreators: Array<PlaylistCreator>;
  /** Get IDs of playlists that contain a specific climb. */
  playlistsForClimb: Array<Scalars['ID']['output']>;
  /** Get playlist memberships for multiple climbs in a single request. */
  playlistsForClimbs: Array<ClimbPlaylistMembership>;
  /** Get popular board configurations ranked by climb count. */
  popularBoardConfigs: PopularBoardConfigConnection;
  /**
   * Get the currently authenticated user's profile.
   * Returns null if not authenticated.
   */
  profile?: Maybe<UserProfile>;
  /** Get a public user profile by ID. */
  publicProfile?: Maybe<PublicUserProfile>;
  /**
   * Most recent beta videos across all climbs. Returns only rows whose
   * thumbnails are already cached in our S3; no live IG/TikTok enrichment.
   */
  recentBetaLinks: Array<RecentBetaLink>;
  /** Search public boards. */
  searchBoards: UserBoardConnection;
  /**
   * Search climbs with filtering, sorting, and pagination.
   * Supports filtering by difficulty, setter, holds, and more.
   */
  searchClimbs: ClimbSearchResult;
  /** Search public gyms. */
  searchGyms: GymConnection;
  /** Search public playlists globally by name. */
  searchPlaylists: SearchPlaylistsResult;
  /** Search for users by name or email. */
  searchUsers: UserSearchConnection;
  /**
   * Search for users and setters by name.
   * Returns unified results with both Boardsesh users and climb setters.
   */
  searchUsersAndSetters: UnifiedSearchConnection;
  /**
   * Get details of a specific session by ID.
   * Returns null if session doesn't exist.
   */
  session?: Maybe<Session>;
  /** Get full detail for a single session (party mode or inferred). */
  sessionDetail?: Maybe<SessionDetail>;
  /**
   * Get session-grouped activity feed (public, no auth required).
   * Groups ticks into sessions (party mode or inferred by 4-hour gap).
   */
  sessionGroupedFeed: SessionFeedResult;
  /**
   * Get a session summary (stats, grade distribution, participants).
   * Available for ended sessions or active sessions with ticks.
   */
  sessionSummary?: Maybe<SessionSummary>;
  /** Get climbs created by a setter. */
  setterClimbs: SetterClimbsConnection;
  /**
   * Get climbs created by a setter with full Climb data (for thumbnails).
   * Supports multi-board mode when boardType is omitted.
   */
  setterClimbsFull: PlaylistClimbsResult;
  /** Get a setter profile by username. */
  setterProfile?: Maybe<SetterProfile>;
  /**
   * Setter usernames with climb counts for the given board, optionally filtered by username substring.
   * Powers the setter filter autocomplete.
   */
  setterStats: Array<SetterStat>;
  /**
   * Find climbs on the same board+layout with at least `threshold` Jaccard
   * similarity over hold positions (hold_id only, state-agnostic). Used by:
   * - The playview drawer's "Similar climbs" section at threshold 0.5 —
   *   empirically the floor where matches feel related rather than
   *   coincidentally co-located on the wall.
   * - The create-climb duplicate UX at threshold 1.0, which filters to
   *   true position-exact matches.
   * The duplicate-publish gate uses state-aware (hold_id, hold_state)
   * matching separately — see findExactDuplicateMatch.
   */
  similarClimbs: Array<SimilarClimb>;
  /**
   * Get a smart (computed) playlist for a user — five-stars, most-repeated, or projects.
   * Public — no authentication required.
   */
  smartPlaylist: SmartPlaylistResult;
  /** Pull board climb stats for a board type, changed since the cursor (reference data). */
  syncClimbStats: SyncResult;
  /** Pull board climbs for a board type, changed since the cursor (reference data). */
  syncClimbs: SyncResult;
  /** Pull hard deletions (user-scoped + reference data) since the cursor. */
  syncDeletions: SyncDeletionsResult;
  /** Pull the authenticated user's favorites changed since the cursor. */
  syncFavorites: SyncResult;
  /** Pull playlist-climb rows for the user's owned playlists, changed since the cursor. */
  syncPlaylistClimbs: SyncResult;
  /** Pull the authenticated user's playlist-follows changed since the cursor. */
  syncPlaylistFollows: SyncResult;
  /** Pull the authenticated user's owned playlists changed since the cursor. */
  syncPlaylists: SyncResult;
  /** Pull the authenticated user's setter-follows changed since the cursor. */
  syncSetterFollows: SyncResult;
  /** Pull the authenticated user's ticks changed since the cursor. */
  syncTicks: SyncResult;
  /** Pull the authenticated user's user-follows changed since the cursor. */
  syncUserFollows: SyncResult;
  /**
   * Get current user's ticks (recorded climb attempts).
   * Requires authentication.
   */
  ticks: Array<Tick>;
  /** Get trending feed of recent activity (public, no auth required). */
  trendingFeed: ActivityFeedResult;
  /** Get unread notification count for the current user. */
  unreadNotificationCount: Scalars['Int']['output'];
  /**
   * Get board names where the current user has playlists or favorites.
   * Requires authentication.
   */
  userActiveBoards: Array<Scalars['String']['output']>;
  /**
   * Get public ascent activity feed for a user.
   * Includes enriched climb data for display.
   */
  userAscentsFeed: AscentFeedResult;
  /**
   * Beta videos contributed by a specific Boardsesh user, ordered
   * most-recent-first. Matches both videos this user added directly and
   * videos posted under the Instagram handle linked from their profile.
   * Returns only rows whose thumbnails are cached in our S3.
   */
  userBetaLinks: Array<RecentBetaLink>;
  /** Get a user's percentile ranking based on distinct climbs ascended. */
  userClimbPercentile: UserClimbPercentile;
  /**
   * Get all non-draft climbs created by a user.
   * Includes both directly created climbs and Aurora-imported climbs linked via board credentials.
   */
  userClimbs: PlaylistClimbsResult;
  /**
   * Get user's favorite climbs with full climb data.
   * Requires authentication.
   */
  userFavoriteClimbs: PlaylistClimbsResult;
  /**
   * Get count of favorited climbs per board for the current user.
   * Requires authentication.
   */
  userFavoritesCounts: Array<FavoritesCount>;
  /**
   * Get public ascent feed grouped by climb and day.
   * Useful for summary displays.
   */
  userGroupedAscentsFeed: GroupedAscentFeedResult;
  /**
   * Get current user's playlists for a board+layout.
   * Requires authentication.
   */
  userPlaylists: Array<Playlist>;
  /** Get profile statistics with distinct climb counts per grade. */
  userProfileStats: ProfileStats;
  /** Get public ticks for any user by their ID. */
  userTicks: Array<Tick>;
  /** Get vote summary for a single entity. */
  voteSummary: VoteSummary;
};

/** Root query type for all read operations. */
export type QueryActivityFeedArgs = {
  input?: InputMaybe<ActivityFeedInput>;
};

/** Root query type for all read operations. */
export type QueryAllUserPlaylistsArgs = {
  input: GetAllUserPlaylistsInput;
};

/** Root query type for all read operations. */
export type QueryAnglesArgs = {
  boardName: Scalars['String']['input'];
  layoutId: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QueryAuroraCredentialArgs = {
  boardType: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryBetaLinksArgs = {
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryBoardArgs = {
  boardUuid: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryBoardBySlugArgs = {
  slug: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryBoardLeaderboardArgs = {
  input: BoardLeaderboardInput;
};

/** Root query type for all read operations. */
export type QueryBoardsBySerialNumbersArgs = {
  serialNumbers: Array<Scalars['String']['input']>;
};

/** Root query type for all read operations. */
export type QueryBrowseProposalsArgs = {
  input: BrowseProposalsInput;
};

/** Root query type for all read operations. */
export type QueryBulkClimbCommunityStatusArgs = {
  angle: Scalars['Int']['input'];
  boardType: Scalars['String']['input'];
  climbUuids: Array<Scalars['String']['input']>;
};

/** Root query type for all read operations. */
export type QueryBulkVoteSummariesArgs = {
  input: BulkVoteSummaryInput;
};

/** Root query type for all read operations. */
export type QueryCheckMoonBoardClimbDuplicatesArgs = {
  input: CheckMoonBoardClimbDuplicatesInput;
};

/** Root query type for all read operations. */
export type QueryClimbArgs = {
  angle: Scalars['Int']['input'];
  boardName: Scalars['String']['input'];
  climbUuid: Scalars['ID']['input'];
  layoutId: Scalars['Int']['input'];
  setIds: Scalars['String']['input'];
  sizeId: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QueryClimbClassicStatusArgs = {
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryClimbCommunityStatusArgs = {
  angle: Scalars['Int']['input'];
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryClimbProposalsArgs = {
  input: GetClimbProposalsInput;
};

/** Root query type for all read operations. */
export type QueryClimbStatsHistoryArgs = {
  boardName: Scalars['String']['input'];
  climbUuid: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryCommentsArgs = {
  input: CommentsInput;
};

/** Root query type for all read operations. */
export type QueryCommunityRolesArgs = {
  boardType?: InputMaybe<Scalars['String']['input']>;
};

/** Root query type for all read operations. */
export type QueryCommunitySettingsArgs = {
  scope: Scalars['String']['input'];
  scopeKey: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryDiscoverPlaylistsArgs = {
  input: DiscoverPlaylistsInput;
};

/** Root query type for all read operations. */
export type QueryEventsReplayArgs = {
  sessionId: Scalars['ID']['input'];
  sinceSequence: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QueryFavoritesArgs = {
  angle: Scalars['Int']['input'];
  boardName: Scalars['String']['input'];
  climbUuids: Array<Scalars['String']['input']>;
};

/** Root query type for all read operations. */
export type QueryFollowersArgs = {
  input: FollowListInput;
};

/** Root query type for all read operations. */
export type QueryFollowingArgs = {
  input: FollowListInput;
};

/** Root query type for all read operations. */
export type QueryFollowingAscentsFeedArgs = {
  input?: InputMaybe<FollowingAscentsFeedInput>;
};

/** Root query type for all read operations. */
export type QueryFollowingClimbAscentsArgs = {
  input: FollowingClimbAscentsInput;
};

/** Root query type for all read operations. */
export type QueryGlobalAscentsFeedArgs = {
  input?: InputMaybe<FollowingAscentsFeedInput>;
};

/** Root query type for all read operations. */
export type QueryGlobalCommentFeedArgs = {
  input?: InputMaybe<GlobalCommentFeedInput>;
};

/** Root query type for all read operations. */
export type QueryGradesArgs = {
  boardName: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryGroupedNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};

/** Root query type for all read operations. */
export type QueryGymArgs = {
  gymUuid: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryGymBySlugArgs = {
  slug: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryGymMembersArgs = {
  input: GymMembersInput;
};

/** Root query type for all read operations. */
export type QueryIsFollowingArgs = {
  userId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryMyBoardSerialConfigsArgs = {
  serialNumbers: Array<Scalars['String']['input']>;
};

/** Root query type for all read operations. */
export type QueryMyBoardsArgs = {
  input?: InputMaybe<MyBoardsInput>;
};

/** Root query type for all read operations. */
export type QueryMyGymsArgs = {
  input?: InputMaybe<MyGymsInput>;
};

/** Root query type for all read operations. */
export type QueryMyPinnedPlaylistsArgs = {
  input: GetMyPinnedPlaylistsInput;
};

/** Root query type for all read operations. */
export type QueryNearbySessionsArgs = {
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
  radiusMeters?: InputMaybe<Scalars['Float']['input']>;
};

/** Root query type for all read operations. */
export type QueryNewClimbFeedArgs = {
  input: NewClimbFeedInput;
};

/** Root query type for all read operations. */
export type QueryNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  unreadOnly?: InputMaybe<Scalars['Boolean']['input']>;
};

/** Root query type for all read operations. */
export type QueryPlaylistArgs = {
  playlistId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryPlaylistClimbsArgs = {
  input: GetPlaylistClimbsInput;
};

/** Root query type for all read operations. */
export type QueryPlaylistCreatorsArgs = {
  input: GetPlaylistCreatorsInput;
};

/** Root query type for all read operations. */
export type QueryPlaylistsForClimbArgs = {
  input: GetPlaylistsForClimbInput;
};

/** Root query type for all read operations. */
export type QueryPlaylistsForClimbsArgs = {
  input: GetPlaylistsForClimbsInput;
};

/** Root query type for all read operations. */
export type QueryPopularBoardConfigsArgs = {
  input?: InputMaybe<PopularBoardConfigsInput>;
};

/** Root query type for all read operations. */
export type QueryPublicProfileArgs = {
  userId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryRecentBetaLinksArgs = {
  boardType?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
};

/** Root query type for all read operations. */
export type QuerySearchBoardsArgs = {
  input: SearchBoardsInput;
};

/** Root query type for all read operations. */
export type QuerySearchClimbsArgs = {
  input: ClimbSearchInput;
};

/** Root query type for all read operations. */
export type QuerySearchGymsArgs = {
  input: SearchGymsInput;
};

/** Root query type for all read operations. */
export type QuerySearchPlaylistsArgs = {
  input: SearchPlaylistsInput;
};

/** Root query type for all read operations. */
export type QuerySearchUsersArgs = {
  input: SearchUsersInput;
};

/** Root query type for all read operations. */
export type QuerySearchUsersAndSettersArgs = {
  input: SearchUsersInput;
};

/** Root query type for all read operations. */
export type QuerySessionArgs = {
  sessionId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QuerySessionDetailArgs = {
  sessionId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QuerySessionGroupedFeedArgs = {
  input?: InputMaybe<ActivityFeedInput>;
};

/** Root query type for all read operations. */
export type QuerySessionSummaryArgs = {
  sessionId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QuerySetterClimbsArgs = {
  input: SetterClimbsInput;
};

/** Root query type for all read operations. */
export type QuerySetterClimbsFullArgs = {
  input: SetterClimbsFullInput;
};

/** Root query type for all read operations. */
export type QuerySetterProfileArgs = {
  input: SetterProfileInput;
};

/** Root query type for all read operations. */
export type QuerySetterStatsArgs = {
  input: SetterStatsInput;
};

/** Root query type for all read operations. */
export type QuerySimilarClimbsArgs = {
  input: SimilarClimbsInput;
};

/** Root query type for all read operations. */
export type QuerySmartPlaylistArgs = {
  input: GetSmartPlaylistInput;
};

/** Root query type for all read operations. */
export type QuerySyncClimbStatsArgs = {
  boardType: Scalars['String']['input'];
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncClimbsArgs = {
  boardType: Scalars['String']['input'];
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncDeletionsArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncFavoritesArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncPlaylistClimbsArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncPlaylistFollowsArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncPlaylistsArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncSetterFollowsArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncTicksArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QuerySyncUserFollowsArgs = {
  cursor?: InputMaybe<SyncCursorInput>;
  limit?: Scalars['Int']['input'];
};

/** Root query type for all read operations. */
export type QueryTicksArgs = {
  input: GetTicksInput;
};

/** Root query type for all read operations. */
export type QueryTrendingFeedArgs = {
  input?: InputMaybe<ActivityFeedInput>;
};

/** Root query type for all read operations. */
export type QueryUserAscentsFeedArgs = {
  input?: InputMaybe<AscentFeedInput>;
  userId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryUserBetaLinksArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  userId: Scalars['String']['input'];
};

/** Root query type for all read operations. */
export type QueryUserClimbPercentileArgs = {
  userId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryUserClimbsArgs = {
  input: UserClimbsInput;
};

/** Root query type for all read operations. */
export type QueryUserFavoriteClimbsArgs = {
  input: GetUserFavoriteClimbsInput;
};

/** Root query type for all read operations. */
export type QueryUserGroupedAscentsFeedArgs = {
  input?: InputMaybe<AscentFeedInput>;
  userId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryUserPlaylistsArgs = {
  input: GetUserPlaylistsInput;
};

/** Root query type for all read operations. */
export type QueryUserProfileStatsArgs = {
  userId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryUserTicksArgs = {
  boardType: Scalars['String']['input'];
  userId: Scalars['ID']['input'];
};

/** Root query type for all read operations. */
export type QueryVoteSummaryArgs = {
  entityId: Scalars['String']['input'];
  entityType: SocialEntityType;
};

/** Union of possible queue events. */
export type QueueEvent =
  | ClimbMirrored
  | CurrentClimbChanged
  | FullSync
  | QueueItemAdded
  | QueueItemRemoved
  | QueueReordered;

/** Event when an item is added to the queue. */
export type QueueItemAdded = {
  __typename?: 'QueueItemAdded';
  /** The added item */
  item: ClimbQueueItem;
  /** Position where item was inserted (null = end) */
  position?: Maybe<Scalars['Int']['output']>;
  /** Sequence number of this event */
  sequence: Scalars['Int']['output'];
  /** Queue state hash after this event is applied */
  stateHash: Scalars['String']['output'];
};

/** Event when an item is removed from the queue. */
export type QueueItemRemoved = {
  __typename?: 'QueueItemRemoved';
  /** Sequence number of this event */
  sequence: Scalars['Int']['output'];
  /** Queue state hash after this event is applied */
  stateHash: Scalars['String']['output'];
  /** UUID of the removed item */
  uuid: Scalars['ID']['output'];
};

/** User information displayed in queue items. */
export type QueueItemUser = {
  __typename?: 'QueueItemUser';
  /** URL to user's avatar image */
  avatarUrl?: Maybe<Scalars['String']['output']>;
  /** Unique user identifier */
  id: Scalars['ID']['output'];
  /** Display name shown in the queue */
  username: Scalars['String']['output'];
};

/** Input type for queue item user information. */
export type QueueItemUserInput = {
  avatarUrl?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  username: Scalars['String']['input'];
};

export type QueueNavigationContext = {
  __typename?: 'QueueNavigationContext';
  /** Current position in queue (0-indexed) */
  currentIndex: Scalars['Int']['output'];
  /** Next climb in queue (null if at end) */
  nextClimb?: Maybe<QueueNavigationItem>;
  /** Previous climbs in queue (up to 3, most recent first) */
  previousClimbs: Array<QueueNavigationItem>;
  /** Total number of items in queue */
  totalCount: Scalars['Int']['output'];
};

export type QueueNavigationItem = {
  __typename?: 'QueueNavigationItem';
  grade: Scalars['String']['output'];
  gradeColor: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

/** Event when queue order changes. */
export type QueueReordered = {
  __typename?: 'QueueReordered';
  /** New position */
  newIndex: Scalars['Int']['output'];
  /** Previous position */
  oldIndex: Scalars['Int']['output'];
  /** Sequence number of this event */
  sequence: Scalars['Int']['output'];
  /** Queue state hash after this event is applied */
  stateHash: Scalars['String']['output'];
  /** UUID of the moved item */
  uuid: Scalars['ID']['output'];
};

/**
 * The complete state of a session's climb queue.
 * Used for synchronization between clients.
 */
export type QueueState = {
  __typename?: 'QueueState';
  /** The climb currently being attempted */
  currentClimbQueueItem?: Maybe<ClimbQueueItem>;
  /** List of climbs in the queue */
  queue: Array<ClimbQueueItem>;
  /** Monotonically increasing sequence number for ordering events */
  sequence: Scalars['Int']['output'];
  /** Hash of the current state for consistency checking */
  stateHash: Scalars['String']['output'];
};

/**
 * A recent beta link enriched with the parent climb's display name. Used
 * by the home-page slider where multiple climbs are aggregated together.
 */
export type RecentBetaLink = {
  __typename?: 'RecentBetaLink';
  betaLink: BetaLink;
  boardType: Scalars['String']['output'];
  climbName?: Maybe<Scalars['String']['output']>;
  layoutId?: Maybe<Scalars['Int']['output']>;
};

export type RegisterControllerInput = {
  boardName: Scalars['String']['input'];
  layoutId: Scalars['Int']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  setIds: Scalars['String']['input'];
  sizeId: Scalars['Int']['input'];
};

/** Input for removing a climb from a playlist. */
export type RemoveClimbFromPlaylistInput = {
  /** Climb UUID to remove */
  climbUuid: Scalars['String']['input'];
  /** Playlist ID */
  playlistId: Scalars['ID']['input'];
};

/** Input for removing a climb from favorites (idempotent, sync-safe). */
export type RemoveFavoriteInput = {
  /** Board angle */
  angle: Scalars['Int']['input'];
  /** Board type */
  boardName: Scalars['String']['input'];
  /** Climb UUID to unfavorite */
  climbUuid: Scalars['String']['input'];
};

/** Input for removing a member from a gym. */
export type RemoveGymMemberInput = {
  /** Gym UUID */
  gymUuid: Scalars['ID']['input'];
  /** User ID to remove */
  userId: Scalars['ID']['input'];
};

/** Input for removing a user from an inferred session. */
export type RemoveUserFromSessionInput = {
  /** ID of the inferred session */
  sessionId: Scalars['ID']['input'];
  /** User ID to remove */
  userId: Scalars['ID']['input'];
};

export type ResolveProposalInput = {
  proposalUuid: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  status: ProposalStatus;
};

export type RevokeRoleInput = {
  boardType?: InputMaybe<Scalars['String']['input']>;
  role: CommunityRoleType;
  userId: Scalars['ID']['input'];
};

/** Input for saving Aurora board credentials. */
export type SaveAuroraCredentialInput = {
  /** Board type ('kilter' or 'tension') */
  boardType: Scalars['String']['input'];
  /** Aurora account password */
  password: Scalars['String']['input'];
  /** Aurora account username */
  username: Scalars['String']['input'];
};

export type SaveClimbInput = {
  angle: Scalars['Int']['input'];
  boardType: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  frames: Scalars['String']['input'];
  framesCount?: InputMaybe<Scalars['Int']['input']>;
  framesPace?: InputMaybe<Scalars['Int']['input']>;
  isDraft: Scalars['Boolean']['input'];
  layoutId: Scalars['Int']['input'];
  name: Scalars['String']['input'];
};

export type SaveClimbResult = {
  __typename?: 'SaveClimbResult';
  /** ISO timestamp of when the row was created */
  createdAt?: Maybe<Scalars['String']['output']>;
  /** ISO timestamp of when the row was first published (null while still a draft) */
  publishedAt?: Maybe<Scalars['String']['output']>;
  synced: Scalars['Boolean']['output'];
  uuid: Scalars['ID']['output'];
};

export type SaveMoonBoardClimbInput = {
  angle: Scalars['Int']['input'];
  boardType: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  holds: MoonBoardHoldsInput;
  isBenchmark?: InputMaybe<Scalars['Boolean']['input']>;
  isDraft?: InputMaybe<Scalars['Boolean']['input']>;
  layoutId: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  setter?: InputMaybe<Scalars['String']['input']>;
  userGrade?: InputMaybe<Scalars['String']['input']>;
};

/** Input for recording a climb attempt. */
export type SaveTickInput = {
  /** Board angle */
  angle: Scalars['Int']['input'];
  /** Number of attempts */
  attemptCount: Scalars['Int']['input'];
  /** Board type */
  boardType: Scalars['String']['input'];
  /** Climb UUID */
  climbUuid: Scalars['String']['input'];
  /** When the climb was attempted (ISO 8601) */
  climbedAt: Scalars['String']['input'];
  /** Comment about the climb */
  comment: Scalars['String']['input'];
  /** Difficulty rating */
  difficulty?: InputMaybe<Scalars['Int']['input']>;
  /** Whether this is a benchmark climb */
  isBenchmark: Scalars['Boolean']['input'];
  /** Whether climb was mirrored */
  isMirror: Scalars['Boolean']['input'];
  /** Layout ID for board resolution */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** Quality rating (1-5) */
  quality?: InputMaybe<Scalars['Int']['input']>;
  /** Session ID if in a session */
  sessionId?: InputMaybe<Scalars['String']['input']>;
  /** Set IDs for board resolution */
  setIds?: InputMaybe<Scalars['String']['input']>;
  /** Size ID for board resolution */
  sizeId?: InputMaybe<Scalars['Int']['input']>;
  /** Result of the attempt */
  status: TickStatus;
  /** Optional client-supplied UUID for idempotent offline replay (ON CONFLICT (uuid) DO NOTHING). When omitted, the server generates one. */
  uuid?: InputMaybe<Scalars['ID']['input']>;
  /** Optional Instagram post or reel URL to attach as beta for the climb */
  videoUrl?: InputMaybe<Scalars['String']['input']>;
};

/** Input for searching boards. */
export type SearchBoardsInput = {
  /** Filter by board type */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Latitude for proximity search */
  latitude?: InputMaybe<Scalars['Float']['input']>;
  /** Max results to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Longitude for proximity search */
  longitude?: InputMaybe<Scalars['Float']['input']>;
  /** Offset for pagination */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Search query */
  query?: InputMaybe<Scalars['String']['input']>;
  /** Radius in km for proximity search (default 50) */
  radiusKm?: InputMaybe<Scalars['Float']['input']>;
};

/** Input for searching gyms. */
export type SearchGymsInput = {
  /** Latitude for proximity search */
  latitude?: InputMaybe<Scalars['Float']['input']>;
  /** Max results to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Longitude for proximity search */
  longitude?: InputMaybe<Scalars['Float']['input']>;
  /** Offset for pagination */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Search query */
  query?: InputMaybe<Scalars['String']['input']>;
  /** Radius in km for proximity search (default 50) */
  radiusKm?: InputMaybe<Scalars['Float']['input']>;
};

/** Input for searching playlists globally. */
export type SearchPlaylistsInput = {
  /** Optional board type filter */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Max results to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Offset for pagination */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Search query */
  query: Scalars['String']['input'];
};

/** Result of global playlist search. */
export type SearchPlaylistsResult = {
  __typename?: 'SearchPlaylistsResult';
  /** Whether more are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of playlists */
  playlists: Array<DiscoverablePlaylist>;
  /** Total count */
  totalCount: Scalars['Int']['output'];
};

/** Input for searching users. */
export type SearchUsersInput = {
  /** Optional board type filter */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Maximum number of results */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of results to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Search query (min 2 characters) */
  query: Scalars['String']['input'];
};

export type SendDeviceLogsInput = {
  logs: Array<DeviceLogEntry>;
};

export type SendDeviceLogsResponse = {
  __typename?: 'SendDeviceLogsResponse';
  accepted: Scalars['Int']['output'];
  success: Scalars['Boolean']['output'];
};

/** An active climbing session where users can collaborate on a queue. */
export type Session = {
  __typename?: 'Session';
  /** Board configuration path (board_name/layout_id/size_id/set_ids/angle) */
  boardPath: Scalars['String']['output'];
  /** Unique identifier for this client's connection */
  clientId: Scalars['ID']['output'];
  /** Hex color for multi-session display */
  color?: Maybe<Scalars['String']['output']>;
  /** Stable participant id of the user currently driving the wall. Set via takeControl, cleared via releaseControl or driver disconnect. Distinct from isLeader, which is presentation/legacy only. */
  driverParticipantId?: Maybe<Scalars['ID']['output']>;
  /** When the session was ended (ISO 8601) */
  endedAt?: Maybe<Scalars['String']['output']>;
  /** Optional session goal text */
  goal?: Maybe<Scalars['String']['output']>;
  /** Unique session identifier */
  id: Scalars['ID']['output'];
  /** Whether the current client is the session leader (presentation/backward compatibility only) */
  isLeader: Scalars['Boolean']['output'];
  /** Whether session is exempt from auto-end */
  isPermanent: Scalars['Boolean']['output'];
  /** Whether session is publicly discoverable */
  isPublic: Scalars['Boolean']['output'];
  /** Most recently observed BLE board serial for this session. Set when a participant pairs their phone to a physical board; broadcast as SessionBoardSerialChanged so late-joiners can auto-connect to the same board. Null when no board has been recorded. */
  lastConnectedBoardSerial?: Maybe<Scalars['String']['output']>;
  /** Optional name for the session */
  name?: Maybe<Scalars['String']['output']>;
  /** Backend-resolved participant id for the requesting client. For authenticated users this is the user UUID; for anonymous users it equals clientId. Use this (not the locally generated activeSession.participantId) when comparing against driverParticipantId — the backend always ignores client-supplied participantIds for security and uses this resolved value as the broadcast identity. TEMPORARILY NULLABLE: a follow-up release will flip this back to ID! once every Session-returning resolver has been audited to confirm it populates the field. Clients should treat null as 'unknown — fall back to clientId for self-checks'. */
  participantId?: Maybe<Scalars['ID']['output']>;
  /** Current queue state */
  queueState: QueueState;
  /** When the session was started (ISO 8601) */
  startedAt?: Maybe<Scalars['String']['output']>;
  /** Users currently in the session */
  users: Array<SessionUser>;
};

/**
 * Event when the session's stored boardPath changes — today carries angle
 * changes from any participant's angle selector. Recipients update their
 * local URL (`router.replace`) so all members stay on the same angle
 * view. Skipped when the originating client's own participant id matches
 * `changedByParticipantId` (the optimistic URL push already happened
 * locally). `boardPath` is the full route string (`/<board>/<layout>/<size>/<sets>/<angle>/...`).
 */
export type SessionBoardPathChanged = {
  __typename?: 'SessionBoardPathChanged';
  /** New full boardPath for the session */
  boardPath: Scalars['String']['output'];
  /** Participant id of the member who triggered the change, or null for system-initiated updates */
  changedByParticipantId?: Maybe<Scalars['ID']['output']>;
};

/**
 * Event when the session's last-connected BLE board serial changes.
 * Used by mobile participants to auto-connect to the same board another
 * member is already paired with — saves the chooser step on the second
 * phone joining a session in a gym with multiple physical boards.
 * Null when the board has been forgotten or never recorded.
 */
export type SessionBoardSerialChanged = {
  __typename?: 'SessionBoardSerialChanged';
  /** Most recently observed BLE board serial, or null when cleared/never set */
  lastConnectedBoardSerial?: Maybe<Scalars['String']['output']>;
};

/** Current realtime connection state for a session participant. */
export type SessionConnectionState = 'CONNECTED' | 'RECONNECTING';

/** Full detail for a single session, including all ticks. */
export type SessionDetail = {
  __typename?: 'SessionDetail';
  boardTypes: Array<Scalars['String']['output']>;
  commentCount: Scalars['Int']['output'];
  downvotes: Scalars['Int']['output'];
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  firstTickAt: Scalars['String']['output'];
  goal?: Maybe<Scalars['String']['output']>;
  gradeDistribution: Array<SessionGradeDistributionItem>;
  hardestGrade?: Maybe<Scalars['String']['output']>;
  healthKitWorkoutId?: Maybe<Scalars['String']['output']>;
  lastTickAt: Scalars['String']['output'];
  ownerUserId?: Maybe<Scalars['ID']['output']>;
  participants: Array<SessionFeedParticipant>;
  sessionId: Scalars['ID']['output'];
  sessionName?: Maybe<Scalars['String']['output']>;
  sessionType: Scalars['String']['output'];
  tickCount: Scalars['Int']['output'];
  ticks: Array<SessionDetailTick>;
  totalAttempts: Scalars['Int']['output'];
  totalFlashes: Scalars['Int']['output'];
  totalSends: Scalars['Int']['output'];
  upvotes: Scalars['Int']['output'];
  voteScore: Scalars['Int']['output'];
};

/** An individual tick within a session detail view. */
export type SessionDetailTick = {
  __typename?: 'SessionDetailTick';
  angle: Scalars['Int']['output'];
  attemptCount: Scalars['Int']['output'];
  boardType: Scalars['String']['output'];
  climbName?: Maybe<Scalars['String']['output']>;
  climbUuid: Scalars['String']['output'];
  climbedAt: Scalars['String']['output'];
  comment?: Maybe<Scalars['String']['output']>;
  difficulty?: Maybe<Scalars['Int']['output']>;
  difficultyName?: Maybe<Scalars['String']['output']>;
  frames?: Maybe<Scalars['String']['output']>;
  isBenchmark: Scalars['Boolean']['output'];
  isMirror: Scalars['Boolean']['output'];
  isNoMatch: Scalars['Boolean']['output'];
  layoutId?: Maybe<Scalars['Int']['output']>;
  quality?: Maybe<Scalars['Int']['output']>;
  setterUsername?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
  /** Total attempts (sum of attemptCount) since last successful ascent by this user on this climb */
  totalAttempts?: Maybe<Scalars['Int']['output']>;
  upvotes: Scalars['Int']['output'];
  userId: Scalars['String']['output'];
  uuid: Scalars['ID']['output'];
};

/** Event when the session ends. */
export type SessionEnded = {
  __typename?: 'SessionEnded';
  /** Optional path to redirect to */
  newPath?: Maybe<Scalars['String']['output']>;
  /** Reason for session ending */
  reason: Scalars['String']['output'];
};

/** Union of possible session events. */
export type SessionEvent =
  | DriverChanged
  | LeaderChanged
  | SessionBoardPathChanged
  | SessionBoardSerialChanged
  | SessionEnded
  | SessionStatsUpdated
  | UserJoined
  | UserLeft
  | UserPresenceChanged
  | WallConfirmedClimb;

/** A session feed card representing a group of ticks from a climbing session. */
export type SessionFeedItem = {
  __typename?: 'SessionFeedItem';
  boardTypes: Array<Scalars['String']['output']>;
  commentCount: Scalars['Int']['output'];
  downvotes: Scalars['Int']['output'];
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  firstTickAt: Scalars['String']['output'];
  goal?: Maybe<Scalars['String']['output']>;
  gradeDistribution: Array<SessionGradeDistributionItem>;
  hardestGrade?: Maybe<Scalars['String']['output']>;
  lastTickAt: Scalars['String']['output'];
  ownerUserId?: Maybe<Scalars['ID']['output']>;
  participants: Array<SessionFeedParticipant>;
  sessionId: Scalars['ID']['output'];
  sessionName?: Maybe<Scalars['String']['output']>;
  sessionType: Scalars['String']['output'];
  tickCount: Scalars['Int']['output'];
  totalAttempts: Scalars['Int']['output'];
  totalFlashes: Scalars['Int']['output'];
  totalSends: Scalars['Int']['output'];
  upvotes: Scalars['Int']['output'];
  voteScore: Scalars['Int']['output'];
};

/** A participant in a climbing session. */
export type SessionFeedParticipant = {
  __typename?: 'SessionFeedParticipant';
  attempts: Scalars['Int']['output'];
  avatarUrl?: Maybe<Scalars['String']['output']>;
  displayName?: Maybe<Scalars['String']['output']>;
  flashes: Scalars['Int']['output'];
  sends: Scalars['Int']['output'];
  userId: Scalars['ID']['output'];
};

/** Paginated session-grouped feed result. */
export type SessionFeedResult = {
  __typename?: 'SessionFeedResult';
  cursor?: Maybe<Scalars['String']['output']>;
  hasMore: Scalars['Boolean']['output'];
  sessions: Array<SessionFeedItem>;
};

/** Grade count for session summary grade distribution. */
export type SessionGradeCount = {
  __typename?: 'SessionGradeCount';
  /** Number of sends at this grade */
  count: Scalars['Int']['output'];
  /** Grade name (e.g., 'V5') */
  grade: Scalars['String']['output'];
};

/** Grade distribution item with flash/send/attempt breakdown. */
export type SessionGradeDistributionItem = {
  __typename?: 'SessionGradeDistributionItem';
  attempt: Scalars['Int']['output'];
  flash: Scalars['Int']['output'];
  grade: Scalars['String']['output'];
  send: Scalars['Int']['output'];
};

/** Hardest climb sent during a session. */
export type SessionHardestClimb = {
  __typename?: 'SessionHardestClimb';
  /** Climb name */
  climbName: Scalars['String']['output'];
  /** Climb UUID */
  climbUuid: Scalars['String']['output'];
  /** Grade name */
  grade: Scalars['String']['output'];
};

/** Participant stats in a session summary. */
export type SessionParticipant = {
  __typename?: 'SessionParticipant';
  /** Total attempts */
  attempts: Scalars['Int']['output'];
  /** Avatar URL */
  avatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name */
  displayName?: Maybe<Scalars['String']['output']>;
  /** Total sends */
  sends: Scalars['Int']['output'];
  /** User ID */
  userId: Scalars['String']['output'];
};

/** Event when session stats change due to logged attempts/sends. */
export type SessionStatsUpdated = {
  __typename?: 'SessionStatsUpdated';
  /** Board types climbed in this session */
  boardTypes: Array<Scalars['String']['output']>;
  /** Session duration in minutes */
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  /** Session goal */
  goal?: Maybe<Scalars['String']['output']>;
  /** Grade distribution with flash/send/attempt counts */
  gradeDistribution: Array<SessionGradeDistributionItem>;
  /** Hardest sent grade in this session */
  hardestGrade?: Maybe<Scalars['String']['output']>;
  /** Per-participant session stats */
  participants: Array<SessionFeedParticipant>;
  /** Session ID these stats belong to */
  sessionId: Scalars['ID']['output'];
  /** Total ticks in this session */
  tickCount: Scalars['Int']['output'];
  /** Current session ticks (latest first) */
  ticks: Array<SessionDetailTick>;
  /** Total failed attempts (excludes successful send attempts) */
  totalAttempts: Scalars['Int']['output'];
  /** Total flashes */
  totalFlashes: Scalars['Int']['output'];
  /** Total sends (flash + send) */
  totalSends: Scalars['Int']['output'];
};

/** Summary of a completed session including stats, grade distribution, and participants. */
export type SessionSummary = {
  __typename?: 'SessionSummary';
  /** Duration in minutes */
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  /** When the session ended */
  endedAt?: Maybe<Scalars['String']['output']>;
  /** Session goal text */
  goal?: Maybe<Scalars['String']['output']>;
  /** Grade distribution of sends */
  gradeDistribution: Array<SessionGradeCount>;
  /** Hardest climb sent during the session */
  hardestClimb?: Maybe<SessionHardestClimb>;
  /** Participants with their stats */
  participants: Array<SessionParticipant>;
  /** Session ID */
  sessionId: Scalars['ID']['output'];
  /** When the session started */
  startedAt?: Maybe<Scalars['String']['output']>;
  /** Total attempts (including sends) */
  totalAttempts: Scalars['Int']['output'];
  /** Total successful sends */
  totalSends: Scalars['Int']['output'];
};

/** A user participating in a climbing session. */
export type SessionUser = {
  __typename?: 'SessionUser';
  /** URL to user's avatar image */
  avatarUrl?: Maybe<Scalars['String']['output']>;
  /** Realtime connection state for this participant */
  connectionState: SessionConnectionState;
  /** Stable participant identifier within this session */
  id: Scalars['ID']['output'];
  /** Whether this user is the session leader (presentation/backward compatibility only) */
  isLeader: Scalars['Boolean']['output'];
  /** Stable database user UUID (null for unauthenticated connections) */
  userId?: Maybe<Scalars['ID']['output']>;
  /** Display name */
  username: Scalars['String']['output'];
};

export type SetCommunitySettingInput = {
  key: Scalars['String']['input'];
  scope: Scalars['String']['input'];
  scopeKey: Scalars['String']['input'];
  value: Scalars['String']['input'];
};

/** A climb created by a setter, for display on profile pages. */
export type SetterClimb = {
  __typename?: 'SetterClimb';
  /** Board angle in degrees */
  angle?: Maybe<Scalars['Int']['output']>;
  /** Number of ascensionists */
  ascensionistCount?: Maybe<Scalars['Int']['output']>;
  /** Board type (kilter, tension, etc.) */
  boardType: Scalars['String']['output'];
  /** When the climb was created */
  createdAt?: Maybe<Scalars['String']['output']>;
  /** Display difficulty name (e.g. 'V5') */
  difficultyName?: Maybe<Scalars['String']['output']>;
  /** Layout ID */
  layoutId: Scalars['Int']['output'];
  /** Climb name */
  name?: Maybe<Scalars['String']['output']>;
  /** Average quality rating */
  qualityAverage?: Maybe<Scalars['Float']['output']>;
  /** Climb UUID */
  uuid: Scalars['String']['output'];
};

/** Paginated list of setter climbs. */
export type SetterClimbsConnection = {
  __typename?: 'SetterClimbsConnection';
  /** List of climbs */
  climbs: Array<SetterClimb>;
  /** Whether more climbs are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of climbs */
  totalCount: Scalars['Int']['output'];
};

/**
 * Input for fetching setter climbs with full Climb data.
 * Used by the setter profile page for thumbnail rendering.
 */
export type SetterClimbsFullInput = {
  /** Board angle (required when boardType is provided) */
  angle?: InputMaybe<Scalars['Int']['input']>;
  /** Board type filter (omit for 'All Boards') */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Layout ID (required when boardType is provided) */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** Maximum number of climbs to return (default 20) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of climbs to skip (default 0) */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Set IDs (required when boardType is provided) */
  setIds?: InputMaybe<Scalars['String']['input']>;
  /** Size ID (required when boardType is provided) */
  sizeId?: InputMaybe<Scalars['Int']['input']>;
  /** Sort order: 'popular' (default) or 'new' */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** The setter's Aurora username */
  username: Scalars['String']['input'];
};

/** Input for fetching setter climbs. */
export type SetterClimbsInput = {
  /** Optional board type filter */
  boardType?: InputMaybe<Scalars['String']['input']>;
  /** Optional layout ID filter */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** Maximum number of climbs to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of climbs to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Sort order: popular (by ascents, default) or new (by creation date) */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** The setter's Aurora username */
  username: Scalars['String']['input'];
};

export type SetterOverrideInput = {
  angle: Scalars['Int']['input'];
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
  communityGrade?: InputMaybe<Scalars['String']['input']>;
  isBenchmark?: InputMaybe<Scalars['Boolean']['input']>;
};

/** Profile of a climb setter (may or may not be a Boardsesh user). */
export type SetterProfile = {
  __typename?: 'SetterProfile';
  /** Board types this setter has climbs on */
  boardTypes: Array<Scalars['String']['output']>;
  /** Total number of climbs set across all boards */
  climbCount: Scalars['Int']['output'];
  /** Number of followers */
  followerCount: Scalars['Int']['output'];
  /** Whether the current user follows this setter */
  isFollowedByMe: Scalars['Boolean']['output'];
  /** Linked user's avatar URL */
  linkedUserAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Linked user's display name */
  linkedUserDisplayName?: Maybe<Scalars['String']['output']>;
  /** Linked Boardsesh user ID (if setter has a Boardsesh account) */
  linkedUserId?: Maybe<Scalars['ID']['output']>;
  /** The setter's Aurora username */
  username: Scalars['String']['output'];
};

/** Input for getting a setter profile. */
export type SetterProfileInput = {
  /** The setter's Aurora username */
  username: Scalars['String']['input'];
};

/** A setter result from unified search. */
export type SetterSearchResult = {
  __typename?: 'SetterSearchResult';
  /** Board types this setter has climbs on */
  boardTypes: Array<Scalars['String']['output']>;
  /** Total number of climbs set */
  climbCount: Scalars['Int']['output'];
  /** Whether the current user follows this setter */
  isFollowedByMe: Scalars['Boolean']['output'];
  /** The setter's Aurora username */
  username: Scalars['String']['output'];
};

/**
 * A setter username paired with the number of climbs they've authored
 * for a given board configuration and angle.
 */
export type SetterStat = {
  __typename?: 'SetterStat';
  /** Number of climbs authored by this setter for the board configuration */
  climbCount: Scalars['Int']['output'];
  /** Setter's username */
  setterUsername: Scalars['String']['output'];
};

/**
 * Input for fetching setter usernames with their climb counts.
 * Used to power the setter filter autocomplete in the search drawer.
 */
export type SetterStatsInput = {
  /** Board angle in degrees */
  angle: Scalars['Int']['input'];
  /** Board type (e.g., 'kilter', 'tension') */
  boardName: Scalars['String']['input'];
  /** Layout ID */
  layoutId: Scalars['Int']['input'];
  /** Case-insensitive substring filter on setter username (for autocomplete) */
  search?: InputMaybe<Scalars['String']['input']>;
  /** Comma-separated set IDs */
  setIds: Scalars['String']['input'];
  /** Size ID */
  sizeId: Scalars['Int']['input'];
};

export type SimilarClimb = {
  __typename?: 'SimilarClimb';
  angle?: Maybe<Scalars['Int']['output']>;
  /** Number of recorded ascents at this angle. */
  ascensionistCount?: Maybe<Scalars['Int']['output']>;
  /** Number of hold positions on the candidate climb. */
  candidateHoldCount: Scalars['Int']['output'];
  /**
   * Product sizes this climb fits on (denormalised from edge bounds). Callers
   * on a smaller wall can use this to grey out climbs that extend beyond
   * their physical board — those climbs are still navigable in the actions
   * menu but can't be set as the active climb. Empty array means the
   * server has no compatibility data for this climb (legacy row).
   */
  compatibleSizeIds: Array<Scalars['Int']['output']>;
  /** Difficulty grade name at this climb's angle (e.g. 6c+, V5). */
  difficultyName?: Maybe<Scalars['String']['output']>;
  /** Aurora-style frame string for rendering the climb thumbnail. */
  frames?: Maybe<Scalars['String']['output']>;
  layoutId: Scalars['Int']['output'];
  name?: Maybe<Scalars['String']['output']>;
  /** Average quality (0..3 in MoonBoard convention, 0..5 elsewhere) at this angle. */
  qualityAverage?: Maybe<Scalars['Float']['output']>;
  setterUsername?: Maybe<Scalars['String']['output']>;
  /** Number of hold positions present in both climbs. */
  sharedHoldCount: Scalars['Int']['output'];
  /** Jaccard similarity (0..1) over hold positions. */
  similarity: Scalars['Float']['output'];
  /** Number of hold positions on the target climb (input). */
  targetHoldCount: Scalars['Int']['output'];
  uuid: Scalars['ID']['output'];
};

/**
 * Input for finding climbs similar to a target on the same board+layout.
 * Provide either climbUuid (compare against an existing climb's holds) or
 * frames (compare against a not-yet-saved hold set).
 */
export type SimilarClimbsInput = {
  /**
   * Viewer angle. When provided, grade/quality/ascent stats and the displayed
   * difficulty name are resolved against this angle on each candidate climb.
   * When omitted, falls back to each candidate's own saved angle — useful for
   * contexts that don't have a viewer angle (e.g. the create-climb duplicate
   * drawer where the candidate's angle is the right reference).
   */
  angle?: InputMaybe<Scalars['Int']['input']>;
  boardType: Scalars['String']['input'];
  /** Existing climb to compare against. Reads its holds from the database. */
  climbUuid?: InputMaybe<Scalars['ID']['input']>;
  /** Exclude this climb's uuid from results (e.g. when looking up similars for an existing climb). */
  excludeClimbUuid?: InputMaybe<Scalars['ID']['input']>;
  /** Raw frames string for an in-progress climb that hasn't been saved yet. */
  frames?: InputMaybe<Scalars['String']['input']>;
  layoutId: Scalars['Int']['input'];
  /** Max number of results to return. Defaults to 25, capped at 200 server-side. */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Jaccard threshold (0..1). Returns climbs at or above this similarity. */
  threshold?: InputMaybe<Scalars['Float']['input']>;
};

/** Climb count for a single smart playlist type (used to render library cards). */
export type SmartPlaylistCount = {
  __typename?: 'SmartPlaylistCount';
  /** Number of climbs the smart playlist would contain */
  count: Scalars['Int']['output'];
  /** Smart playlist type */
  type: SmartPlaylistType;
};

/** Metadata about a smart playlist (the user it belongs to + counts). */
export type SmartPlaylistMeta = {
  __typename?: 'SmartPlaylistMeta';
  /** Total number of climbs in the playlist */
  climbCount: Scalars['Int']['output'];
  /** Smart playlist type */
  type: SmartPlaylistType;
  /** Avatar URL of the user (or null) */
  userAvatar?: Maybe<Scalars['String']['output']>;
  /** User the playlist was generated for */
  userId: Scalars['ID']['output'];
  /** Display name of the user */
  userName: Scalars['String']['output'];
};

/** Result of a smart playlist query. */
export type SmartPlaylistResult = {
  __typename?: 'SmartPlaylistResult';
  /** Page of climbs with full data */
  climbs: Array<Climb>;
  /** Whether more pages are available */
  hasMore: Scalars['Boolean']['output'];
  /** Playlist metadata */
  meta: SmartPlaylistMeta;
  /** Total number of climbs (matches meta.climbCount) */
  totalCount: Scalars['Int']['output'];
};

/**
 * A computed playlist generated from a user's logbook or favourites.
 * - FIVE_STARS: climbs the user has rated 5/5
 * - MOST_REPEATED: climbs the user has logged the most attempts on
 * - PROJECTS: climbs with the most attempts that have never been sent
 * - LIKED_CLIMBS: climbs the user has favourited
 */
export type SmartPlaylistType = 'FIVE_STARS' | 'LIKED_CLIMBS' | 'MOST_REPEATED' | 'PROJECTS';

export type SocialEntityType =
  | 'board'
  | 'climb'
  | 'comment'
  | 'gym'
  | 'playlist_climb'
  | 'proposal'
  | 'session'
  | 'tick';

export type SortMode = 'controversial' | 'hot' | 'new' | 'top';

/** Input for submitAppFeedback mutation. */
export type SubmitAppFeedbackInput = {
  angle?: InputMaybe<Scalars['Int']['input']>;
  /** App build version (native) or deployed web version. Optional. */
  appVersion?: InputMaybe<Scalars['String']['input']>;
  /**
   * Identifier of the board the user is climbing on. Free-form, capped at
   * 100 characters by the backend so future board names work without a
   * schema change. Null when submission happens outside a board context.
   */
  boardName?: InputMaybe<Scalars['String']['input']>;
  /**
   * Optional free-text comment. Required for bug-report sources; typically
   * present for rating sources when rating is below 3.
   */
  comment?: InputMaybe<Scalars['String']['input']>;
  /** Optional debug context (current climb, party session, URL, user agent). */
  context?: InputMaybe<FeedbackContextInput>;
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** 'ios' | 'android' | 'web'. */
  platform: Scalars['String']['input'];
  /** 1–5 star rating. Null for bug reports. */
  rating?: InputMaybe<Scalars['Int']['input']>;
  setIds?: InputMaybe<Array<Scalars['Int']['input']>>;
  sizeId?: InputMaybe<Scalars['Int']['input']>;
  /**
   * Where the feedback originated: 'prompt' | 'drawer-feedback' (rating flows)
   * or 'shake-bug' | 'drawer-bug' (bug reports).
   */
  source: Scalars['String']['input'];
};

/** Root subscription type for real-time updates. */
export type Subscription = {
  __typename?: 'Subscription';
  /** Subscribe to real-time comment updates on an entity. */
  commentUpdates: CommentEvent;
  controllerEvents: ControllerEvent;
  /** Subscribe to new climbs for a board type and layout. */
  newClimbCreated: NewClimbCreatedEvent;
  /**
   * Subscribe to real-time notifications for the current user.
   * Requires authentication.
   */
  notificationReceived: NotificationEvent;
  /** Subscribe to queue changes (items added/removed/reordered, current climb changes). */
  queueUpdates: QueueEvent;
  /** Subscribe to real-time session events (membership, lifecycle, and live stats). */
  sessionUpdates: SessionEvent;
};

/** Root subscription type for real-time updates. */
export type SubscriptionCommentUpdatesArgs = {
  entityId: Scalars['String']['input'];
  entityType: SocialEntityType;
};

/** Root subscription type for real-time updates. */
export type SubscriptionControllerEventsArgs = {
  sessionId: Scalars['ID']['input'];
};

/** Root subscription type for real-time updates. */
export type SubscriptionNewClimbCreatedArgs = {
  boardType: Scalars['String']['input'];
  layoutId: Scalars['Int']['input'];
};

/** Root subscription type for real-time updates. */
export type SubscriptionQueueUpdatesArgs = {
  sessionId: Scalars['ID']['input'];
};

/** Root subscription type for real-time updates. */
export type SubscriptionSessionUpdatesArgs = {
  sessionId: Scalars['ID']['input'];
};

/**
 * Composite sync cursor returned by a pull. Feed it back as SyncCursorInput on
 * the next page.
 */
export type SyncCursor = {
  __typename?: 'SyncCursor';
  /** Sequence component of the last row, stringified bigint. */
  syncSeq: Scalars['String']['output'];
  /** updated_at of the last row in this page (ISO 8601). */
  updatedAt: Scalars['String']['output'];
};

/**
 * Composite sync cursor sent by the client to resume a pull. Both fields come
 * from a previous SyncResult.cursor. Omit (null) on the first pull to start from
 * the beginning.
 */
export type SyncCursorInput = {
  /** Last seen sequence component, stringified bigint. Null on first pull. */
  syncSeq?: InputMaybe<Scalars['String']['input']>;
  /** Last seen updated_at (ISO 8601). Null on first pull. */
  updatedAt?: InputMaybe<Scalars['String']['input']>;
};

/** A single hard-deleted record the client should remove locally. */
export type SyncDeletion = {
  __typename?: 'SyncDeletion';
  /** When the row was deleted (ISO 8601). */
  deletedAt: Scalars['String']['output'];
  /** Natural-key encoding of the deleted row (see docs/sync-table-manifest.md). */
  recordId: Scalars['String']['output'];
  /** Postgres table the row was deleted from. */
  tableName: Scalars['String']['output'];
};

/** One page of deletions for the client to apply. */
export type SyncDeletionsResult = {
  __typename?: 'SyncDeletionsResult';
  /** Cursor to resume from. Pass back as SyncCursorInput. */
  cursor: SyncCursor;
  /** Deletions in this page. */
  deletions: Array<SyncDeletion>;
  /** Whether more deletions remain after this page. */
  hasMore: Scalars['Boolean']['output'];
};

/**
 * One page of synced rows. `documents` are snake_case JSON objects whose keys
 * match the mobile local columns.
 */
export type SyncResult = {
  __typename?: 'SyncResult';
  /** Cursor to resume from. Pass back as SyncCursorInput. */
  cursor: SyncCursor;
  /** Rows in this page as snake_case JSON documents. */
  documents: Array<Scalars['JSON']['output']>;
  /** Whether more rows remain after this page. */
  hasMore: Scalars['Boolean']['output'];
};

/** A recorded climb attempt or completion. */
export type Tick = {
  __typename?: 'Tick';
  /** Board angle when attempted */
  angle: Scalars['Int']['output'];
  /** Number of attempts before success (or total attempts if not sent) */
  attemptCount: Scalars['Int']['output'];
  /** Aurora platform ID for this tick */
  auroraId?: Maybe<Scalars['String']['output']>;
  /** When synced to Aurora (ISO 8601) */
  auroraSyncedAt?: Maybe<Scalars['String']['output']>;
  /** Type of Aurora sync ('bid' or 'ascent') */
  auroraType?: Maybe<Scalars['String']['output']>;
  /** Board entity ID if tick was associated with a board */
  boardId?: Maybe<Scalars['Int']['output']>;
  /** Board type */
  boardType: Scalars['String']['output'];
  /** UUID of the climb attempted */
  climbUuid: Scalars['String']['output'];
  /** When the climb was attempted (ISO 8601) */
  climbedAt: Scalars['String']['output'];
  /** User's comment about the climb */
  comment: Scalars['String']['output'];
  /** Number of (non-deleted) comments on this tick. Null unless populated by a read query. */
  commentCount?: Maybe<Scalars['Int']['output']>;
  /** When this record was created (ISO 8601) */
  createdAt: Scalars['String']['output'];
  /** User's personal grade override as a difficulty_id. Null means the user did not attach a personal grade — read `effectiveDifficulty` for the value to display (it falls back to the climb's consensus). See docs/ascents-and-attempts.md. */
  difficulty?: Maybe<Scalars['Int']['output']>;
  /** Number of downvotes on this tick. Null unless populated by a read query. */
  downvotes?: Maybe<Scalars['Int']['output']>;
  /** Effective grade for display and aggregation: COALESCE(difficulty, ROUND(consensus_difficulty)). Still nullable when the climb has no consensus yet. */
  effectiveDifficulty?: Maybe<Scalars['Int']['output']>;
  /** Whether this is a benchmark climb */
  isBenchmark: Scalars['Boolean']['output'];
  /** Whether the climb was mirrored */
  isMirror: Scalars['Boolean']['output'];
  /** Layout ID when the climb was attempted */
  layoutId?: Maybe<Scalars['Int']['output']>;
  /** User's quality rating (1-5) */
  quality?: Maybe<Scalars['Int']['output']>;
  /** Session ID if climbed during a session */
  sessionId?: Maybe<Scalars['String']['output']>;
  /** Result of the attempt */
  status: TickStatus;
  /** When this record was last updated (ISO 8601) */
  updatedAt: Scalars['String']['output'];
  /** Number of upvotes (likes) on this tick. Null unless populated by a read query. */
  upvotes?: Maybe<Scalars['Int']['output']>;
  /** User who recorded this tick */
  userId: Scalars['ID']['output'];
  /** Unique identifier for this tick */
  uuid: Scalars['ID']['output'];
};

/** Status of a climb attempt. */
export type TickStatus =
  /** Did not complete */
  | 'attempt'
  /** Completed on first attempt */
  | 'flash'
  /** Completed after multiple attempts */
  | 'send';

export type TimePeriod = 'all' | 'day' | 'hour' | 'month' | 'week' | 'year';

/** Input for toggling a climb as favorite. */
export type ToggleFavoriteInput = {
  /** Board angle */
  angle: Scalars['Int']['input'];
  /** Board type */
  boardName: Scalars['String']['input'];
  /** Climb UUID to favorite/unfavorite */
  climbUuid: Scalars['String']['input'];
};

/** Result of toggling favorite status. */
export type ToggleFavoriteResult = {
  __typename?: 'ToggleFavoriteResult';
  /** Whether the climb is now favorited */
  favorited: Scalars['Boolean']['output'];
};

/** Paginated unified search results. */
export type UnifiedSearchConnection = {
  __typename?: 'UnifiedSearchConnection';
  /** Whether more results are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of search results */
  results: Array<UnifiedSearchResult>;
  /** Total number of matching results */
  totalCount: Scalars['Int']['output'];
};

/** A unified search result (can be a Boardsesh user, a setter, or both). */
export type UnifiedSearchResult = {
  __typename?: 'UnifiedSearchResult';
  /** Why this result matched the search */
  matchReason?: Maybe<Scalars['String']['output']>;
  /** Number of recent ascents */
  recentAscentCount: Scalars['Int']['output'];
  /** Setter profile (if result is a setter) */
  setter?: Maybe<SetterSearchResult>;
  /** Boardsesh user profile (if result is a registered user) */
  user?: Maybe<PublicUserProfile>;
};

/** Input for updating a board. */
export type UpdateBoardInput = {
  /** New default angle */
  angle?: InputMaybe<Scalars['Int']['input']>;
  /** Board UUID to update */
  boardUuid: Scalars['ID']['input'];
  /** New description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Hide from proximity search unless owner follows searcher */
  hideLocation?: InputMaybe<Scalars['Boolean']['input']>;
  /** New angle adjustable flag */
  isAngleAdjustable?: InputMaybe<Scalars['Boolean']['input']>;
  /** New ownership flag */
  isOwned?: InputMaybe<Scalars['Boolean']['input']>;
  /** New visibility */
  isPublic?: InputMaybe<Scalars['Boolean']['input']>;
  /** Hide from search results */
  isUnlisted?: InputMaybe<Scalars['Boolean']['input']>;
  /** New GPS latitude */
  latitude?: InputMaybe<Scalars['Float']['input']>;
  /** New layout ID (only allowed when board has zero ticks) */
  layoutId?: InputMaybe<Scalars['Int']['input']>;
  /** New location name */
  locationName?: InputMaybe<Scalars['String']['input']>;
  /** New GPS longitude */
  longitude?: InputMaybe<Scalars['Float']['input']>;
  /** New name */
  name?: InputMaybe<Scalars['String']['input']>;
  /** Controller box serial number */
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  /** New set IDs (only allowed when board has zero ticks) */
  setIds?: InputMaybe<Scalars['String']['input']>;
  /** New size ID (only allowed when board has zero ticks) */
  sizeId?: InputMaybe<Scalars['Int']['input']>;
  /** New slug */
  slug?: InputMaybe<Scalars['String']['input']>;
};

/**
 * Input for updating an existing climb. Only the climb's owner can update
 * the row, and only while it is still a draft OR within 24 hours of its
 * first publish.
 */
export type UpdateClimbInput = {
  angle?: InputMaybe<Scalars['Int']['input']>;
  boardType: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  frames?: InputMaybe<Scalars['String']['input']>;
  framesCount?: InputMaybe<Scalars['Int']['input']>;
  framesPace?: InputMaybe<Scalars['Int']['input']>;
  /** When set, flips the draft state. A climb can go from draft→published but not the other way around. */
  isDraft?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  uuid: Scalars['ID']['input'];
};

export type UpdateClimbResult = {
  __typename?: 'UpdateClimbResult';
  createdAt?: Maybe<Scalars['String']['output']>;
  isDraft: Scalars['Boolean']['output'];
  publishedAt?: Maybe<Scalars['String']['output']>;
  uuid: Scalars['ID']['output'];
};

/** Input for updating a comment. */
export type UpdateCommentInput = {
  /** New body text */
  body: Scalars['String']['input'];
  /** UUID of the comment to update */
  commentUuid: Scalars['ID']['input'];
};

/** Input for updating a gym. */
export type UpdateGymInput = {
  /** New address */
  address?: InputMaybe<Scalars['String']['input']>;
  /** New contact email */
  contactEmail?: InputMaybe<Scalars['String']['input']>;
  /** New contact phone */
  contactPhone?: InputMaybe<Scalars['String']['input']>;
  /** New description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Gym UUID to update */
  gymUuid: Scalars['ID']['input'];
  /** New image URL */
  imageUrl?: InputMaybe<Scalars['String']['input']>;
  /** New visibility */
  isPublic?: InputMaybe<Scalars['Boolean']['input']>;
  /** New GPS latitude */
  latitude?: InputMaybe<Scalars['Float']['input']>;
  /** New GPS longitude */
  longitude?: InputMaybe<Scalars['Float']['input']>;
  /** New name */
  name?: InputMaybe<Scalars['String']['input']>;
  /** New slug */
  slug?: InputMaybe<Scalars['String']['input']>;
};

/** Input for updating an inferred session's metadata. */
export type UpdateInferredSessionInput = {
  /** New session description/notes (optional) */
  description?: InputMaybe<Scalars['String']['input']>;
  /** New session name (optional) */
  name?: InputMaybe<Scalars['String']['input']>;
  /** ID of the inferred session to update */
  sessionId: Scalars['ID']['input'];
};

/** Input for updating a playlist. */
export type UpdatePlaylistInput = {
  /** New color */
  color?: InputMaybe<Scalars['String']['input']>;
  /** New description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** New icon */
  icon?: InputMaybe<Scalars['String']['input']>;
  /** New visibility setting */
  isPublic?: InputMaybe<Scalars['Boolean']['input']>;
  /** New name */
  name?: InputMaybe<Scalars['String']['input']>;
  /** Playlist ID to update */
  playlistId: Scalars['ID']['input'];
};

/** Input for updating user profile. */
export type UpdateProfileInput = {
  /** New avatar URL */
  avatarUrl?: InputMaybe<Scalars['String']['input']>;
  /** New display name */
  displayName?: InputMaybe<Scalars['String']['input']>;
};

/**
 * Input for updating an existing tick.
 * All fields are optional — only provided fields are updated.
 */
export type UpdateTickInput = {
  /** Number of attempts */
  attemptCount?: InputMaybe<Scalars['Int']['input']>;
  /** User comment */
  comment?: InputMaybe<Scalars['String']['input']>;
  /** User's difficulty rating */
  difficulty?: InputMaybe<Scalars['Int']['input']>;
  /** Whether this is a benchmark ascent */
  isBenchmark?: InputMaybe<Scalars['Boolean']['input']>;
  /** User's quality rating (1-5) */
  quality?: InputMaybe<Scalars['Int']['input']>;
  /** Result of the attempt */
  status?: InputMaybe<TickStatus>;
};

/** A named physical board installation (board type + layout + size + hold sets). */
export type UserBoard = {
  __typename?: 'UserBoard';
  /** Default angle for this board */
  angle: Scalars['Int']['output'];
  /** Board type (kilter, tension, moonboard) */
  boardType: Scalars['String']['output'];
  /** Number of comments */
  commentCount: Scalars['Int']['output'];
  /** When created */
  createdAt: Scalars['String']['output'];
  /** Optional description */
  description?: Maybe<Scalars['String']['output']>;
  /** Distance in meters from search origin (only set for proximity queries) */
  distanceMeters?: Maybe<Scalars['Float']['output']>;
  /** Number of followers */
  followerCount: Scalars['Int']['output'];
  /** Gym ID if linked to a gym */
  gymId?: Maybe<Scalars['Int']['output']>;
  /** Gym name if linked to a gym */
  gymName?: Maybe<Scalars['String']['output']>;
  /** Gym UUID if linked to a gym */
  gymUuid?: Maybe<Scalars['String']['output']>;
  /** Whether hidden from proximity/nearby search */
  hideLocation: Scalars['Boolean']['output'];
  /** Whether the board's angle is physically adjustable */
  isAngleAdjustable: Scalars['Boolean']['output'];
  /** Whether the current user follows this board */
  isFollowedByMe: Scalars['Boolean']['output'];
  /** Whether the user owns the physical board */
  isOwned: Scalars['Boolean']['output'];
  /** Whether publicly visible */
  isPublic: Scalars['Boolean']['output'];
  /** Whether hidden from search results (accessible via direct link only) */
  isUnlisted: Scalars['Boolean']['output'];
  /** GPS latitude */
  latitude?: Maybe<Scalars['Float']['output']>;
  /** Layout ID */
  layoutId: Scalars['Int']['output'];
  /** Human-readable layout name */
  layoutName?: Maybe<Scalars['String']['output']>;
  /** Location name */
  locationName?: Maybe<Scalars['String']['output']>;
  /** GPS longitude */
  longitude?: Maybe<Scalars['Float']['output']>;
  /** Board name */
  name: Scalars['String']['output'];
  /** Owner avatar URL */
  ownerAvatarUrl?: Maybe<Scalars['String']['output']>;
  /** Owner display name */
  ownerDisplayName?: Maybe<Scalars['String']['output']>;
  /** Owner user ID */
  ownerId: Scalars['ID']['output'];
  /** Controller box serial number */
  serialNumber?: Maybe<Scalars['String']['output']>;
  /** Comma-separated set IDs */
  setIds: Scalars['String']['output'];
  /** Human-readable set names */
  setNames?: Maybe<Array<Scalars['String']['output']>>;
  /** Human-readable size description */
  sizeDescription?: Maybe<Scalars['String']['output']>;
  /** Size ID */
  sizeId: Scalars['Int']['output'];
  /** Human-readable size name */
  sizeName?: Maybe<Scalars['String']['output']>;
  /** URL slug for this board */
  slug: Scalars['String']['output'];
  /** Total ascents on this board */
  totalAscents: Scalars['Int']['output'];
  /** Number of unique climbers */
  uniqueClimbers: Scalars['Int']['output'];
  /** Unique identifier */
  uuid: Scalars['ID']['output'];
};

/** Paginated list of boards. */
export type UserBoardConnection = {
  __typename?: 'UserBoardConnection';
  /** List of boards */
  boards: Array<UserBoard>;
  /** Whether more boards are available */
  hasMore: Scalars['Boolean']['output'];
  /** Total number of boards */
  totalCount: Scalars['Int']['output'];
};

/** A user's percentile ranking based on distinct climbs ascended. */
export type UserClimbPercentile = {
  __typename?: 'UserClimbPercentile';
  /** Percentile ranking (0-100). 95 means top 5%. */
  percentile: Scalars['Float']['output'];
  /** Total number of users with at least one ascent */
  totalActiveUsers: Scalars['Int']['output'];
  /** Number of distinct climbs the user has sent or flashed */
  totalDistinctClimbs: Scalars['Int']['output'];
};

/**
 * Input for fetching all climbs created by a user.
 * Looks up both directly created climbs (by userId) and Aurora-imported climbs (via linked setter usernames).
 */
export type UserClimbsInput = {
  /** Maximum number of climbs to return (default 20) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of climbs to skip (for pagination) */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Sort order: 'popular' (default) or 'new' */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** The Boardsesh user ID */
  userId: Scalars['ID']['input'];
};

/** Event when a user joins the session. */
export type UserJoined = {
  __typename?: 'UserJoined';
  /** The user who joined */
  user: SessionUser;
};

/** Event when a user leaves the session. */
export type UserLeft = {
  __typename?: 'UserLeft';
  /** ID of the user who left */
  userId: Scalars['ID']['output'];
};

/** Event when a participant's realtime presence state changes. */
export type UserPresenceChanged = {
  __typename?: 'UserPresenceChanged';
  /** The participant whose presence changed */
  user: SessionUser;
};

/** User profile information. */
export type UserProfile = {
  __typename?: 'UserProfile';
  /** URL to user's avatar image */
  avatarUrl?: Maybe<Scalars['String']['output']>;
  /** Display name shown to other users */
  displayName?: Maybe<Scalars['String']['output']>;
  /** User's email address */
  email: Scalars['String']['output'];
  /** Unique user identifier */
  id: Scalars['ID']['output'];
};

/** Paginated user search results. */
export type UserSearchConnection = {
  __typename?: 'UserSearchConnection';
  /** Whether more results are available */
  hasMore: Scalars['Boolean']['output'];
  /** List of search results */
  results: Array<UserSearchResult>;
  /** Total number of matching users */
  totalCount: Scalars['Int']['output'];
};

/** A user search result with relevance metadata. */
export type UserSearchResult = {
  __typename?: 'UserSearchResult';
  /** Why this user matched the search */
  matchReason?: Maybe<Scalars['String']['output']>;
  /** Number of recent ascents (last 30 days) */
  recentAscentCount: Scalars['Int']['output'];
  /** The matching user profile */
  user: PublicUserProfile;
};

/** Input for voting on an entity. */
export type VoteInput = {
  /** Entity ID to vote on */
  entityId: Scalars['String']['input'];
  /** Entity type to vote on */
  entityType: SocialEntityType;
  /** Vote value (+1 or -1) */
  value: Scalars['Int']['input'];
};

export type VoteOnProposalInput = {
  proposalUuid: Scalars['ID']['input'];
  value: Scalars['Int']['input'];
};

/** Vote summary for an entity. */
export type VoteSummary = {
  __typename?: 'VoteSummary';
  /** Number of downvotes */
  downvotes: Scalars['Int']['output'];
  /** Entity ID */
  entityId: Scalars['String']['output'];
  /** Entity type */
  entityType: SocialEntityType;
  /** Number of upvotes */
  upvotes: Scalars['Int']['output'];
  /** Current user's vote (-1, 0, or 1) */
  userVote: Scalars['Int']['output'];
  /** Net vote score */
  voteScore: Scalars['Int']['output'];
};

/**
 * Event broadcast when a participant's phone successfully relays a climb to the
 * wall over BLE. Other clients use this confirmation to flip the queue-control-bar
 * lightbulb from pending to confirmed and to dismiss the local fallback timer.
 * Server-stamped: `confirmedAt` is set by the backend on receipt to keep ordering
 * authoritative across clients.
 */
export type WallConfirmedClimb = {
  __typename?: 'WallConfirmedClimb';
  /** UUID of the climb that was sent to the wall */
  climbUuid: Scalars['ID']['output'];
  /** Server timestamp when the confirmation was received (ISO 8601) */
  confirmedAt: Scalars['String']['output'];
  /** Stable participant id of the member whose phone relayed the climb */
  confirmedByParticipantId: Scalars['ID']['output'];
  /** UUID of the queue item that triggered this send, or null when the BLE-capable phone reported only a climb UUID. Lets clients disambiguate when the same climb is queued twice — without this, both queue entries' pending lightbulbs would clear on a single confirmation. */
  queueItemUuid?: Maybe<Scalars['ID']['output']>;
};

/**
 * Bounding box defining a board region for filtering climbs.
 * Coordinates are in the same grid space as board placements
 * (board_holes.x/y) and board_climbs edge columns.
 */
export type ZoneBoxInput = {
  /** Bottom edge of the zone (smaller y) */
  edgeBottom: Scalars['Int']['input'];
  /** Left edge of the zone (smaller x) */
  edgeLeft: Scalars['Int']['input'];
  /** Right edge of the zone (larger x) */
  edgeRight: Scalars['Int']['input'];
  /** Top edge of the zone (larger y) */
  edgeTop: Scalars['Int']['input'];
};

/**
 * How a drawn zone should match climbs.
 * allHolds keeps the existing behavior: every climb hold must fit inside the box.
 * anyHold matches climbs that use at least one hold inside the box.
 */
export type ZoneMatchMode = 'allHolds' | 'anyHold';

export type GetDeleteAccountInfoQueryVariables = Exact<{ [key: string]: never }>;

export type GetDeleteAccountInfoQuery = {
  __typename?: 'Query';
  deleteAccountInfo: { __typename?: 'DeleteAccountInfo'; publishedClimbCount: number };
};

export type DeleteAccountMutationVariables = Exact<{
  input: DeleteAccountInput;
}>;

export type DeleteAccountMutation = { __typename?: 'Mutation'; deleteAccount: boolean };

export type GetBetaLinksQueryVariables = Exact<{
  boardType: Scalars['String']['input'];
  climbUuid: Scalars['String']['input'];
}>;

export type GetBetaLinksQuery = {
  __typename?: 'Query';
  betaLinks: Array<{
    __typename?: 'BetaLink';
    climbUuid: string;
    link: string;
    foreignUsername?: string | null;
    angle?: number | null;
    thumbnail?: string | null;
    isListed?: boolean | null;
    createdAt?: string | null;
  }>;
};

export type AttachBetaLinkMutationVariables = Exact<{
  input: AttachBetaLinkInput;
}>;

export type AttachBetaLinkMutation = { __typename?: 'Mutation'; attachBetaLink: boolean };

export type GetRecentBetaLinksQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  boardType?: InputMaybe<Scalars['String']['input']>;
}>;

export type GetRecentBetaLinksQuery = {
  __typename?: 'Query';
  recentBetaLinks: Array<{
    __typename?: 'RecentBetaLink';
    climbName?: string | null;
    boardType: string;
    layoutId?: number | null;
    betaLink: {
      __typename?: 'BetaLink';
      climbUuid: string;
      link: string;
      foreignUsername?: string | null;
      angle?: number | null;
      thumbnail?: string | null;
      isListed?: boolean | null;
      createdAt?: string | null;
    };
  }>;
};

export type GetUserBetaLinksQueryVariables = Exact<{
  userId: Scalars['String']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
}>;

export type GetUserBetaLinksQuery = {
  __typename?: 'Query';
  userBetaLinks: Array<{
    __typename?: 'RecentBetaLink';
    climbName?: string | null;
    boardType: string;
    layoutId?: number | null;
    betaLink: {
      __typename?: 'BetaLink';
      climbUuid: string;
      link: string;
      foreignUsername?: string | null;
      angle?: number | null;
      thumbnail?: string | null;
      isListed?: boolean | null;
      createdAt?: string | null;
    };
  }>;
};

export type ClimbStatsHistoryQueryVariables = Exact<{
  boardName: Scalars['String']['input'];
  climbUuid: Scalars['ID']['input'];
}>;

export type ClimbStatsHistoryQuery = {
  __typename?: 'Query';
  climbStatsHistory: Array<{
    __typename?: 'ClimbStatsHistoryEntry';
    angle: number;
    ascensionistCount?: number | null;
    qualityAverage?: number | null;
    difficultyAverage?: number | null;
    displayDifficulty?: number | null;
    createdAt: string;
  }>;
};

export type GetGlobalCommentFeedQueryVariables = Exact<{
  input?: InputMaybe<GlobalCommentFeedInput>;
}>;

export type GetGlobalCommentFeedQuery = {
  __typename?: 'Query';
  globalCommentFeed: {
    __typename?: 'CommentConnection';
    totalCount: number;
    hasMore: boolean;
    cursor?: string | null;
    comments: Array<{
      __typename?: 'Comment';
      uuid: string;
      userId: string;
      userDisplayName?: string | null;
      userAvatarUrl?: string | null;
      entityType: SocialEntityType;
      entityId: string;
      parentCommentUuid?: string | null;
      body?: string | null;
      isDeleted: boolean;
      replyCount: number;
      upvotes: number;
      downvotes: number;
      voteScore: number;
      userVote: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
};

export type GetCommentsQueryVariables = Exact<{
  input: CommentsInput;
}>;

export type GetCommentsQuery = {
  __typename?: 'Query';
  comments: {
    __typename?: 'CommentConnection';
    totalCount: number;
    hasMore: boolean;
    comments: Array<{
      __typename?: 'Comment';
      uuid: string;
      userId: string;
      userDisplayName?: string | null;
      userAvatarUrl?: string | null;
      entityType: SocialEntityType;
      entityId: string;
      parentCommentUuid?: string | null;
      body?: string | null;
      isDeleted: boolean;
      replyCount: number;
      upvotes: number;
      downvotes: number;
      voteScore: number;
      userVote: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
};

export type GetVoteSummaryQueryVariables = Exact<{
  entityType: SocialEntityType;
  entityId: Scalars['String']['input'];
}>;

export type GetVoteSummaryQuery = {
  __typename?: 'Query';
  voteSummary: {
    __typename?: 'VoteSummary';
    entityType: SocialEntityType;
    entityId: string;
    upvotes: number;
    downvotes: number;
    voteScore: number;
    userVote: number;
  };
};

export type GetBulkVoteSummariesQueryVariables = Exact<{
  input: BulkVoteSummaryInput;
}>;

export type GetBulkVoteSummariesQuery = {
  __typename?: 'Query';
  bulkVoteSummaries: Array<{
    __typename?: 'VoteSummary';
    entityType: SocialEntityType;
    entityId: string;
    upvotes: number;
    downvotes: number;
    voteScore: number;
    userVote: number;
  }>;
};

export type AddCommentMutationVariables = Exact<{
  input: AddCommentInput;
}>;

export type AddCommentMutation = {
  __typename?: 'Mutation';
  addComment: {
    __typename?: 'Comment';
    uuid: string;
    userId: string;
    userDisplayName?: string | null;
    userAvatarUrl?: string | null;
    entityType: SocialEntityType;
    entityId: string;
    parentCommentUuid?: string | null;
    body?: string | null;
    isDeleted: boolean;
    replyCount: number;
    upvotes: number;
    downvotes: number;
    voteScore: number;
    userVote: number;
    createdAt: string;
    updatedAt: string;
  };
};

export type UpdateCommentMutationVariables = Exact<{
  input: UpdateCommentInput;
}>;

export type UpdateCommentMutation = {
  __typename?: 'Mutation';
  updateComment: {
    __typename?: 'Comment';
    uuid: string;
    userId: string;
    userDisplayName?: string | null;
    userAvatarUrl?: string | null;
    entityType: SocialEntityType;
    entityId: string;
    parentCommentUuid?: string | null;
    body?: string | null;
    isDeleted: boolean;
    replyCount: number;
    upvotes: number;
    downvotes: number;
    voteScore: number;
    userVote: number;
    createdAt: string;
    updatedAt: string;
  };
};

export type DeleteCommentMutationVariables = Exact<{
  commentUuid: Scalars['ID']['input'];
}>;

export type DeleteCommentMutation = { __typename?: 'Mutation'; deleteComment: boolean };

export type VoteMutationVariables = Exact<{
  input: VoteInput;
}>;

export type VoteMutation = {
  __typename?: 'Mutation';
  vote: {
    __typename?: 'VoteSummary';
    entityType: SocialEntityType;
    entityId: string;
    upvotes: number;
    downvotes: number;
    voteScore: number;
    userVote: number;
  };
};

export type CreateSessionMutationVariables = Exact<{
  input: CreateSessionInput;
}>;

export type CreateSessionMutation = {
  __typename?: 'Mutation';
  createSession: {
    __typename?: 'Session';
    id: string;
    name?: string | null;
    boardPath: string;
    goal?: string | null;
    isPublic: boolean;
    isPermanent: boolean;
    color?: string | null;
    startedAt?: string | null;
  };
};

export type FavoritesQueryVariables = Exact<{
  boardName: Scalars['String']['input'];
  climbUuids: Array<Scalars['String']['input']> | Scalars['String']['input'];
  angle: Scalars['Int']['input'];
}>;

export type FavoritesQuery = { __typename?: 'Query'; favorites: Array<string> };

export type ToggleFavoriteMutationVariables = Exact<{
  input: ToggleFavoriteInput;
}>;

export type ToggleFavoriteMutation = {
  __typename?: 'Mutation';
  toggleFavorite: { __typename?: 'ToggleFavoriteResult'; favorited: boolean };
};

export type UserFavoritesCountsQueryVariables = Exact<{ [key: string]: never }>;

export type UserFavoritesCountsQuery = {
  __typename?: 'Query';
  userFavoritesCounts: Array<{ __typename?: 'FavoritesCount'; boardName: string; count: number }>;
};

export type UserActiveBoardsQueryVariables = Exact<{ [key: string]: never }>;

export type UserActiveBoardsQuery = { __typename?: 'Query'; userActiveBoards: Array<string> };

export type GetUserFavoriteClimbsQueryVariables = Exact<{
  input: GetUserFavoriteClimbsInput;
}>;

export type GetUserFavoriteClimbsQuery = {
  __typename?: 'Query';
  userFavoriteClimbs: {
    __typename?: 'PlaylistClimbsResult';
    totalCount: number;
    hasMore: boolean;
    climbs: Array<{
      __typename?: 'Climb';
      uuid: string;
      layoutId?: number | null;
      setter_username: string;
      name: string;
      description?: string | null;
      frames: string;
      angle: number;
      ascensionist_count: number;
      difficulty: string;
      quality_average: string;
      stars: number;
      difficulty_error: string;
      benchmark_difficulty?: string | null;
    }>;
  };
};

export type SubmitAppFeedbackMutationVariables = Exact<{
  input: SubmitAppFeedbackInput;
}>;

export type SubmitAppFeedbackMutation = { __typename?: 'Mutation'; submitAppFeedback: boolean };

export type GetNewClimbFeedQueryVariables = Exact<{
  input: NewClimbFeedInput;
}>;

export type GetNewClimbFeedQuery = {
  __typename?: 'Query';
  newClimbFeed: {
    __typename?: 'NewClimbFeedResult';
    totalCount: number;
    hasMore: boolean;
    items: Array<{
      __typename?: 'NewClimbFeedItem';
      uuid: string;
      name?: string | null;
      boardType: string;
      layoutId: number;
      setterDisplayName?: string | null;
      setterAvatarUrl?: string | null;
      angle?: number | null;
      frames?: string | null;
      difficultyName?: string | null;
      isNoMatch: boolean;
      createdAt: string;
    }>;
  };
};

export type GetMyNewClimbSubscriptionsQueryVariables = Exact<{ [key: string]: never }>;

export type GetMyNewClimbSubscriptionsQuery = {
  __typename?: 'Query';
  myNewClimbSubscriptions: Array<{
    __typename?: 'NewClimbSubscription';
    id: string;
    boardType: string;
    layoutId: number;
    createdAt: string;
  }>;
};

export type SubscribeNewClimbsMutationVariables = Exact<{
  input: NewClimbSubscriptionInput;
}>;

export type SubscribeNewClimbsMutation = { __typename?: 'Mutation'; subscribeNewClimbs: boolean };

export type UnsubscribeNewClimbsMutationVariables = Exact<{
  input: NewClimbSubscriptionInput;
}>;

export type UnsubscribeNewClimbsMutation = { __typename?: 'Mutation'; unsubscribeNewClimbs: boolean };

export type OnNewClimbCreatedSubscriptionVariables = Exact<{
  boardType: Scalars['String']['input'];
  layoutId: Scalars['Int']['input'];
}>;

export type OnNewClimbCreatedSubscription = {
  __typename?: 'Subscription';
  newClimbCreated: {
    __typename?: 'NewClimbCreatedEvent';
    climb: {
      __typename?: 'NewClimbFeedItem';
      uuid: string;
      name?: string | null;
      boardType: string;
      layoutId: number;
      setterDisplayName?: string | null;
      setterAvatarUrl?: string | null;
      angle?: number | null;
      frames?: string | null;
      difficultyName?: string | null;
      isNoMatch: boolean;
      createdAt: string;
    };
  };
};

export type CheckMoonBoardClimbDuplicatesQueryVariables = Exact<{
  input: CheckMoonBoardClimbDuplicatesInput;
}>;

export type CheckMoonBoardClimbDuplicatesQuery = {
  __typename?: 'Query';
  checkMoonBoardClimbDuplicates: Array<{
    __typename?: 'MoonBoardClimbDuplicateMatch';
    clientKey: string;
    exists: boolean;
    existingClimbUuid?: string | null;
    existingClimbName?: string | null;
  }>;
};

export type SimilarClimbsQueryVariables = Exact<{
  input: SimilarClimbsInput;
}>;

export type SimilarClimbsQuery = {
  __typename?: 'Query';
  similarClimbs: Array<{
    __typename?: 'SimilarClimb';
    uuid: string;
    name?: string | null;
    setterUsername?: string | null;
    angle?: number | null;
    layoutId: number;
    frames?: string | null;
    difficultyName?: string | null;
    qualityAverage?: number | null;
    ascensionistCount?: number | null;
    compatibleSizeIds: Array<number>;
    similarity: number;
    sharedHoldCount: number;
    candidateHoldCount: number;
    targetHoldCount: number;
  }>;
};

export type SaveClimbMutationVariables = Exact<{
  input: SaveClimbInput;
}>;

export type SaveClimbMutation = {
  __typename?: 'Mutation';
  saveClimb: {
    __typename?: 'SaveClimbResult';
    uuid: string;
    synced: boolean;
    createdAt?: string | null;
    publishedAt?: string | null;
  };
};

export type SaveMoonBoardClimbMutationVariables = Exact<{
  input: SaveMoonBoardClimbInput;
}>;

export type SaveMoonBoardClimbMutation = {
  __typename?: 'Mutation';
  saveMoonBoardClimb: {
    __typename?: 'SaveClimbResult';
    uuid: string;
    synced: boolean;
    createdAt?: string | null;
    publishedAt?: string | null;
  };
};

export type UpdateClimbMutationVariables = Exact<{
  input: UpdateClimbInput;
}>;

export type UpdateClimbMutation = {
  __typename?: 'Mutation';
  updateClimb: {
    __typename?: 'UpdateClimbResult';
    uuid: string;
    createdAt?: string | null;
    publishedAt?: string | null;
    isDraft: boolean;
  };
};

export type DeleteDraftClimbMutationVariables = Exact<{
  uuid: Scalars['ID']['input'];
  boardType: Scalars['String']['input'];
}>;

export type DeleteDraftClimbMutation = { __typename?: 'Mutation'; deleteDraftClimb: boolean };

export type GetNotificationsQueryVariables = Exact<{
  unreadOnly?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
}>;

export type GetNotificationsQuery = {
  __typename?: 'Query';
  notifications: {
    __typename?: 'NotificationConnection';
    totalCount: number;
    unreadCount: number;
    hasMore: boolean;
    notifications: Array<{
      __typename?: 'Notification';
      uuid: string;
      type: NotificationType;
      actorId?: string | null;
      actorDisplayName?: string | null;
      actorAvatarUrl?: string | null;
      entityType?: SocialEntityType | null;
      entityId?: string | null;
      commentBody?: string | null;
      climbName?: string | null;
      climbUuid?: string | null;
      boardType?: string | null;
      proposalUuid?: string | null;
      isRead: boolean;
      createdAt: string;
    }>;
  };
};

export type GetGroupedNotificationsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
}>;

export type GetGroupedNotificationsQuery = {
  __typename?: 'Query';
  groupedNotifications: {
    __typename?: 'GroupedNotificationConnection';
    totalCount: number;
    unreadCount: number;
    hasMore: boolean;
    groups: Array<{
      __typename?: 'GroupedNotification';
      uuid: string;
      type: NotificationType;
      entityType?: SocialEntityType | null;
      entityId?: string | null;
      actorCount: number;
      commentBody?: string | null;
      climbName?: string | null;
      climbUuid?: string | null;
      boardType?: string | null;
      proposalUuid?: string | null;
      setterUsername?: string | null;
      isRead: boolean;
      createdAt: string;
      actors: Array<{
        __typename?: 'GroupedNotificationActor';
        id: string;
        displayName?: string | null;
        avatarUrl?: string | null;
      }>;
    }>;
  };
};

export type GetUnreadNotificationCountQueryVariables = Exact<{ [key: string]: never }>;

export type GetUnreadNotificationCountQuery = { __typename?: 'Query'; unreadNotificationCount: number };

export type MarkNotificationReadMutationVariables = Exact<{
  notificationUuid: Scalars['ID']['input'];
}>;

export type MarkNotificationReadMutation = { __typename?: 'Mutation'; markNotificationRead: boolean };

export type MarkGroupNotificationsReadMutationVariables = Exact<{
  type: NotificationType;
  entityType?: InputMaybe<SocialEntityType>;
  entityId?: InputMaybe<Scalars['String']['input']>;
}>;

export type MarkGroupNotificationsReadMutation = { __typename?: 'Mutation'; markGroupNotificationsRead: number };

export type MarkAllNotificationsReadMutationVariables = Exact<{ [key: string]: never }>;

export type MarkAllNotificationsReadMutation = { __typename?: 'Mutation'; markAllNotificationsRead: boolean };

export type PlaylistFieldsFragment = {
  __typename?: 'Playlist';
  id: string;
  uuid: string;
  boardType: string;
  layoutId?: number | null;
  name: string;
  description?: string | null;
  isPublic: boolean;
  color?: string | null;
  icon?: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string | null;
  climbCount: number;
  userRole?: string | null;
  followerCount: number;
  isFollowedByMe: boolean;
  isPinnedByMe: boolean;
};

export type GetUserPlaylistsQueryVariables = Exact<{
  input: GetUserPlaylistsInput;
}>;

export type GetUserPlaylistsQuery = {
  __typename?: 'Query';
  userPlaylists: Array<{
    __typename?: 'Playlist';
    id: string;
    uuid: string;
    boardType: string;
    layoutId?: number | null;
    name: string;
    description?: string | null;
    isPublic: boolean;
    color?: string | null;
    icon?: string | null;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt?: string | null;
    climbCount: number;
    userRole?: string | null;
    followerCount: number;
    isFollowedByMe: boolean;
    isPinnedByMe: boolean;
  }>;
};

export type GetAllUserPlaylistsQueryVariables = Exact<{
  input: GetAllUserPlaylistsInput;
}>;

export type GetAllUserPlaylistsQuery = {
  __typename?: 'Query';
  allUserPlaylists: {
    __typename?: 'AllUserPlaylistsResult';
    totalCount: number;
    hasMore: boolean;
    playlists: Array<{
      __typename?: 'Playlist';
      id: string;
      uuid: string;
      boardType: string;
      layoutId?: number | null;
      name: string;
      description?: string | null;
      isPublic: boolean;
      color?: string | null;
      icon?: string | null;
      createdAt: string;
      updatedAt: string;
      lastAccessedAt?: string | null;
      climbCount: number;
      userRole?: string | null;
      followerCount: number;
      isFollowedByMe: boolean;
      isPinnedByMe: boolean;
    }>;
  };
};

export type GetMyPinnedPlaylistsQueryVariables = Exact<{
  input: GetMyPinnedPlaylistsInput;
}>;

export type GetMyPinnedPlaylistsQuery = {
  __typename?: 'Query';
  myPinnedPlaylists: Array<{
    __typename?: 'Playlist';
    id: string;
    uuid: string;
    boardType: string;
    layoutId?: number | null;
    name: string;
    description?: string | null;
    isPublic: boolean;
    color?: string | null;
    icon?: string | null;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt?: string | null;
    climbCount: number;
    userRole?: string | null;
    followerCount: number;
    isFollowedByMe: boolean;
    isPinnedByMe: boolean;
  }>;
};

export type PinPlaylistMutationVariables = Exact<{
  input: PinPlaylistInput;
}>;

export type PinPlaylistMutation = { __typename?: 'Mutation'; pinPlaylist: boolean };

export type UnpinPlaylistMutationVariables = Exact<{
  input: PinPlaylistInput;
}>;

export type UnpinPlaylistMutation = { __typename?: 'Mutation'; unpinPlaylist: boolean };

export type GetPlaylistQueryVariables = Exact<{
  playlistId: Scalars['ID']['input'];
}>;

export type GetPlaylistQuery = {
  __typename?: 'Query';
  playlist?: {
    __typename?: 'Playlist';
    id: string;
    uuid: string;
    boardType: string;
    layoutId?: number | null;
    name: string;
    description?: string | null;
    isPublic: boolean;
    color?: string | null;
    icon?: string | null;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt?: string | null;
    climbCount: number;
    userRole?: string | null;
    followerCount: number;
    isFollowedByMe: boolean;
    isPinnedByMe: boolean;
  } | null;
};

export type GetPlaylistsForClimbQueryVariables = Exact<{
  input: GetPlaylistsForClimbInput;
}>;

export type GetPlaylistsForClimbQuery = { __typename?: 'Query'; playlistsForClimb: Array<string> };

export type GetPlaylistsForClimbsQueryVariables = Exact<{
  input: GetPlaylistsForClimbsInput;
}>;

export type GetPlaylistsForClimbsQuery = {
  __typename?: 'Query';
  playlistsForClimbs: Array<{
    __typename?: 'ClimbPlaylistMembership';
    climbUuid: string;
    playlistUuids: Array<string>;
  }>;
};

export type CreatePlaylistMutationVariables = Exact<{
  input: CreatePlaylistInput;
}>;

export type CreatePlaylistMutation = {
  __typename?: 'Mutation';
  createPlaylist: {
    __typename?: 'Playlist';
    id: string;
    uuid: string;
    boardType: string;
    layoutId?: number | null;
    name: string;
    description?: string | null;
    isPublic: boolean;
    color?: string | null;
    icon?: string | null;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt?: string | null;
    climbCount: number;
    userRole?: string | null;
    followerCount: number;
    isFollowedByMe: boolean;
    isPinnedByMe: boolean;
  };
};

export type UpdatePlaylistMutationVariables = Exact<{
  input: UpdatePlaylistInput;
}>;

export type UpdatePlaylistMutation = {
  __typename?: 'Mutation';
  updatePlaylist: {
    __typename?: 'Playlist';
    id: string;
    uuid: string;
    boardType: string;
    layoutId?: number | null;
    name: string;
    description?: string | null;
    isPublic: boolean;
    color?: string | null;
    icon?: string | null;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt?: string | null;
    climbCount: number;
    userRole?: string | null;
    followerCount: number;
    isFollowedByMe: boolean;
    isPinnedByMe: boolean;
  };
};

export type DeletePlaylistMutationVariables = Exact<{
  playlistId: Scalars['ID']['input'];
}>;

export type DeletePlaylistMutation = { __typename?: 'Mutation'; deletePlaylist: boolean };

export type AddClimbToPlaylistMutationVariables = Exact<{
  input: AddClimbToPlaylistInput;
}>;

export type AddClimbToPlaylistMutation = {
  __typename?: 'Mutation';
  addClimbToPlaylist: {
    __typename?: 'PlaylistClimb';
    id: string;
    playlistId: string;
    climbUuid: string;
    angle?: number | null;
    position: number;
    addedAt: string;
  };
};

export type RemoveClimbFromPlaylistMutationVariables = Exact<{
  input: RemoveClimbFromPlaylistInput;
}>;

export type RemoveClimbFromPlaylistMutation = { __typename?: 'Mutation'; removeClimbFromPlaylist: boolean };

export type GetPlaylistClimbsQueryVariables = Exact<{
  input: GetPlaylistClimbsInput;
}>;

export type GetPlaylistClimbsQuery = {
  __typename?: 'Query';
  playlistClimbs: {
    __typename?: 'PlaylistClimbsResult';
    totalCount: number;
    hasMore: boolean;
    climbs: Array<{
      __typename?: 'Climb';
      uuid: string;
      layoutId?: number | null;
      boardType?: string | null;
      setter_username: string;
      name: string;
      description?: string | null;
      frames: string;
      angle: number;
      ascensionist_count: number;
      difficulty: string;
      quality_average: string;
      stars: number;
      difficulty_error: string;
      benchmark_difficulty?: string | null;
    }>;
  };
};

export type DiscoverPlaylistsQueryVariables = Exact<{
  input: DiscoverPlaylistsInput;
}>;

export type DiscoverPlaylistsQuery = {
  __typename?: 'Query';
  discoverPlaylists: {
    __typename?: 'DiscoverPlaylistsResult';
    totalCount: number;
    hasMore: boolean;
    playlists: Array<{
      __typename?: 'DiscoverablePlaylist';
      id: string;
      uuid: string;
      boardType: string;
      layoutId?: number | null;
      name: string;
      description?: string | null;
      color?: string | null;
      icon?: string | null;
      createdAt: string;
      updatedAt: string;
      climbCount: number;
      creatorId: string;
      creatorName: string;
    }>;
  };
};

export type GetPlaylistCreatorsQueryVariables = Exact<{
  input: GetPlaylistCreatorsInput;
}>;

export type GetPlaylistCreatorsQuery = {
  __typename?: 'Query';
  playlistCreators: Array<{
    __typename?: 'PlaylistCreator';
    userId: string;
    displayName: string;
    playlistCount: number;
  }>;
};

export type UpdatePlaylistLastAccessedMutationVariables = Exact<{
  playlistId: Scalars['ID']['input'];
}>;

export type UpdatePlaylistLastAccessedMutation = { __typename?: 'Mutation'; updatePlaylistLastAccessed: boolean };

export type SearchPlaylistsQueryVariables = Exact<{
  input: SearchPlaylistsInput;
}>;

export type SearchPlaylistsQuery = {
  __typename?: 'Query';
  searchPlaylists: {
    __typename?: 'SearchPlaylistsResult';
    totalCount: number;
    hasMore: boolean;
    playlists: Array<{
      __typename?: 'DiscoverablePlaylist';
      id: string;
      uuid: string;
      boardType: string;
      layoutId?: number | null;
      name: string;
      description?: string | null;
      color?: string | null;
      icon?: string | null;
      climbCount: number;
      creatorId: string;
      creatorName: string;
      createdAt: string;
      updatedAt: string;
    }>;
  };
};

export type FollowPlaylistMutationVariables = Exact<{
  input: FollowPlaylistInput;
}>;

export type FollowPlaylistMutation = { __typename?: 'Mutation'; followPlaylist: boolean };

export type UnfollowPlaylistMutationVariables = Exact<{
  input: FollowPlaylistInput;
}>;

export type UnfollowPlaylistMutation = { __typename?: 'Mutation'; unfollowPlaylist: boolean };

export type GetSmartPlaylistQueryVariables = Exact<{
  input: GetSmartPlaylistInput;
}>;

export type GetSmartPlaylistQuery = {
  __typename?: 'Query';
  smartPlaylist: {
    __typename?: 'SmartPlaylistResult';
    totalCount: number;
    hasMore: boolean;
    meta: {
      __typename?: 'SmartPlaylistMeta';
      type: SmartPlaylistType;
      userId: string;
      userName: string;
      userAvatar?: string | null;
      climbCount: number;
    };
    climbs: Array<{
      __typename?: 'Climb';
      uuid: string;
      layoutId?: number | null;
      boardType?: string | null;
      setter_username: string;
      name: string;
      description?: string | null;
      frames: string;
      angle: number;
      ascensionist_count: number;
      difficulty: string;
      quality_average: string;
      stars: number;
      difficulty_error: string;
      benchmark_difficulty?: string | null;
    }>;
  };
};

export type GetMySmartPlaylistCountsQueryVariables = Exact<{ [key: string]: never }>;

export type GetMySmartPlaylistCountsQuery = {
  __typename?: 'Query';
  mySmartPlaylistCounts: Array<{ __typename?: 'SmartPlaylistCount'; type: SmartPlaylistType; count: number }>;
};

export type GetClimbProposalsQueryVariables = Exact<{
  input: GetClimbProposalsInput;
}>;

export type GetClimbProposalsQuery = {
  __typename?: 'Query';
  climbProposals: {
    __typename?: 'ProposalConnection';
    totalCount: number;
    hasMore: boolean;
    proposals: Array<{
      __typename?: 'Proposal';
      uuid: string;
      climbUuid: string;
      boardType: string;
      angle?: number | null;
      proposerId: string;
      proposerDisplayName?: string | null;
      proposerAvatarUrl?: string | null;
      type: ProposalType;
      proposedValue: string;
      currentValue: string;
      status: ProposalStatus;
      reason?: string | null;
      resolvedAt?: string | null;
      resolvedBy?: string | null;
      createdAt: string;
      weightedUpvotes: number;
      weightedDownvotes: number;
      requiredUpvotes: number;
      userVote: number;
      climbName?: string | null;
      frames?: string | null;
      layoutId?: number | null;
      climbSetterUsername?: string | null;
      climbDifficulty?: string | null;
      climbQualityAverage?: string | null;
      climbAscensionistCount?: number | null;
      climbDifficultyError?: string | null;
      climbBenchmarkDifficulty?: string | null;
      climbIsNoMatch?: boolean | null;
    }>;
  };
};

export type GetClimbCommunityStatusQueryVariables = Exact<{
  climbUuid: Scalars['String']['input'];
  boardType: Scalars['String']['input'];
  angle: Scalars['Int']['input'];
}>;

export type GetClimbCommunityStatusQuery = {
  __typename?: 'Query';
  climbCommunityStatus: {
    __typename?: 'ClimbCommunityStatus';
    climbUuid: string;
    boardType: string;
    angle: number;
    communityGrade?: string | null;
    isBenchmark: boolean;
    isClassic: boolean;
    isFrozen: boolean;
    freezeReason?: string | null;
    openProposalCount: number;
    updatedAt?: string | null;
    outlierAnalysis?: {
      __typename?: 'OutlierAnalysis';
      isOutlier: boolean;
      currentGrade: number;
      neighborAverage: number;
      neighborCount: number;
      gradeDifference: number;
    } | null;
  };
};

export type GetBulkClimbCommunityStatusQueryVariables = Exact<{
  climbUuids: Array<Scalars['String']['input']> | Scalars['String']['input'];
  boardType: Scalars['String']['input'];
  angle: Scalars['Int']['input'];
}>;

export type GetBulkClimbCommunityStatusQuery = {
  __typename?: 'Query';
  bulkClimbCommunityStatus: Array<{
    __typename?: 'ClimbCommunityStatus';
    climbUuid: string;
    boardType: string;
    angle: number;
    communityGrade?: string | null;
    isBenchmark: boolean;
    isClassic: boolean;
    isFrozen: boolean;
    freezeReason?: string | null;
    openProposalCount: number;
    updatedAt?: string | null;
  }>;
};

export type BrowseProposalsQueryVariables = Exact<{
  input: BrowseProposalsInput;
}>;

export type BrowseProposalsQuery = {
  __typename?: 'Query';
  browseProposals: {
    __typename?: 'ProposalConnection';
    totalCount: number;
    hasMore: boolean;
    proposals: Array<{
      __typename?: 'Proposal';
      uuid: string;
      climbUuid: string;
      boardType: string;
      angle?: number | null;
      proposerId: string;
      proposerDisplayName?: string | null;
      proposerAvatarUrl?: string | null;
      type: ProposalType;
      proposedValue: string;
      currentValue: string;
      status: ProposalStatus;
      reason?: string | null;
      resolvedAt?: string | null;
      resolvedBy?: string | null;
      createdAt: string;
      weightedUpvotes: number;
      weightedDownvotes: number;
      requiredUpvotes: number;
      userVote: number;
      climbName?: string | null;
      frames?: string | null;
      layoutId?: number | null;
      climbSetterUsername?: string | null;
      climbDifficulty?: string | null;
      climbQualityAverage?: string | null;
      climbAscensionistCount?: number | null;
      climbDifficultyError?: string | null;
      climbBenchmarkDifficulty?: string | null;
      climbIsNoMatch?: boolean | null;
    }>;
  };
};

export type GetClimbClassicStatusQueryVariables = Exact<{
  climbUuid: Scalars['String']['input'];
  boardType: Scalars['String']['input'];
}>;

export type GetClimbClassicStatusQuery = {
  __typename?: 'Query';
  climbClassicStatus: {
    __typename?: 'ClimbClassicStatus';
    climbUuid: string;
    boardType: string;
    isClassic: boolean;
    updatedAt?: string | null;
  };
};

export type CreateProposalMutationVariables = Exact<{
  input: CreateProposalInput;
}>;

export type CreateProposalMutation = {
  __typename?: 'Mutation';
  createProposal: {
    __typename?: 'Proposal';
    uuid: string;
    climbUuid: string;
    boardType: string;
    angle?: number | null;
    proposerId: string;
    proposerDisplayName?: string | null;
    proposerAvatarUrl?: string | null;
    type: ProposalType;
    proposedValue: string;
    currentValue: string;
    status: ProposalStatus;
    reason?: string | null;
    createdAt: string;
    weightedUpvotes: number;
    weightedDownvotes: number;
    requiredUpvotes: number;
    userVote: number;
    climbName?: string | null;
    frames?: string | null;
    layoutId?: number | null;
    climbSetterUsername?: string | null;
    climbDifficulty?: string | null;
    climbQualityAverage?: string | null;
    climbAscensionistCount?: number | null;
    climbDifficultyError?: string | null;
    climbBenchmarkDifficulty?: string | null;
    climbIsNoMatch?: boolean | null;
  };
};

export type VoteOnProposalMutationVariables = Exact<{
  input: VoteOnProposalInput;
}>;

export type VoteOnProposalMutation = {
  __typename?: 'Mutation';
  voteOnProposal: {
    __typename?: 'Proposal';
    uuid: string;
    climbUuid: string;
    boardType: string;
    angle?: number | null;
    proposerId: string;
    proposerDisplayName?: string | null;
    proposerAvatarUrl?: string | null;
    type: ProposalType;
    proposedValue: string;
    currentValue: string;
    status: ProposalStatus;
    reason?: string | null;
    resolvedAt?: string | null;
    resolvedBy?: string | null;
    createdAt: string;
    weightedUpvotes: number;
    weightedDownvotes: number;
    requiredUpvotes: number;
    userVote: number;
    climbName?: string | null;
    frames?: string | null;
    layoutId?: number | null;
    climbSetterUsername?: string | null;
    climbDifficulty?: string | null;
    climbQualityAverage?: string | null;
    climbAscensionistCount?: number | null;
    climbDifficultyError?: string | null;
    climbBenchmarkDifficulty?: string | null;
    climbIsNoMatch?: boolean | null;
  };
};

export type ResolveProposalMutationVariables = Exact<{
  input: ResolveProposalInput;
}>;

export type ResolveProposalMutation = {
  __typename?: 'Mutation';
  resolveProposal: {
    __typename?: 'Proposal';
    uuid: string;
    status: ProposalStatus;
    resolvedAt?: string | null;
    resolvedBy?: string | null;
    weightedUpvotes: number;
    weightedDownvotes: number;
    requiredUpvotes: number;
    userVote: number;
    climbName?: string | null;
    frames?: string | null;
    layoutId?: number | null;
    climbSetterUsername?: string | null;
    climbDifficulty?: string | null;
    climbQualityAverage?: string | null;
    climbAscensionistCount?: number | null;
    climbDifficultyError?: string | null;
    climbBenchmarkDifficulty?: string | null;
    climbIsNoMatch?: boolean | null;
  };
};

export type DeleteProposalMutationVariables = Exact<{
  input: DeleteProposalInput;
}>;

export type DeleteProposalMutation = { __typename?: 'Mutation'; deleteProposal: boolean };

export type SetterOverrideCommunityStatusMutationVariables = Exact<{
  input: SetterOverrideInput;
}>;

export type SetterOverrideCommunityStatusMutation = {
  __typename?: 'Mutation';
  setterOverrideCommunityStatus: {
    __typename?: 'ClimbCommunityStatus';
    climbUuid: string;
    boardType: string;
    angle: number;
    communityGrade?: string | null;
    isBenchmark: boolean;
    isClassic: boolean;
    isFrozen: boolean;
    updatedAt?: string | null;
  };
};

export type FreezeClimbMutationVariables = Exact<{
  input: FreezeClimbInput;
}>;

export type FreezeClimbMutation = { __typename?: 'Mutation'; freezeClimb: boolean };

export type GetCommunityRolesQueryVariables = Exact<{
  boardType?: InputMaybe<Scalars['String']['input']>;
}>;

export type GetCommunityRolesQuery = {
  __typename?: 'Query';
  communityRoles: Array<{
    __typename?: 'CommunityRoleAssignment';
    id: number;
    userId: string;
    userDisplayName?: string | null;
    userAvatarUrl?: string | null;
    role: CommunityRoleType;
    boardType?: string | null;
    grantedBy?: string | null;
    grantedByDisplayName?: string | null;
    createdAt: string;
  }>;
};

export type GetMyRolesQueryVariables = Exact<{ [key: string]: never }>;

export type GetMyRolesQuery = {
  __typename?: 'Query';
  myRoles: Array<{
    __typename?: 'CommunityRoleAssignment';
    id: number;
    userId: string;
    role: CommunityRoleType;
    boardType?: string | null;
    createdAt: string;
  }>;
};

export type GrantRoleMutationVariables = Exact<{
  input: GrantRoleInput;
}>;

export type GrantRoleMutation = {
  __typename?: 'Mutation';
  grantRole: {
    __typename?: 'CommunityRoleAssignment';
    id: number;
    userId: string;
    userDisplayName?: string | null;
    userAvatarUrl?: string | null;
    role: CommunityRoleType;
    boardType?: string | null;
    grantedBy?: string | null;
    grantedByDisplayName?: string | null;
    createdAt: string;
  };
};

export type RevokeRoleMutationVariables = Exact<{
  input: RevokeRoleInput;
}>;

export type RevokeRoleMutation = { __typename?: 'Mutation'; revokeRole: boolean };

export type GetCommunitySettingsQueryVariables = Exact<{
  scope: Scalars['String']['input'];
  scopeKey: Scalars['String']['input'];
}>;

export type GetCommunitySettingsQuery = {
  __typename?: 'Query';
  communitySettings: Array<{
    __typename?: 'CommunitySetting';
    id: number;
    scope: string;
    scopeKey: string;
    key: string;
    value: string;
    setBy?: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type SetCommunitySettingsMutationVariables = Exact<{
  input: SetCommunitySettingInput;
}>;

export type SetCommunitySettingsMutation = {
  __typename?: 'Mutation';
  setCommunitySettings: {
    __typename?: 'CommunitySetting';
    id: number;
    scope: string;
    scopeKey: string;
    key: string;
    value: string;
    setBy?: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

export type SessionSummaryFieldsFragment = {
  __typename?: 'SessionSummary';
  sessionId: string;
  totalSends: number;
  totalAttempts: number;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMinutes?: number | null;
  goal?: string | null;
  gradeDistribution: Array<{ __typename?: 'SessionGradeCount'; grade: string; count: number }>;
  hardestClimb?: { __typename?: 'SessionHardestClimb'; climbUuid: string; climbName: string; grade: string } | null;
  participants: Array<{
    __typename?: 'SessionParticipant';
    userId: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    sends: number;
    attempts: number;
  }>;
};

export type EndSessionMutationVariables = Exact<{
  sessionId: Scalars['ID']['input'];
}>;

export type EndSessionMutation = {
  __typename?: 'Mutation';
  endSession?: {
    __typename?: 'SessionSummary';
    sessionId: string;
    totalSends: number;
    totalAttempts: number;
    startedAt?: string | null;
    endedAt?: string | null;
    durationMinutes?: number | null;
    goal?: string | null;
    gradeDistribution: Array<{ __typename?: 'SessionGradeCount'; grade: string; count: number }>;
    hardestClimb?: { __typename?: 'SessionHardestClimb'; climbUuid: string; climbName: string; grade: string } | null;
    participants: Array<{
      __typename?: 'SessionParticipant';
      userId: string;
      displayName?: string | null;
      avatarUrl?: string | null;
      sends: number;
      attempts: number;
    }>;
  } | null;
};

export type GetSessionSummaryQueryVariables = Exact<{
  sessionId: Scalars['ID']['input'];
}>;

export type GetSessionSummaryQuery = {
  __typename?: 'Query';
  sessionSummary?: {
    __typename?: 'SessionSummary';
    sessionId: string;
    totalSends: number;
    totalAttempts: number;
    startedAt?: string | null;
    endedAt?: string | null;
    durationMinutes?: number | null;
    goal?: string | null;
    gradeDistribution: Array<{ __typename?: 'SessionGradeCount'; grade: string; count: number }>;
    hardestClimb?: { __typename?: 'SessionHardestClimb'; climbUuid: string; climbName: string; grade: string } | null;
    participants: Array<{
      __typename?: 'SessionParticipant';
      userId: string;
      displayName?: string | null;
      avatarUrl?: string | null;
      sends: number;
      attempts: number;
    }>;
  } | null;
};

export type FollowUserMutationVariables = Exact<{
  input: FollowInput;
}>;

export type FollowUserMutation = { __typename?: 'Mutation'; followUser: boolean };

export type UnfollowUserMutationVariables = Exact<{
  input: FollowInput;
}>;

export type UnfollowUserMutation = { __typename?: 'Mutation'; unfollowUser: boolean };

export type GetPublicProfileQueryVariables = Exact<{
  userId: Scalars['ID']['input'];
}>;

export type GetPublicProfileQuery = {
  __typename?: 'Query';
  publicProfile?: {
    __typename?: 'PublicUserProfile';
    id: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    followerCount: number;
    followingCount: number;
    isFollowedByMe: boolean;
  } | null;
};

export type GetFollowersQueryVariables = Exact<{
  input: FollowListInput;
}>;

export type GetFollowersQuery = {
  __typename?: 'Query';
  followers: {
    __typename?: 'FollowConnection';
    totalCount: number;
    hasMore: boolean;
    users: Array<{
      __typename?: 'PublicUserProfile';
      id: string;
      displayName?: string | null;
      avatarUrl?: string | null;
      followerCount: number;
      followingCount: number;
      isFollowedByMe: boolean;
    }>;
  };
};

export type GetFollowingQueryVariables = Exact<{
  input: FollowListInput;
}>;

export type GetFollowingQuery = {
  __typename?: 'Query';
  following: {
    __typename?: 'FollowConnection';
    totalCount: number;
    hasMore: boolean;
    users: Array<{
      __typename?: 'PublicUserProfile';
      id: string;
      displayName?: string | null;
      avatarUrl?: string | null;
      followerCount: number;
      followingCount: number;
      isFollowedByMe: boolean;
    }>;
  };
};

export type IsFollowingQueryVariables = Exact<{
  userId: Scalars['ID']['input'];
}>;

export type IsFollowingQuery = { __typename?: 'Query'; isFollowing: boolean };

export type SearchUsersQueryVariables = Exact<{
  input: SearchUsersInput;
}>;

export type SearchUsersQuery = {
  __typename?: 'Query';
  searchUsers: {
    __typename?: 'UserSearchConnection';
    totalCount: number;
    hasMore: boolean;
    results: Array<{
      __typename?: 'UserSearchResult';
      recentAscentCount: number;
      matchReason?: string | null;
      user: {
        __typename?: 'PublicUserProfile';
        id: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        followerCount: number;
        followingCount: number;
        isFollowedByMe: boolean;
      };
    }>;
  };
};

export type GetFollowingAscentsFeedQueryVariables = Exact<{
  input?: InputMaybe<FollowingAscentsFeedInput>;
}>;

export type GetFollowingAscentsFeedQuery = {
  __typename?: 'Query';
  followingAscentsFeed: {
    __typename?: 'FollowingAscentsFeedResult';
    totalCount: number;
    hasMore: boolean;
    items: Array<{
      __typename?: 'FollowingAscentFeedItem';
      uuid: string;
      userId: string;
      userDisplayName?: string | null;
      userAvatarUrl?: string | null;
      climbUuid: string;
      climbName: string;
      setterUsername?: string | null;
      boardType: string;
      layoutId?: number | null;
      angle: number;
      isMirror: boolean;
      status: string;
      attemptCount: number;
      quality?: number | null;
      difficulty?: number | null;
      difficultyName?: string | null;
      isBenchmark: boolean;
      isNoMatch: boolean;
      comment: string;
      climbedAt: string;
      frames?: string | null;
    }>;
  };
};

export type GetGlobalAscentsFeedQueryVariables = Exact<{
  input?: InputMaybe<FollowingAscentsFeedInput>;
}>;

export type GetGlobalAscentsFeedQuery = {
  __typename?: 'Query';
  globalAscentsFeed: {
    __typename?: 'FollowingAscentsFeedResult';
    totalCount: number;
    hasMore: boolean;
    items: Array<{
      __typename?: 'FollowingAscentFeedItem';
      uuid: string;
      userId: string;
      userDisplayName?: string | null;
      userAvatarUrl?: string | null;
      climbUuid: string;
      climbName: string;
      setterUsername?: string | null;
      boardType: string;
      layoutId?: number | null;
      angle: number;
      isMirror: boolean;
      status: string;
      attemptCount: number;
      quality?: number | null;
      difficulty?: number | null;
      difficultyName?: string | null;
      isBenchmark: boolean;
      isNoMatch: boolean;
      comment: string;
      climbedAt: string;
      frames?: string | null;
    }>;
  };
};

export type GetFollowingClimbAscentsQueryVariables = Exact<{
  input: FollowingClimbAscentsInput;
}>;

export type GetFollowingClimbAscentsQuery = {
  __typename?: 'Query';
  followingClimbAscents: {
    __typename?: 'FollowingClimbAscentsResult';
    items: Array<{
      __typename?: 'FollowingAscentFeedItem';
      uuid: string;
      userId: string;
      userDisplayName?: string | null;
      userAvatarUrl?: string | null;
      climbUuid: string;
      angle: number;
      isMirror: boolean;
      status: string;
      attemptCount: number;
      quality?: number | null;
      comment: string;
      climbedAt: string;
      upvotes?: number | null;
      downvotes?: number | null;
      commentCount?: number | null;
    }>;
  };
};

export type FollowSetterMutationVariables = Exact<{
  input: FollowSetterInput;
}>;

export type FollowSetterMutation = { __typename?: 'Mutation'; followSetter: boolean };

export type UnfollowSetterMutationVariables = Exact<{
  input: FollowSetterInput;
}>;

export type UnfollowSetterMutation = { __typename?: 'Mutation'; unfollowSetter: boolean };

export type GetSetterProfileQueryVariables = Exact<{
  input: SetterProfileInput;
}>;

export type GetSetterProfileQuery = {
  __typename?: 'Query';
  setterProfile?: {
    __typename?: 'SetterProfile';
    username: string;
    climbCount: number;
    boardTypes: Array<string>;
    followerCount: number;
    isFollowedByMe: boolean;
    linkedUserId?: string | null;
    linkedUserDisplayName?: string | null;
    linkedUserAvatarUrl?: string | null;
  } | null;
};

export type GetSetterClimbsFullQueryVariables = Exact<{
  input: SetterClimbsFullInput;
}>;

export type GetSetterClimbsFullQuery = {
  __typename?: 'Query';
  setterClimbsFull: {
    __typename?: 'PlaylistClimbsResult';
    totalCount: number;
    hasMore: boolean;
    climbs: Array<{
      __typename?: 'Climb';
      uuid: string;
      layoutId?: number | null;
      boardType?: string | null;
      setter_username: string;
      name: string;
      description?: string | null;
      frames: string;
      angle: number;
      ascensionist_count: number;
      difficulty: string;
      quality_average: string;
      stars: number;
      difficulty_error: string;
      benchmark_difficulty?: string | null;
    }>;
  };
};

export type GetUserClimbsQueryVariables = Exact<{
  input: UserClimbsInput;
}>;

export type GetUserClimbsQuery = {
  __typename?: 'Query';
  userClimbs: {
    __typename?: 'PlaylistClimbsResult';
    totalCount: number;
    hasMore: boolean;
    climbs: Array<{
      __typename?: 'Climb';
      uuid: string;
      layoutId?: number | null;
      boardType?: string | null;
      setter_username: string;
      name: string;
      description?: string | null;
      frames: string;
      angle: number;
      ascensionist_count: number;
      difficulty: string;
      quality_average: string;
      stars: number;
      difficulty_error: string;
      benchmark_difficulty?: string | null;
    }>;
  };
};

export type SearchUsersAndSettersQueryVariables = Exact<{
  input: SearchUsersInput;
}>;

export type SearchUsersAndSettersQuery = {
  __typename?: 'Query';
  searchUsersAndSetters: {
    __typename?: 'UnifiedSearchConnection';
    totalCount: number;
    hasMore: boolean;
    results: Array<{
      __typename?: 'UnifiedSearchResult';
      recentAscentCount: number;
      matchReason?: string | null;
      user?: {
        __typename?: 'PublicUserProfile';
        id: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        followerCount: number;
        followingCount: number;
        isFollowedByMe: boolean;
      } | null;
      setter?: {
        __typename?: 'SetterSearchResult';
        username: string;
        climbCount: number;
        boardTypes: Array<string>;
        isFollowedByMe: boolean;
      } | null;
    }>;
  };
};

export type GetTicksQueryVariables = Exact<{
  input: GetTicksInput;
}>;

export type GetTicksQuery = {
  __typename?: 'Query';
  ticks: Array<{
    __typename?: 'Tick';
    uuid: string;
    climbUuid: string;
    angle: number;
    isMirror: boolean;
    status: TickStatus;
    attemptCount: number;
    quality?: number | null;
    difficulty?: number | null;
    isBenchmark: boolean;
    comment: string;
    climbedAt: string;
    upvotes?: number | null;
    downvotes?: number | null;
    commentCount?: number | null;
  }>;
};

export type GetUserTicksQueryVariables = Exact<{
  userId: Scalars['ID']['input'];
  boardType: Scalars['String']['input'];
}>;

export type GetUserTicksQuery = {
  __typename?: 'Query';
  userTicks: Array<{
    __typename?: 'Tick';
    climbUuid: string;
    angle: number;
    status: TickStatus;
    attemptCount: number;
    difficulty?: number | null;
    effectiveDifficulty?: number | null;
    climbedAt: string;
    layoutId?: number | null;
  }>;
};

export type SaveTickMutationVariables = Exact<{
  input: SaveTickInput;
}>;

export type SaveTickMutation = {
  __typename?: 'Mutation';
  saveTick: {
    __typename?: 'Tick';
    uuid: string;
    climbUuid: string;
    angle: number;
    isMirror: boolean;
    status: TickStatus;
    attemptCount: number;
    quality?: number | null;
    difficulty?: number | null;
    comment: string;
    climbedAt: string;
  };
};

export type DeleteTickMutationVariables = Exact<{
  uuid: Scalars['ID']['input'];
}>;

export type DeleteTickMutation = { __typename?: 'Mutation'; deleteTick: boolean };

export type GetUserAscentsFeedQueryVariables = Exact<{
  userId: Scalars['ID']['input'];
  input?: InputMaybe<AscentFeedInput>;
}>;

export type GetUserAscentsFeedQuery = {
  __typename?: 'Query';
  userAscentsFeed: {
    __typename?: 'AscentFeedResult';
    totalCount: number;
    hasMore: boolean;
    items: Array<{
      __typename?: 'AscentFeedItem';
      uuid: string;
      climbUuid: string;
      climbName: string;
      setterUsername?: string | null;
      boardType: string;
      layoutId?: number | null;
      angle: number;
      isMirror: boolean;
      status: TickStatus;
      attemptCount: number;
      quality?: number | null;
      difficulty?: number | null;
      difficultyName?: string | null;
      consensusDifficulty?: number | null;
      consensusDifficultyName?: string | null;
      qualityAverage?: number | null;
      isBenchmark: boolean;
      isNoMatch: boolean;
      comment: string;
      climbedAt: string;
      frames?: string | null;
    }>;
  };
};

export type GetUserGroupedAscentsFeedQueryVariables = Exact<{
  userId: Scalars['ID']['input'];
  input?: InputMaybe<AscentFeedInput>;
}>;

export type GetUserGroupedAscentsFeedQuery = {
  __typename?: 'Query';
  userGroupedAscentsFeed: {
    __typename?: 'GroupedAscentFeedResult';
    totalCount: number;
    hasMore: boolean;
    groups: Array<{
      __typename?: 'GroupedAscentFeedItem';
      key: string;
      climbUuid: string;
      climbName: string;
      setterUsername?: string | null;
      boardType: string;
      layoutId?: number | null;
      angle: number;
      isMirror: boolean;
      frames?: string | null;
      difficultyName?: string | null;
      isBenchmark: boolean;
      isNoMatch: boolean;
      date: string;
      flashCount: number;
      sendCount: number;
      attemptCount: number;
      bestQuality?: number | null;
      latestComment?: string | null;
      items: Array<{
        __typename?: 'AscentFeedItem';
        uuid: string;
        climbUuid: string;
        climbName: string;
        setterUsername?: string | null;
        boardType: string;
        layoutId?: number | null;
        angle: number;
        isMirror: boolean;
        status: TickStatus;
        attemptCount: number;
        quality?: number | null;
        difficulty?: number | null;
        difficultyName?: string | null;
        isBenchmark: boolean;
        isNoMatch: boolean;
        comment: string;
        climbedAt: string;
        frames?: string | null;
      }>;
    }>;
  };
};

export type GetUserProfileStatsQueryVariables = Exact<{
  userId: Scalars['ID']['input'];
}>;

export type GetUserProfileStatsQuery = {
  __typename?: 'Query';
  userProfileStats: {
    __typename?: 'ProfileStats';
    totalDistinctClimbs: number;
    layoutStats: Array<{
      __typename?: 'LayoutStats';
      layoutKey: string;
      boardType: string;
      layoutId?: number | null;
      distinctClimbCount: number;
      gradeCounts: Array<{ __typename?: 'GradeCount'; grade: string; count: number }>;
    }>;
  };
};

export type GetUserClimbPercentileQueryVariables = Exact<{
  userId: Scalars['ID']['input'];
}>;

export type GetUserClimbPercentileQuery = {
  __typename?: 'Query';
  userClimbPercentile: {
    __typename?: 'UserClimbPercentile';
    totalDistinctClimbs: number;
    percentile: number;
    totalActiveUsers: number;
  };
};

export type UpdateTickMutationVariables = Exact<{
  uuid: Scalars['ID']['input'];
  input: UpdateTickInput;
}>;

export type UpdateTickMutation = {
  __typename?: 'Mutation';
  updateTick: {
    __typename?: 'Tick';
    uuid: string;
    status: TickStatus;
    attemptCount: number;
    quality?: number | null;
    difficulty?: number | null;
    isBenchmark: boolean;
    comment: string;
    updatedAt: string;
  };
};

export const PlaylistFieldsFragmentDoc = {
  kind: 'Document',
  definitions: [
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'PlaylistFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Playlist' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
          { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
          { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'name' } },
          { kind: 'Field', name: { kind: 'Name', value: 'description' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
          { kind: 'Field', name: { kind: 'Name', value: 'color' } },
          { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
          { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastAccessedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'userRole' } },
          { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPinnedByMe' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<PlaylistFieldsFragment, unknown>;
export const SessionSummaryFieldsFragmentDoc = {
  kind: 'Document',
  definitions: [
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'SessionSummaryFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'SessionSummary' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'sessionId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'totalSends' } },
          { kind: 'Field', name: { kind: 'Name', value: 'totalAttempts' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'gradeDistribution' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'grade' } },
                { kind: 'Field', name: { kind: 'Name', value: 'count' } },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'hardestClimb' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'grade' } },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'participants' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'sends' } },
                { kind: 'Field', name: { kind: 'Name', value: 'attempts' } },
              ],
            },
          },
          { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'endedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'durationMinutes' } },
          { kind: 'Field', name: { kind: 'Name', value: 'goal' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SessionSummaryFieldsFragment, unknown>;
export const GetDeleteAccountInfoDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetDeleteAccountInfo' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deleteAccountInfo' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'Field', name: { kind: 'Name', value: 'publishedClimbCount' } }],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetDeleteAccountInfoQuery, GetDeleteAccountInfoQueryVariables>;
export const DeleteAccountDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'DeleteAccount' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'DeleteAccountInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deleteAccount' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DeleteAccountMutation, DeleteAccountMutationVariables>;
export const GetBetaLinksDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetBetaLinks' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'betaLinks' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'climbUuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'link' } },
                { kind: 'Field', name: { kind: 'Name', value: 'foreignUsername' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'thumbnail' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isListed' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetBetaLinksQuery, GetBetaLinksQueryVariables>;
export const AttachBetaLinkDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'AttachBetaLink' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'AttachBetaLinkInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'attachBetaLink' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<AttachBetaLinkMutation, AttachBetaLinkMutationVariables>;
export const GetRecentBetaLinksDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetRecentBetaLinks' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'recentBetaLinks' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'limit' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'betaLink' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'link' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'foreignUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'thumbnail' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isListed' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetRecentBetaLinksQuery, GetRecentBetaLinksQueryVariables>;
export const GetUserBetaLinksDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserBetaLinks' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userBetaLinks' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'limit' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'betaLink' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'link' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'foreignUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'thumbnail' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isListed' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserBetaLinksQuery, GetUserBetaLinksQueryVariables>;
export const ClimbStatsHistoryDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'ClimbStatsHistory' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardName' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'climbStatsHistory' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardName' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardName' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'climbUuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'ascensionistCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'qualityAverage' } },
                { kind: 'Field', name: { kind: 'Name', value: 'difficultyAverage' } },
                { kind: 'Field', name: { kind: 'Name', value: 'displayDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ClimbStatsHistoryQuery, ClimbStatsHistoryQueryVariables>;
export const GetGlobalCommentFeedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetGlobalCommentFeed' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'GlobalCommentFeedInput' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'globalCommentFeed' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'comments' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'parentCommentUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'body' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isDeleted' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'replyCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'voteScore' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
                { kind: 'Field', name: { kind: 'Name', value: 'cursor' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetGlobalCommentFeedQuery, GetGlobalCommentFeedQueryVariables>;
export const GetCommentsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetComments' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'CommentsInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'comments' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'comments' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'parentCommentUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'body' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isDeleted' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'replyCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'voteScore' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetCommentsQuery, GetCommentsQueryVariables>;
export const GetVoteSummaryDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetVoteSummary' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'entityType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'SocialEntityType' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'entityId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'voteSummary' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'entityType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'entityType' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'entityId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'entityId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'voteScore' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetVoteSummaryQuery, GetVoteSummaryQueryVariables>;
export const GetBulkVoteSummariesDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetBulkVoteSummaries' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'BulkVoteSummaryInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'bulkVoteSummaries' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'voteScore' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetBulkVoteSummariesQuery, GetBulkVoteSummariesQueryVariables>;
export const AddCommentDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'AddComment' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'AddCommentInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'addComment' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'parentCommentUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'body' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isDeleted' } },
                { kind: 'Field', name: { kind: 'Name', value: 'replyCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'voteScore' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<AddCommentMutation, AddCommentMutationVariables>;
export const UpdateCommentDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UpdateComment' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'UpdateCommentInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'updateComment' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'parentCommentUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'body' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isDeleted' } },
                { kind: 'Field', name: { kind: 'Name', value: 'replyCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'voteScore' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UpdateCommentMutation, UpdateCommentMutationVariables>;
export const DeleteCommentDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'DeleteComment' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'commentUuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deleteComment' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'commentUuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'commentUuid' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DeleteCommentMutation, DeleteCommentMutationVariables>;
export const VoteDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'Vote' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'VoteInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'vote' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'voteScore' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<VoteMutation, VoteMutationVariables>;
export const CreateSessionDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'CreateSession' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'CreateSessionInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'createSession' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardPath' } },
                { kind: 'Field', name: { kind: 'Name', value: 'goal' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isPermanent' } },
                { kind: 'Field', name: { kind: 'Name', value: 'color' } },
                { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<CreateSessionMutation, CreateSessionMutationVariables>;
export const FavoritesDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'Favorites' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardName' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuids' } },
          type: {
            kind: 'NonNullType',
            type: {
              kind: 'ListType',
              type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
            },
          },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'angle' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'favorites' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardName' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardName' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'climbUuids' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuids' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'angle' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'angle' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FavoritesQuery, FavoritesQueryVariables>;
export const ToggleFavoriteDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'ToggleFavorite' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'ToggleFavoriteInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'toggleFavorite' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'Field', name: { kind: 'Name', value: 'favorited' } }],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ToggleFavoriteMutation, ToggleFavoriteMutationVariables>;
export const UserFavoritesCountsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'UserFavoritesCounts' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userFavoritesCounts' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'boardName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'count' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UserFavoritesCountsQuery, UserFavoritesCountsQueryVariables>;
export const UserActiveBoardsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'UserActiveBoards' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [{ kind: 'Field', name: { kind: 'Name', value: 'userActiveBoards' } }],
      },
    },
  ],
} as unknown as DocumentNode<UserActiveBoardsQuery, UserActiveBoardsQueryVariables>;
export const GetUserFavoriteClimbsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserFavoriteClimbs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetUserFavoriteClimbsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userFavoriteClimbs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'climbs' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setter_username' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'description' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'ascensionist_count' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality_average' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stars' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty_error' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'benchmark_difficulty' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserFavoriteClimbsQuery, GetUserFavoriteClimbsQueryVariables>;
export const SubmitAppFeedbackDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'SubmitAppFeedback' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SubmitAppFeedbackInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'submitAppFeedback' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SubmitAppFeedbackMutation, SubmitAppFeedbackMutationVariables>;
export const GetNewClimbFeedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetNewClimbFeed' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'NewClimbFeedInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'newClimbFeed' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'items' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isNoMatch' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetNewClimbFeedQuery, GetNewClimbFeedQueryVariables>;
export const GetMyNewClimbSubscriptionsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetMyNewClimbSubscriptions' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'myNewClimbSubscriptions' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetMyNewClimbSubscriptionsQuery, GetMyNewClimbSubscriptionsQueryVariables>;
export const SubscribeNewClimbsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'SubscribeNewClimbs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'NewClimbSubscriptionInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'subscribeNewClimbs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SubscribeNewClimbsMutation, SubscribeNewClimbsMutationVariables>;
export const UnsubscribeNewClimbsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UnsubscribeNewClimbs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'NewClimbSubscriptionInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'unsubscribeNewClimbs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UnsubscribeNewClimbsMutation, UnsubscribeNewClimbsMutationVariables>;
export const OnNewClimbCreatedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'subscription',
      name: { kind: 'Name', value: 'OnNewClimbCreated' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'layoutId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'newClimbCreated' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'layoutId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'layoutId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'climb' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isNoMatch' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<OnNewClimbCreatedSubscription, OnNewClimbCreatedSubscriptionVariables>;
export const CheckMoonBoardClimbDuplicatesDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'CheckMoonBoardClimbDuplicates' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'CheckMoonBoardClimbDuplicatesInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'checkMoonBoardClimbDuplicates' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'clientKey' } },
                { kind: 'Field', name: { kind: 'Name', value: 'exists' } },
                { kind: 'Field', name: { kind: 'Name', value: 'existingClimbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'existingClimbName' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<CheckMoonBoardClimbDuplicatesQuery, CheckMoonBoardClimbDuplicatesQueryVariables>;
export const SimilarClimbsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'SimilarClimbs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SimilarClimbsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'similarClimbs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                { kind: 'Field', name: { kind: 'Name', value: 'setterUsername' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'qualityAverage' } },
                { kind: 'Field', name: { kind: 'Name', value: 'ascensionistCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'compatibleSizeIds' } },
                { kind: 'Field', name: { kind: 'Name', value: 'similarity' } },
                { kind: 'Field', name: { kind: 'Name', value: 'sharedHoldCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'candidateHoldCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'targetHoldCount' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SimilarClimbsQuery, SimilarClimbsQueryVariables>;
export const SaveClimbDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'SaveClimb' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'SaveClimbInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'saveClimb' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'synced' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'publishedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SaveClimbMutation, SaveClimbMutationVariables>;
export const SaveMoonBoardClimbDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'SaveMoonBoardClimb' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SaveMoonBoardClimbInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'saveMoonBoardClimb' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'synced' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'publishedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SaveMoonBoardClimbMutation, SaveMoonBoardClimbMutationVariables>;
export const UpdateClimbDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UpdateClimb' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'UpdateClimbInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'updateClimb' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'publishedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isDraft' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UpdateClimbMutation, UpdateClimbMutationVariables>;
export const DeleteDraftClimbDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'DeleteDraftClimb' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'uuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deleteDraftClimb' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'uuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'uuid' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DeleteDraftClimbMutation, DeleteDraftClimbMutationVariables>;
export const GetNotificationsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetNotifications' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'unreadOnly' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Boolean' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'offset' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'notifications' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'unreadOnly' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'unreadOnly' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'limit' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'offset' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'offset' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'notifications' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'actorId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'actorDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'actorAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'commentBody' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposalUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isRead' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'unreadCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetNotificationsQuery, GetNotificationsQueryVariables>;
export const GetGroupedNotificationsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetGroupedNotifications' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'offset' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'groupedNotifications' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'limit' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'limit' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'offset' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'offset' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'groups' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'entityId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'actorCount' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'actors' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                          ],
                        },
                      },
                      { kind: 'Field', name: { kind: 'Name', value: 'commentBody' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposalUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isRead' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'unreadCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetGroupedNotificationsQuery, GetGroupedNotificationsQueryVariables>;
export const GetUnreadNotificationCountDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUnreadNotificationCount' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [{ kind: 'Field', name: { kind: 'Name', value: 'unreadNotificationCount' } }],
      },
    },
  ],
} as unknown as DocumentNode<GetUnreadNotificationCountQuery, GetUnreadNotificationCountQueryVariables>;
export const MarkNotificationReadDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'MarkNotificationRead' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'notificationUuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'markNotificationRead' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'notificationUuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'notificationUuid' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<MarkNotificationReadMutation, MarkNotificationReadMutationVariables>;
export const MarkGroupNotificationsReadDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'MarkGroupNotificationsRead' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'type' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'NotificationType' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'entityType' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'SocialEntityType' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'entityId' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'markGroupNotificationsRead' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'type' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'type' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'entityType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'entityType' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'entityId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'entityId' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<MarkGroupNotificationsReadMutation, MarkGroupNotificationsReadMutationVariables>;
export const MarkAllNotificationsReadDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'MarkAllNotificationsRead' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [{ kind: 'Field', name: { kind: 'Name', value: 'markAllNotificationsRead' } }],
      },
    },
  ],
} as unknown as DocumentNode<MarkAllNotificationsReadMutation, MarkAllNotificationsReadMutationVariables>;
export const GetUserPlaylistsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserPlaylists' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetUserPlaylistsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userPlaylists' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'PlaylistFields' } }],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'PlaylistFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Playlist' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
          { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
          { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'name' } },
          { kind: 'Field', name: { kind: 'Name', value: 'description' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
          { kind: 'Field', name: { kind: 'Name', value: 'color' } },
          { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
          { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastAccessedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'userRole' } },
          { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPinnedByMe' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserPlaylistsQuery, GetUserPlaylistsQueryVariables>;
export const GetAllUserPlaylistsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetAllUserPlaylists' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetAllUserPlaylistsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'allUserPlaylists' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'playlists' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'PlaylistFields' } }],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'PlaylistFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Playlist' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
          { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
          { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'name' } },
          { kind: 'Field', name: { kind: 'Name', value: 'description' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
          { kind: 'Field', name: { kind: 'Name', value: 'color' } },
          { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
          { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastAccessedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'userRole' } },
          { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPinnedByMe' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetAllUserPlaylistsQuery, GetAllUserPlaylistsQueryVariables>;
export const GetMyPinnedPlaylistsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetMyPinnedPlaylists' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetMyPinnedPlaylistsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'myPinnedPlaylists' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'PlaylistFields' } }],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'PlaylistFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Playlist' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
          { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
          { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'name' } },
          { kind: 'Field', name: { kind: 'Name', value: 'description' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
          { kind: 'Field', name: { kind: 'Name', value: 'color' } },
          { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
          { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastAccessedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'userRole' } },
          { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPinnedByMe' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetMyPinnedPlaylistsQuery, GetMyPinnedPlaylistsQueryVariables>;
export const PinPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'PinPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'PinPlaylistInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'pinPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<PinPlaylistMutation, PinPlaylistMutationVariables>;
export const UnpinPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UnpinPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'PinPlaylistInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'unpinPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UnpinPlaylistMutation, UnpinPlaylistMutationVariables>;
export const GetPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'playlistId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'playlist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'playlistId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'playlistId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'PlaylistFields' } }],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'PlaylistFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Playlist' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
          { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
          { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'name' } },
          { kind: 'Field', name: { kind: 'Name', value: 'description' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
          { kind: 'Field', name: { kind: 'Name', value: 'color' } },
          { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
          { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastAccessedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'userRole' } },
          { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPinnedByMe' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetPlaylistQuery, GetPlaylistQueryVariables>;
export const GetPlaylistsForClimbDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetPlaylistsForClimb' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetPlaylistsForClimbInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'playlistsForClimb' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetPlaylistsForClimbQuery, GetPlaylistsForClimbQueryVariables>;
export const GetPlaylistsForClimbsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetPlaylistsForClimbs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetPlaylistsForClimbsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'playlistsForClimbs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'playlistUuids' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetPlaylistsForClimbsQuery, GetPlaylistsForClimbsQueryVariables>;
export const CreatePlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'CreatePlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'CreatePlaylistInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'createPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'PlaylistFields' } }],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'PlaylistFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Playlist' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
          { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
          { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'name' } },
          { kind: 'Field', name: { kind: 'Name', value: 'description' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
          { kind: 'Field', name: { kind: 'Name', value: 'color' } },
          { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
          { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastAccessedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'userRole' } },
          { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPinnedByMe' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<CreatePlaylistMutation, CreatePlaylistMutationVariables>;
export const UpdatePlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UpdatePlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'UpdatePlaylistInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'updatePlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'PlaylistFields' } }],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'PlaylistFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Playlist' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
          { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
          { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'name' } },
          { kind: 'Field', name: { kind: 'Name', value: 'description' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPublic' } },
          { kind: 'Field', name: { kind: 'Name', value: 'color' } },
          { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
          { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastAccessedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'userRole' } },
          { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
          { kind: 'Field', name: { kind: 'Name', value: 'isPinnedByMe' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UpdatePlaylistMutation, UpdatePlaylistMutationVariables>;
export const DeletePlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'DeletePlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'playlistId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deletePlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'playlistId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'playlistId' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DeletePlaylistMutation, DeletePlaylistMutationVariables>;
export const AddClimbToPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'AddClimbToPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'AddClimbToPlaylistInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'addClimbToPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'playlistId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'position' } },
                { kind: 'Field', name: { kind: 'Name', value: 'addedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<AddClimbToPlaylistMutation, AddClimbToPlaylistMutationVariables>;
export const RemoveClimbFromPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'RemoveClimbFromPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'RemoveClimbFromPlaylistInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'removeClimbFromPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<RemoveClimbFromPlaylistMutation, RemoveClimbFromPlaylistMutationVariables>;
export const GetPlaylistClimbsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetPlaylistClimbs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetPlaylistClimbsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'playlistClimbs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'climbs' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setter_username' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'description' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'ascensionist_count' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality_average' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stars' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty_error' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'benchmark_difficulty' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetPlaylistClimbsQuery, GetPlaylistClimbsQueryVariables>;
export const DiscoverPlaylistsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'DiscoverPlaylists' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'DiscoverPlaylistsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'discoverPlaylists' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'playlists' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'description' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'color' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'creatorId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'creatorName' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DiscoverPlaylistsQuery, DiscoverPlaylistsQueryVariables>;
export const GetPlaylistCreatorsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetPlaylistCreators' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetPlaylistCreatorsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'playlistCreators' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'playlistCount' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetPlaylistCreatorsQuery, GetPlaylistCreatorsQueryVariables>;
export const UpdatePlaylistLastAccessedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UpdatePlaylistLastAccessed' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'playlistId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'updatePlaylistLastAccessed' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'playlistId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'playlistId' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UpdatePlaylistLastAccessedMutation, UpdatePlaylistLastAccessedMutationVariables>;
export const SearchPlaylistsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'SearchPlaylists' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SearchPlaylistsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'searchPlaylists' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'playlists' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'description' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'color' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'icon' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'creatorId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'creatorName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SearchPlaylistsQuery, SearchPlaylistsQueryVariables>;
export const FollowPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'FollowPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowPlaylistInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'followPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FollowPlaylistMutation, FollowPlaylistMutationVariables>;
export const UnfollowPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UnfollowPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowPlaylistInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'unfollowPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UnfollowPlaylistMutation, UnfollowPlaylistMutationVariables>;
export const GetSmartPlaylistDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetSmartPlaylist' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetSmartPlaylistInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'smartPlaylist' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'meta' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userAvatar' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
                    ],
                  },
                },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'climbs' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setter_username' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'description' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'ascensionist_count' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality_average' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stars' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty_error' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'benchmark_difficulty' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetSmartPlaylistQuery, GetSmartPlaylistQueryVariables>;
export const GetMySmartPlaylistCountsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetMySmartPlaylistCounts' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'mySmartPlaylistCounts' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                { kind: 'Field', name: { kind: 'Name', value: 'count' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetMySmartPlaylistCountsQuery, GetMySmartPlaylistCountsQueryVariables>;
export const GetClimbProposalsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetClimbProposals' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetClimbProposalsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'climbProposals' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'proposals' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposerId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposerDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposerAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposedValue' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'currentValue' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'resolvedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'resolvedBy' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'weightedUpvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'weightedDownvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'requiredUpvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbSetterUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbDifficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbQualityAverage' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbAscensionistCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbDifficultyError' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbBenchmarkDifficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbIsNoMatch' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetClimbProposalsQuery, GetClimbProposalsQueryVariables>;
export const GetClimbCommunityStatusDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetClimbCommunityStatus' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'angle' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'climbCommunityStatus' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'climbUuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'angle' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'angle' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'communityGrade' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isClassic' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isFrozen' } },
                { kind: 'Field', name: { kind: 'Name', value: 'freezeReason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'openProposalCount' } },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'outlierAnalysis' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'isOutlier' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'currentGrade' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'neighborAverage' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'neighborCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'gradeDifference' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetClimbCommunityStatusQuery, GetClimbCommunityStatusQueryVariables>;
export const GetBulkClimbCommunityStatusDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetBulkClimbCommunityStatus' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuids' } },
          type: {
            kind: 'NonNullType',
            type: {
              kind: 'ListType',
              type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
            },
          },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'angle' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'bulkClimbCommunityStatus' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'climbUuids' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuids' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'angle' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'angle' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'communityGrade' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isClassic' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isFrozen' } },
                { kind: 'Field', name: { kind: 'Name', value: 'freezeReason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'openProposalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetBulkClimbCommunityStatusQuery, GetBulkClimbCommunityStatusQueryVariables>;
export const BrowseProposalsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'BrowseProposals' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'BrowseProposalsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'browseProposals' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'proposals' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposerId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposerDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposerAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'proposedValue' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'currentValue' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'resolvedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'resolvedBy' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'weightedUpvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'weightedDownvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'requiredUpvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbSetterUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbDifficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbQualityAverage' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbAscensionistCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbDifficultyError' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbBenchmarkDifficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbIsNoMatch' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<BrowseProposalsQuery, BrowseProposalsQueryVariables>;
export const GetClimbClassicStatusDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetClimbClassicStatus' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'climbClassicStatus' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'climbUuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'climbUuid' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isClassic' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetClimbClassicStatusQuery, GetClimbClassicStatusQueryVariables>;
export const CreateProposalDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'CreateProposal' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'CreateProposalInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'createProposal' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposerId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposerDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposerAvatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposedValue' } },
                { kind: 'Field', name: { kind: 'Name', value: 'currentValue' } },
                { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'weightedUpvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'weightedDownvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'requiredUpvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbSetterUsername' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbQualityAverage' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbAscensionistCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbDifficultyError' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbBenchmarkDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbIsNoMatch' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<CreateProposalMutation, CreateProposalMutationVariables>;
export const VoteOnProposalDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'VoteOnProposal' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'VoteOnProposalInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'voteOnProposal' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposerId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposerDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposerAvatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'type' } },
                { kind: 'Field', name: { kind: 'Name', value: 'proposedValue' } },
                { kind: 'Field', name: { kind: 'Name', value: 'currentValue' } },
                { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'resolvedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'resolvedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'weightedUpvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'weightedDownvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'requiredUpvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbSetterUsername' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbQualityAverage' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbAscensionistCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbDifficultyError' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbBenchmarkDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbIsNoMatch' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<VoteOnProposalMutation, VoteOnProposalMutationVariables>;
export const ResolveProposalDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'ResolveProposal' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'ResolveProposalInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'resolveProposal' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                { kind: 'Field', name: { kind: 'Name', value: 'resolvedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'resolvedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'weightedUpvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'weightedDownvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'requiredUpvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userVote' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbSetterUsername' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbQualityAverage' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbAscensionistCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbDifficultyError' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbBenchmarkDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbIsNoMatch' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ResolveProposalMutation, ResolveProposalMutationVariables>;
export const DeleteProposalDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'DeleteProposal' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'DeleteProposalInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deleteProposal' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DeleteProposalMutation, DeleteProposalMutationVariables>;
export const SetterOverrideCommunityStatusDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'SetterOverrideCommunityStatus' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SetterOverrideInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'setterOverrideCommunityStatus' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'communityGrade' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isClassic' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isFrozen' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SetterOverrideCommunityStatusMutation, SetterOverrideCommunityStatusMutationVariables>;
export const FreezeClimbDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'FreezeClimb' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'FreezeClimbInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'freezeClimb' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FreezeClimbMutation, FreezeClimbMutationVariables>;
export const GetCommunityRolesDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetCommunityRoles' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'communityRoles' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'role' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'grantedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'grantedByDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetCommunityRolesQuery, GetCommunityRolesQueryVariables>;
export const GetMyRolesDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetMyRoles' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'myRoles' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'role' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetMyRolesQuery, GetMyRolesQueryVariables>;
export const GrantRoleDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'GrantRole' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'GrantRoleInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'grantRole' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'role' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                { kind: 'Field', name: { kind: 'Name', value: 'grantedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'grantedByDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GrantRoleMutation, GrantRoleMutationVariables>;
export const RevokeRoleDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'RevokeRole' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'RevokeRoleInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'revokeRole' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<RevokeRoleMutation, RevokeRoleMutationVariables>;
export const GetCommunitySettingsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetCommunitySettings' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'scope' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'scopeKey' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'communitySettings' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'scope' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'scope' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'scopeKey' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'scopeKey' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'scope' } },
                { kind: 'Field', name: { kind: 'Name', value: 'scopeKey' } },
                { kind: 'Field', name: { kind: 'Name', value: 'key' } },
                { kind: 'Field', name: { kind: 'Name', value: 'value' } },
                { kind: 'Field', name: { kind: 'Name', value: 'setBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetCommunitySettingsQuery, GetCommunitySettingsQueryVariables>;
export const SetCommunitySettingsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'SetCommunitySettings' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SetCommunitySettingInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'setCommunitySettings' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'scope' } },
                { kind: 'Field', name: { kind: 'Name', value: 'scopeKey' } },
                { kind: 'Field', name: { kind: 'Name', value: 'key' } },
                { kind: 'Field', name: { kind: 'Name', value: 'value' } },
                { kind: 'Field', name: { kind: 'Name', value: 'setBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'createdAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SetCommunitySettingsMutation, SetCommunitySettingsMutationVariables>;
export const EndSessionDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'EndSession' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'sessionId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'endSession' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'sessionId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'sessionId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'SessionSummaryFields' } }],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'SessionSummaryFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'SessionSummary' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'sessionId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'totalSends' } },
          { kind: 'Field', name: { kind: 'Name', value: 'totalAttempts' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'gradeDistribution' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'grade' } },
                { kind: 'Field', name: { kind: 'Name', value: 'count' } },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'hardestClimb' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'grade' } },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'participants' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'sends' } },
                { kind: 'Field', name: { kind: 'Name', value: 'attempts' } },
              ],
            },
          },
          { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'endedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'durationMinutes' } },
          { kind: 'Field', name: { kind: 'Name', value: 'goal' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<EndSessionMutation, EndSessionMutationVariables>;
export const GetSessionSummaryDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetSessionSummary' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'sessionId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'sessionSummary' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'sessionId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'sessionId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'SessionSummaryFields' } }],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'SessionSummaryFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'SessionSummary' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'sessionId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'totalSends' } },
          { kind: 'Field', name: { kind: 'Name', value: 'totalAttempts' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'gradeDistribution' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'grade' } },
                { kind: 'Field', name: { kind: 'Name', value: 'count' } },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'hardestClimb' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'grade' } },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'participants' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'sends' } },
                { kind: 'Field', name: { kind: 'Name', value: 'attempts' } },
              ],
            },
          },
          { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'endedAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'durationMinutes' } },
          { kind: 'Field', name: { kind: 'Name', value: 'goal' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetSessionSummaryQuery, GetSessionSummaryQueryVariables>;
export const FollowUserDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'FollowUser' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'followUser' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FollowUserMutation, FollowUserMutationVariables>;
export const UnfollowUserDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UnfollowUser' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'unfollowUser' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UnfollowUserMutation, UnfollowUserMutationVariables>;
export const GetPublicProfileDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetPublicProfile' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'publicProfile' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'followingCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetPublicProfileQuery, GetPublicProfileQueryVariables>;
export const GetFollowersDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetFollowers' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowListInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'followers' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'users' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'followingCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetFollowersQuery, GetFollowersQueryVariables>;
export const GetFollowingDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetFollowing' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowListInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'following' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'users' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'followingCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetFollowingQuery, GetFollowingQueryVariables>;
export const IsFollowingDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'IsFollowing' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'isFollowing' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<IsFollowingQuery, IsFollowingQueryVariables>;
export const SearchUsersDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'SearchUsers' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'SearchUsersInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'searchUsers' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'results' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'user' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'followingCount' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
                          ],
                        },
                      },
                      { kind: 'Field', name: { kind: 'Name', value: 'recentAscentCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'matchReason' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SearchUsersQuery, SearchUsersQueryVariables>;
export const GetFollowingAscentsFeedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetFollowingAscentsFeed' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowingAscentsFeedInput' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'followingAscentsFeed' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'items' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isNoMatch' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetFollowingAscentsFeedQuery, GetFollowingAscentsFeedQueryVariables>;
export const GetGlobalAscentsFeedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetGlobalAscentsFeed' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowingAscentsFeedInput' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'globalAscentsFeed' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'items' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isNoMatch' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetGlobalAscentsFeedQuery, GetGlobalAscentsFeedQueryVariables>;
export const GetFollowingClimbAscentsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetFollowingClimbAscents' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowingClimbAscentsInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'followingClimbAscents' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'items' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userDisplayName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'userAvatarUrl' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'commentCount' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetFollowingClimbAscentsQuery, GetFollowingClimbAscentsQueryVariables>;
export const FollowSetterDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'FollowSetter' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowSetterInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'followSetter' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FollowSetterMutation, FollowSetterMutationVariables>;
export const UnfollowSetterDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UnfollowSetter' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'FollowSetterInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'unfollowSetter' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UnfollowSetterMutation, UnfollowSetterMutationVariables>;
export const GetSetterProfileDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetSetterProfile' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SetterProfileInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'setterProfile' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'username' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'boardTypes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
                { kind: 'Field', name: { kind: 'Name', value: 'linkedUserId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'linkedUserDisplayName' } },
                { kind: 'Field', name: { kind: 'Name', value: 'linkedUserAvatarUrl' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetSetterProfileQuery, GetSetterProfileQueryVariables>;
export const GetSetterClimbsFullDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetSetterClimbsFull' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'SetterClimbsFullInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'setterClimbsFull' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'climbs' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setter_username' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'description' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'ascensionist_count' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality_average' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stars' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty_error' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'benchmark_difficulty' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetSetterClimbsFullQuery, GetSetterClimbsFullQueryVariables>;
export const GetUserClimbsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserClimbs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'UserClimbsInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userClimbs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'climbs' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setter_username' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'description' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'ascensionist_count' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality_average' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stars' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty_error' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'benchmark_difficulty' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserClimbsQuery, GetUserClimbsQueryVariables>;
export const SearchUsersAndSettersDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'SearchUsersAndSetters' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'SearchUsersInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'searchUsersAndSetters' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'results' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'user' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'displayName' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'avatarUrl' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'followerCount' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'followingCount' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'setter' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'username' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'climbCount' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'boardTypes' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'isFollowedByMe' } },
                          ],
                        },
                      },
                      { kind: 'Field', name: { kind: 'Name', value: 'recentAscentCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'matchReason' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SearchUsersAndSettersQuery, SearchUsersAndSettersQueryVariables>;
export const GetTicksDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetTicks' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'GetTicksInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'ticks' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'upvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'downvotes' } },
                { kind: 'Field', name: { kind: 'Name', value: 'commentCount' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetTicksQuery, GetTicksQueryVariables>;
export const GetUserTicksDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserTicks' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userTicks' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'boardType' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'boardType' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'effectiveDifficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserTicksQuery, GetUserTicksQueryVariables>;
export const SaveTickDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'SaveTick' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'SaveTickInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'saveTick' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SaveTickMutation, SaveTickMutationVariables>;
export const DeleteTickDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'DeleteTick' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'uuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deleteTick' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'uuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'uuid' } },
              },
            ],
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DeleteTickMutation, DeleteTickMutationVariables>;
export const GetUserAscentsFeedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserAscentsFeed' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'AscentFeedInput' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userAscentsFeed' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'items' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'consensusDifficulty' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'consensusDifficultyName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'qualityAverage' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isNoMatch' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserAscentsFeedQuery, GetUserAscentsFeedQueryVariables>;
export const GetUserGroupedAscentsFeedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserGroupedAscentsFeed' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'AscentFeedInput' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userGroupedAscentsFeed' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'groups' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'key' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'setterUsername' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'isNoMatch' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'date' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'flashCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'sendCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'bestQuality' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'latestComment' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'items' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'climbUuid' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'climbName' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'setterUsername' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'angle' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'isMirror' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'difficultyName' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'isNoMatch' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'climbedAt' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'frames' } },
                          ],
                        },
                      },
                    ],
                  },
                },
                { kind: 'Field', name: { kind: 'Name', value: 'totalCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'hasMore' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserGroupedAscentsFeedQuery, GetUserGroupedAscentsFeedQueryVariables>;
export const GetUserProfileStatsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserProfileStats' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userProfileStats' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'totalDistinctClimbs' } },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'layoutStats' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutKey' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'boardType' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'layoutId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'distinctClimbCount' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'gradeCounts' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'grade' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'count' } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserProfileStatsQuery, GetUserProfileStatsQueryVariables>;
export const GetUserClimbPercentileDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'GetUserClimbPercentile' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'userClimbPercentile' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'userId' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'userId' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'totalDistinctClimbs' } },
                { kind: 'Field', name: { kind: 'Name', value: 'percentile' } },
                { kind: 'Field', name: { kind: 'Name', value: 'totalActiveUsers' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GetUserClimbPercentileQuery, GetUserClimbPercentileQueryVariables>;
export const UpdateTickDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'UpdateTick' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'uuid' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: { kind: 'NonNullType', type: { kind: 'NamedType', name: { kind: 'Name', value: 'UpdateTickInput' } } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'updateTick' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'uuid' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'uuid' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'uuid' } },
                { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                { kind: 'Field', name: { kind: 'Name', value: 'attemptCount' } },
                { kind: 'Field', name: { kind: 'Name', value: 'quality' } },
                { kind: 'Field', name: { kind: 'Name', value: 'difficulty' } },
                { kind: 'Field', name: { kind: 'Name', value: 'isBenchmark' } },
                { kind: 'Field', name: { kind: 'Name', value: 'comment' } },
                { kind: 'Field', name: { kind: 'Name', value: 'updatedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<UpdateTickMutation, UpdateTickMutationVariables>;
