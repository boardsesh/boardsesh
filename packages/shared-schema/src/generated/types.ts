/* eslint-disable */
import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
import { ConnectionContext } from '../types';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
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

/** A single entry in a board's chronological send log. */
export type BoardHistoryEntry = {
  __typename?: 'BoardHistoryEntry';
  angle: Scalars['Int']['output'];
  /** Best-effort link to a saved userBoards row; null for unregistered boards */
  boardId?: Maybe<Scalars['ID']['output']>;
  /** Canonical room key — BLE serial of the controller the climb was sent to */
  boardSerial: Scalars['String']['output'];
  climbUuid: Scalars['ID']['output'];
  /** Surrogate PK of the underlying row */
  id: Scalars['ID']['output'];
  isMirror: Scalars['Boolean']['output'];
  /** ISO 8601 timestamp when the send occurred */
  sentAt: Scalars['String']['output'];
  /** Monotonic per-board_serial sequence (allocated by board_history_sequences) */
  sequence: Scalars['Int']['output'];
  /** Party session active at send time, if any */
  sessionId?: Maybe<Scalars['ID']['output']>;
  source: BoardHistorySource;
  /** Stable user ID of the BLE-connected sender */
  userId: Scalars['ID']['output'];
  /** Display name of the sender at write time (best-effort lookup from users) */
  username?: Maybe<Scalars['String']['output']>;
  /** Client-generated idempotency key; same logical send shares one uuid across retries */
  uuid: Scalars['ID']['output'];
};

/** Incremental event emitted whenever a new entry is appended to the log. */
export type BoardHistoryEntryAdded = {
  __typename?: 'BoardHistoryEntryAdded';
  entry: BoardHistoryEntry;
  sequence: Scalars['Int']['output'];
};

/** Union of possible board-history events. */
export type BoardHistoryEvent = BoardHistoryEntryAdded | BoardHistoryFullSync;

/**
 * Full sync emitted on initial subscription. Carries the most recent N entries
 * in reverse-chronological order and the highest sequence the client has seen.
 */
export type BoardHistoryFullSync = {
  __typename?: 'BoardHistoryFullSync';
  entries: Array<BoardHistoryEntry>;
  sequence: Scalars['Int']['output'];
};

/**
 * Source of a board history entry. `BLE_SEND` is the MVP source emitted when
 * the BLE-connected user successfully sends a climb to the board. The other
 * variants are reserved for future surfaces (manual log entries, or a relay
 * of a shared-playlist current-climb change when no BLE user is paired).
 */
export type BoardHistorySource = 'BLE_SEND' | 'MANUAL' | 'SHARED_QUEUE_RELAY';

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

/**
 * Slim view of a board_sessions row returned by setSharedPlaylistEnabled.
 * Distinct from `Session` — only carries the fields a client needs to react
 * to a shared-playlist toggle without joining the room state.
 */
export type BoardSession = {
  __typename?: 'BoardSession';
  boardPath: Scalars['String']['output'];
  /** ISO 8601 timestamp */
  endedAt?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name?: Maybe<Scalars['String']['output']>;
  sharedPlaylistEnabled: Scalars['Boolean']['output'];
  /** ISO 8601 timestamp */
  startedAt?: Maybe<Scalars['String']['output']>;
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
   * Record that a climb was sent to a physical board. Called by the BLE
   * client after a successful send. The `uuid` field is the idempotency key
   * — repeated calls with the same uuid return the previously persisted row
   * and do not emit a second event.
   */
  recordBoardSend: BoardHistoryEntry;
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
   * Record the BLE board serial that this client paired with so other (mobile)
   * participants can auto-connect to the same physical board. Any session participant
   * may call. Idempotent: when the stored serial already matches, no event fires.
   * Publishes `SessionBoardSerialChanged` on change. Returns the resolved Session for
   * optimistic-UI symmetry with `takeControl` / `releaseControl`. Session identity is
   * resolved from the WebSocket connection context — no `sessionId` argument is required.
   */
  setSessionBoardSerial: Session;
  /**
   * Toggle the shared-playlist queue model for a session. When disabled,
   * queue mutations are rejected server-side and clients fall back to local
   * IDB queues; board history still streams normally. Restricted to the
   * session leader.
   */
  setSharedPlaylistEnabled: BoardSession;
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
export type MutationRecordBoardSendArgs = {
  input: RecordBoardSendInput;
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
export type MutationSetSessionBoardSerialArgs = {
  serial: Scalars['String']['input'];
};

/** Root mutation type for all write operations. */
export type MutationSetSharedPlaylistEnabledArgs = {
  enabled: Scalars['Boolean']['input'];
  sessionId: Scalars['ID']['input'];
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
  /**
   * Fetch board history entries for a serial in reverse chronological order.
   * Soft-gated on the caller being paired to the board (has a userBoardSerials
   * row for the serial). The optional `before` cursor accepts an ISO 8601
   * timestamp.
   */
  boardHistory: Array<BoardHistoryEntry>;
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
export type QueryBoardHistoryArgs = {
  before?: InputMaybe<Scalars['String']['input']>;
  boardSerial: Scalars['String']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
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
export type QuerySimilarClimbsArgs = {
  input: SimilarClimbsInput;
};

/** Root query type for all read operations. */
export type QuerySmartPlaylistArgs = {
  input: GetSmartPlaylistInput;
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
};

/**
 * Input for the `recordBoardSend` mutation. `uuid` is the idempotency key
 * (matches the boardsesh_ticks.uuid precedent — server trusts client uuid and
 * does ON CONFLICT (uuid) DO NOTHING).
 */
export type RecordBoardSendInput = {
  angle: Scalars['Int']['input'];
  boardId?: InputMaybe<Scalars['ID']['input']>;
  boardSerial: Scalars['String']['input'];
  climbUuid: Scalars['ID']['input'];
  frames?: InputMaybe<Scalars['String']['input']>;
  isMirror?: InputMaybe<Scalars['Boolean']['input']>;
  sessionId?: InputMaybe<Scalars['ID']['input']>;
  /** Was the shared-playlist queue active at send time? Recorded for attribution. */
  sharedPlaylistMode: Scalars['Boolean']['input'];
  source: BoardHistorySource;
  uuid: Scalars['ID']['input'];
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
  /** Whether the session's shared playlist queue is active. When false, queue mutations are rejected server-side and each client falls back to a local IndexedDB queue. Board history streams independently of this flag. */
  sharedPlaylistEnabled: Scalars['Boolean']['output'];
  /** When the session was started (ISO 8601) */
  startedAt?: Maybe<Scalars['String']['output']>;
  /** Users currently in the session */
  users: Array<SessionUser>;
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
  | SessionBoardSerialChanged
  | SessionEnded
  | SessionStatsUpdated
  | SharedPlaylistToggled
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
 * Event when the shared-playlist (shared queue) mode is toggled on or off.
 * Sent to all session subscribers so peers can re-route their queue
 * mutations between WS (shared) and local IDB (local-only) without
 * reconnecting.
 */
export type SharedPlaylistToggled = {
  __typename?: 'SharedPlaylistToggled';
  /** New value of shared_playlist_enabled */
  enabled: Scalars['Boolean']['output'];
  /** Session ID this toggle belongs to */
  sessionId: Scalars['ID']['output'];
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
 * A computed playlist generated from a user's logbook.
 * - FIVE_STARS: climbs the user has rated 5/5
 * - MOST_REPEATED: climbs the user has logged the most attempts on
 * - PROJECTS: climbs with the most attempts that have never been sent
 */
export type SmartPlaylistType = 'FIVE_STARS' | 'MOST_REPEATED' | 'PROJECTS';

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
  /**
   * Subscribe to board history events for a physical board (keyed by BLE
   * serial). On subscribe, the server yields a BoardHistoryFullSync followed
   * by BoardHistoryEntryAdded for each new send. Soft-gated on the caller
   * having a userBoardSerials row for the serial.
   */
  boardHistoryEvents: BoardHistoryEvent;
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
export type SubscriptionBoardHistoryEventsArgs = {
  boardSerial: Scalars['String']['input'];
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

export type WithIndex<TObject> = TObject & Record<string, any>;
export type ResolversObject<TObject> = WithIndex<TObject>;

export type ResolverTypeWrapper<T> = Promise<T> | T;

export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = {}, TContext = {}, TArgs = {}> =
  | ResolverFn<TResult, TParent, TContext, TArgs>
  | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = {}, TContext = {}, TArgs = {}> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = {}, TContext = {}> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo,
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = {}, TContext = {}> = (
  obj: T,
  context: TContext,
  info: GraphQLResolveInfo,
) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = {}, TParent = {}, TContext = {}, TArgs = {}> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => TResult | Promise<TResult>;

/** Mapping of union types */
export type ResolversUnionTypes<_RefType extends Record<string, unknown>> = ResolversObject<{
  BoardHistoryEvent: BoardHistoryEntryAdded | BoardHistoryFullSync;
  CommentEvent: CommentAdded | CommentDeleted | CommentUpdated;
  ControllerEvent: ControllerPing | ControllerQueueSync | LedUpdate;
  QueueEvent: ClimbMirrored | CurrentClimbChanged | FullSync | QueueItemAdded | QueueItemRemoved | QueueReordered;
  SessionEvent:
    | DriverChanged
    | LeaderChanged
    | SessionBoardSerialChanged
    | SessionEnded
    | SessionStatsUpdated
    | SharedPlaylistToggled
    | UserJoined
    | UserLeft
    | UserPresenceChanged
    | WallConfirmedClimb;
}>;

/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = ResolversObject<{
  ActivityFeedInput: ActivityFeedInput;
  ActivityFeedItem: ResolverTypeWrapper<ActivityFeedItem>;
  ActivityFeedItemType: ActivityFeedItemType;
  ActivityFeedResult: ResolverTypeWrapper<ActivityFeedResult>;
  AddClimbToPlaylistInput: AddClimbToPlaylistInput;
  AddCommentInput: AddCommentInput;
  AddGymMemberInput: AddGymMemberInput;
  AddUserToSessionInput: AddUserToSessionInput;
  AllUserPlaylistsResult: ResolverTypeWrapper<AllUserPlaylistsResult>;
  Angle: ResolverTypeWrapper<Angle>;
  AscentFeedInput: AscentFeedInput;
  AscentFeedItem: ResolverTypeWrapper<AscentFeedItem>;
  AscentFeedResult: ResolverTypeWrapper<AscentFeedResult>;
  AttachBetaLinkInput: AttachBetaLinkInput;
  AuroraCredential: ResolverTypeWrapper<AuroraCredential>;
  AuroraCredentialStatus: ResolverTypeWrapper<AuroraCredentialStatus>;
  BetaLink: ResolverTypeWrapper<BetaLink>;
  BoardHistoryEntry: ResolverTypeWrapper<BoardHistoryEntry>;
  BoardHistoryEntryAdded: ResolverTypeWrapper<BoardHistoryEntryAdded>;
  BoardHistoryEvent: ResolverTypeWrapper<ResolversUnionTypes<ResolversTypes>['BoardHistoryEvent']>;
  BoardHistoryFullSync: ResolverTypeWrapper<BoardHistoryFullSync>;
  BoardHistorySource: BoardHistorySource;
  BoardLeaderboard: ResolverTypeWrapper<BoardLeaderboard>;
  BoardLeaderboardEntry: ResolverTypeWrapper<BoardLeaderboardEntry>;
  BoardLeaderboardInput: BoardLeaderboardInput;
  BoardSerialConfig: ResolverTypeWrapper<BoardSerialConfig>;
  BoardSession: ResolverTypeWrapper<BoardSession>;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  BrowseProposalsInput: BrowseProposalsInput;
  BulkVoteSummaryInput: BulkVoteSummaryInput;
  CheckMoonBoardClimbDuplicatesInput: CheckMoonBoardClimbDuplicatesInput;
  Climb: ResolverTypeWrapper<Climb>;
  ClimbClassicStatus: ResolverTypeWrapper<ClimbClassicStatus>;
  ClimbCommunityStatus: ResolverTypeWrapper<ClimbCommunityStatus>;
  ClimbInput: ClimbInput;
  ClimbMatchResult: ResolverTypeWrapper<ClimbMatchResult>;
  ClimbMirrored: ResolverTypeWrapper<ClimbMirrored>;
  ClimbPlaylistMembership: ResolverTypeWrapper<ClimbPlaylistMembership>;
  ClimbQueueItem: ResolverTypeWrapper<ClimbQueueItem>;
  ClimbQueueItemInput: ClimbQueueItemInput;
  ClimbSearchInput: ClimbSearchInput;
  ClimbSearchResult: ResolverTypeWrapper<ClimbSearchResult>;
  ClimbStatsHistoryEntry: ResolverTypeWrapper<ClimbStatsHistoryEntry>;
  Comment: ResolverTypeWrapper<Comment>;
  CommentAdded: ResolverTypeWrapper<CommentAdded>;
  CommentConnection: ResolverTypeWrapper<CommentConnection>;
  CommentDeleted: ResolverTypeWrapper<CommentDeleted>;
  CommentEvent: ResolverTypeWrapper<ResolversUnionTypes<ResolversTypes>['CommentEvent']>;
  CommentUpdated: ResolverTypeWrapper<CommentUpdated>;
  CommentsInput: CommentsInput;
  CommunityRoleAssignment: ResolverTypeWrapper<CommunityRoleAssignment>;
  CommunityRoleType: CommunityRoleType;
  CommunitySetting: ResolverTypeWrapper<CommunitySetting>;
  ControllerEvent: ResolverTypeWrapper<ResolversUnionTypes<ResolversTypes>['ControllerEvent']>;
  ControllerInfo: ResolverTypeWrapper<ControllerInfo>;
  ControllerPing: ResolverTypeWrapper<ControllerPing>;
  ControllerQueueItem: ResolverTypeWrapper<ControllerQueueItem>;
  ControllerQueueSync: ResolverTypeWrapper<ControllerQueueSync>;
  ControllerRegistration: ResolverTypeWrapper<ControllerRegistration>;
  CreateBoardInput: CreateBoardInput;
  CreateGymInput: CreateGymInput;
  CreatePlaylistInput: CreatePlaylistInput;
  CreateProposalInput: CreateProposalInput;
  CreateSessionInput: CreateSessionInput;
  CurrentClimbChanged: ResolverTypeWrapper<CurrentClimbChanged>;
  DeleteAccountInfo: ResolverTypeWrapper<DeleteAccountInfo>;
  DeleteAccountInput: DeleteAccountInput;
  DeleteProposalInput: DeleteProposalInput;
  DeviceLogEntry: DeviceLogEntry;
  DiscoverPlaylistsInput: DiscoverPlaylistsInput;
  DiscoverPlaylistsResult: ResolverTypeWrapper<DiscoverPlaylistsResult>;
  DiscoverablePlaylist: ResolverTypeWrapper<DiscoverablePlaylist>;
  DiscoverableSession: ResolverTypeWrapper<DiscoverableSession>;
  DriverChanged: ResolverTypeWrapper<DriverChanged>;
  EventsReplayResponse: ResolverTypeWrapper<
    Omit<EventsReplayResponse, 'events'> & { events: Array<ResolversTypes['QueueEvent']> }
  >;
  FavoritesCount: ResolverTypeWrapper<FavoritesCount>;
  FeedbackContextInput: FeedbackContextInput;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  FollowBoardInput: FollowBoardInput;
  FollowConnection: ResolverTypeWrapper<FollowConnection>;
  FollowGymInput: FollowGymInput;
  FollowInput: FollowInput;
  FollowListInput: FollowListInput;
  FollowPlaylistInput: FollowPlaylistInput;
  FollowSetterInput: FollowSetterInput;
  FollowingAscentFeedItem: ResolverTypeWrapper<FollowingAscentFeedItem>;
  FollowingAscentsFeedInput: FollowingAscentsFeedInput;
  FollowingAscentsFeedResult: ResolverTypeWrapper<FollowingAscentsFeedResult>;
  FollowingClimbAscentsInput: FollowingClimbAscentsInput;
  FollowingClimbAscentsResult: ResolverTypeWrapper<FollowingClimbAscentsResult>;
  FreezeClimbInput: FreezeClimbInput;
  FullSync: ResolverTypeWrapper<FullSync>;
  GetAllUserPlaylistsInput: GetAllUserPlaylistsInput;
  GetClimbProposalsInput: GetClimbProposalsInput;
  GetMyPinnedPlaylistsInput: GetMyPinnedPlaylistsInput;
  GetPlaylistClimbsInput: GetPlaylistClimbsInput;
  GetPlaylistCreatorsInput: GetPlaylistCreatorsInput;
  GetPlaylistsForClimbInput: GetPlaylistsForClimbInput;
  GetPlaylistsForClimbsInput: GetPlaylistsForClimbsInput;
  GetSmartPlaylistInput: GetSmartPlaylistInput;
  GetTicksInput: GetTicksInput;
  GetUserFavoriteClimbsInput: GetUserFavoriteClimbsInput;
  GetUserPlaylistsInput: GetUserPlaylistsInput;
  GlobalCommentFeedInput: GlobalCommentFeedInput;
  Grade: ResolverTypeWrapper<Grade>;
  GradeCount: ResolverTypeWrapper<GradeCount>;
  GrantRoleInput: GrantRoleInput;
  GroupedAscentFeedItem: ResolverTypeWrapper<GroupedAscentFeedItem>;
  GroupedAscentFeedResult: ResolverTypeWrapper<GroupedAscentFeedResult>;
  GroupedNotification: ResolverTypeWrapper<GroupedNotification>;
  GroupedNotificationActor: ResolverTypeWrapper<GroupedNotificationActor>;
  GroupedNotificationConnection: ResolverTypeWrapper<GroupedNotificationConnection>;
  Gym: ResolverTypeWrapper<Gym>;
  GymConnection: ResolverTypeWrapper<GymConnection>;
  GymMember: ResolverTypeWrapper<GymMember>;
  GymMemberConnection: ResolverTypeWrapper<GymMemberConnection>;
  GymMemberRole: GymMemberRole;
  GymMembersInput: GymMembersInput;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  JSON: ResolverTypeWrapper<Scalars['JSON']['output']>;
  LayoutStats: ResolverTypeWrapper<LayoutStats>;
  LeaderChanged: ResolverTypeWrapper<LeaderChanged>;
  LedCommand: ResolverTypeWrapper<LedCommand>;
  LedCommandInput: LedCommandInput;
  LedUpdate: ResolverTypeWrapper<LedUpdate>;
  LinkBoardToGymInput: LinkBoardToGymInput;
  MoonBoardClimbDuplicateCandidateInput: MoonBoardClimbDuplicateCandidateInput;
  MoonBoardClimbDuplicateMatch: ResolverTypeWrapper<MoonBoardClimbDuplicateMatch>;
  MoonBoardHoldsInput: MoonBoardHoldsInput;
  Mutation: ResolverTypeWrapper<{}>;
  MyBoardsInput: MyBoardsInput;
  MyGymsInput: MyGymsInput;
  NewClimbCreatedEvent: ResolverTypeWrapper<NewClimbCreatedEvent>;
  NewClimbFeedInput: NewClimbFeedInput;
  NewClimbFeedItem: ResolverTypeWrapper<NewClimbFeedItem>;
  NewClimbFeedResult: ResolverTypeWrapper<NewClimbFeedResult>;
  NewClimbSubscription: ResolverTypeWrapper<NewClimbSubscription>;
  NewClimbSubscriptionInput: NewClimbSubscriptionInput;
  Notification: ResolverTypeWrapper<Notification>;
  NotificationConnection: ResolverTypeWrapper<NotificationConnection>;
  NotificationEvent: ResolverTypeWrapper<NotificationEvent>;
  NotificationType: NotificationType;
  OutlierAnalysis: ResolverTypeWrapper<OutlierAnalysis>;
  PinPlaylistInput: PinPlaylistInput;
  Playlist: ResolverTypeWrapper<Playlist>;
  PlaylistClimb: ResolverTypeWrapper<PlaylistClimb>;
  PlaylistClimbsResult: ResolverTypeWrapper<PlaylistClimbsResult>;
  PlaylistCreator: ResolverTypeWrapper<PlaylistCreator>;
  PopularBoardConfig: ResolverTypeWrapper<PopularBoardConfig>;
  PopularBoardConfigConnection: ResolverTypeWrapper<PopularBoardConfigConnection>;
  PopularBoardConfigsInput: PopularBoardConfigsInput;
  ProfileStats: ResolverTypeWrapper<ProfileStats>;
  Proposal: ResolverTypeWrapper<Proposal>;
  ProposalConnection: ResolverTypeWrapper<ProposalConnection>;
  ProposalStatus: ProposalStatus;
  ProposalType: ProposalType;
  ProposalVoteSummary: ResolverTypeWrapper<ProposalVoteSummary>;
  PublicUserProfile: ResolverTypeWrapper<PublicUserProfile>;
  Query: ResolverTypeWrapper<{}>;
  QueueEvent: ResolverTypeWrapper<ResolversUnionTypes<ResolversTypes>['QueueEvent']>;
  QueueItemAdded: ResolverTypeWrapper<QueueItemAdded>;
  QueueItemRemoved: ResolverTypeWrapper<QueueItemRemoved>;
  QueueItemUser: ResolverTypeWrapper<QueueItemUser>;
  QueueItemUserInput: QueueItemUserInput;
  QueueNavigationContext: ResolverTypeWrapper<QueueNavigationContext>;
  QueueNavigationItem: ResolverTypeWrapper<QueueNavigationItem>;
  QueueReordered: ResolverTypeWrapper<QueueReordered>;
  QueueState: ResolverTypeWrapper<QueueState>;
  RecentBetaLink: ResolverTypeWrapper<RecentBetaLink>;
  RecordBoardSendInput: RecordBoardSendInput;
  RegisterControllerInput: RegisterControllerInput;
  RemoveClimbFromPlaylistInput: RemoveClimbFromPlaylistInput;
  RemoveGymMemberInput: RemoveGymMemberInput;
  RemoveUserFromSessionInput: RemoveUserFromSessionInput;
  ResolveProposalInput: ResolveProposalInput;
  RevokeRoleInput: RevokeRoleInput;
  SaveAuroraCredentialInput: SaveAuroraCredentialInput;
  SaveClimbInput: SaveClimbInput;
  SaveClimbResult: ResolverTypeWrapper<SaveClimbResult>;
  SaveMoonBoardClimbInput: SaveMoonBoardClimbInput;
  SaveTickInput: SaveTickInput;
  SearchBoardsInput: SearchBoardsInput;
  SearchGymsInput: SearchGymsInput;
  SearchPlaylistsInput: SearchPlaylistsInput;
  SearchPlaylistsResult: ResolverTypeWrapper<SearchPlaylistsResult>;
  SearchUsersInput: SearchUsersInput;
  SendDeviceLogsInput: SendDeviceLogsInput;
  SendDeviceLogsResponse: ResolverTypeWrapper<SendDeviceLogsResponse>;
  Session: ResolverTypeWrapper<Session>;
  SessionBoardSerialChanged: ResolverTypeWrapper<SessionBoardSerialChanged>;
  SessionConnectionState: SessionConnectionState;
  SessionDetail: ResolverTypeWrapper<SessionDetail>;
  SessionDetailTick: ResolverTypeWrapper<SessionDetailTick>;
  SessionEnded: ResolverTypeWrapper<SessionEnded>;
  SessionEvent: ResolverTypeWrapper<ResolversUnionTypes<ResolversTypes>['SessionEvent']>;
  SessionFeedItem: ResolverTypeWrapper<SessionFeedItem>;
  SessionFeedParticipant: ResolverTypeWrapper<SessionFeedParticipant>;
  SessionFeedResult: ResolverTypeWrapper<SessionFeedResult>;
  SessionGradeCount: ResolverTypeWrapper<SessionGradeCount>;
  SessionGradeDistributionItem: ResolverTypeWrapper<SessionGradeDistributionItem>;
  SessionHardestClimb: ResolverTypeWrapper<SessionHardestClimb>;
  SessionParticipant: ResolverTypeWrapper<SessionParticipant>;
  SessionStatsUpdated: ResolverTypeWrapper<SessionStatsUpdated>;
  SessionSummary: ResolverTypeWrapper<SessionSummary>;
  SessionUser: ResolverTypeWrapper<SessionUser>;
  SetCommunitySettingInput: SetCommunitySettingInput;
  SetterClimb: ResolverTypeWrapper<SetterClimb>;
  SetterClimbsConnection: ResolverTypeWrapper<SetterClimbsConnection>;
  SetterClimbsFullInput: SetterClimbsFullInput;
  SetterClimbsInput: SetterClimbsInput;
  SetterOverrideInput: SetterOverrideInput;
  SetterProfile: ResolverTypeWrapper<SetterProfile>;
  SetterProfileInput: SetterProfileInput;
  SetterSearchResult: ResolverTypeWrapper<SetterSearchResult>;
  SharedPlaylistToggled: ResolverTypeWrapper<SharedPlaylistToggled>;
  SimilarClimb: ResolverTypeWrapper<SimilarClimb>;
  SimilarClimbsInput: SimilarClimbsInput;
  SmartPlaylistCount: ResolverTypeWrapper<SmartPlaylistCount>;
  SmartPlaylistMeta: ResolverTypeWrapper<SmartPlaylistMeta>;
  SmartPlaylistResult: ResolverTypeWrapper<SmartPlaylistResult>;
  SmartPlaylistType: SmartPlaylistType;
  SocialEntityType: SocialEntityType;
  SortMode: SortMode;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  SubmitAppFeedbackInput: SubmitAppFeedbackInput;
  Subscription: ResolverTypeWrapper<{}>;
  Tick: ResolverTypeWrapper<Tick>;
  TickStatus: TickStatus;
  TimePeriod: TimePeriod;
  ToggleFavoriteInput: ToggleFavoriteInput;
  ToggleFavoriteResult: ResolverTypeWrapper<ToggleFavoriteResult>;
  UnifiedSearchConnection: ResolverTypeWrapper<UnifiedSearchConnection>;
  UnifiedSearchResult: ResolverTypeWrapper<UnifiedSearchResult>;
  UpdateBoardInput: UpdateBoardInput;
  UpdateClimbInput: UpdateClimbInput;
  UpdateClimbResult: ResolverTypeWrapper<UpdateClimbResult>;
  UpdateCommentInput: UpdateCommentInput;
  UpdateGymInput: UpdateGymInput;
  UpdateInferredSessionInput: UpdateInferredSessionInput;
  UpdatePlaylistInput: UpdatePlaylistInput;
  UpdateProfileInput: UpdateProfileInput;
  UpdateTickInput: UpdateTickInput;
  UserBoard: ResolverTypeWrapper<UserBoard>;
  UserBoardConnection: ResolverTypeWrapper<UserBoardConnection>;
  UserClimbPercentile: ResolverTypeWrapper<UserClimbPercentile>;
  UserClimbsInput: UserClimbsInput;
  UserJoined: ResolverTypeWrapper<UserJoined>;
  UserLeft: ResolverTypeWrapper<UserLeft>;
  UserPresenceChanged: ResolverTypeWrapper<UserPresenceChanged>;
  UserProfile: ResolverTypeWrapper<UserProfile>;
  UserSearchConnection: ResolverTypeWrapper<UserSearchConnection>;
  UserSearchResult: ResolverTypeWrapper<UserSearchResult>;
  VoteInput: VoteInput;
  VoteOnProposalInput: VoteOnProposalInput;
  VoteSummary: ResolverTypeWrapper<VoteSummary>;
  WallConfirmedClimb: ResolverTypeWrapper<WallConfirmedClimb>;
  ZoneBoxInput: ZoneBoxInput;
  ZoneMatchMode: ZoneMatchMode;
}>;

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = ResolversObject<{
  ActivityFeedInput: ActivityFeedInput;
  ActivityFeedItem: ActivityFeedItem;
  ActivityFeedResult: ActivityFeedResult;
  AddClimbToPlaylistInput: AddClimbToPlaylistInput;
  AddCommentInput: AddCommentInput;
  AddGymMemberInput: AddGymMemberInput;
  AddUserToSessionInput: AddUserToSessionInput;
  AllUserPlaylistsResult: AllUserPlaylistsResult;
  Angle: Angle;
  AscentFeedInput: AscentFeedInput;
  AscentFeedItem: AscentFeedItem;
  AscentFeedResult: AscentFeedResult;
  AttachBetaLinkInput: AttachBetaLinkInput;
  AuroraCredential: AuroraCredential;
  AuroraCredentialStatus: AuroraCredentialStatus;
  BetaLink: BetaLink;
  BoardHistoryEntry: BoardHistoryEntry;
  BoardHistoryEntryAdded: BoardHistoryEntryAdded;
  BoardHistoryEvent: ResolversUnionTypes<ResolversParentTypes>['BoardHistoryEvent'];
  BoardHistoryFullSync: BoardHistoryFullSync;
  BoardLeaderboard: BoardLeaderboard;
  BoardLeaderboardEntry: BoardLeaderboardEntry;
  BoardLeaderboardInput: BoardLeaderboardInput;
  BoardSerialConfig: BoardSerialConfig;
  BoardSession: BoardSession;
  Boolean: Scalars['Boolean']['output'];
  BrowseProposalsInput: BrowseProposalsInput;
  BulkVoteSummaryInput: BulkVoteSummaryInput;
  CheckMoonBoardClimbDuplicatesInput: CheckMoonBoardClimbDuplicatesInput;
  Climb: Climb;
  ClimbClassicStatus: ClimbClassicStatus;
  ClimbCommunityStatus: ClimbCommunityStatus;
  ClimbInput: ClimbInput;
  ClimbMatchResult: ClimbMatchResult;
  ClimbMirrored: ClimbMirrored;
  ClimbPlaylistMembership: ClimbPlaylistMembership;
  ClimbQueueItem: ClimbQueueItem;
  ClimbQueueItemInput: ClimbQueueItemInput;
  ClimbSearchInput: ClimbSearchInput;
  ClimbSearchResult: ClimbSearchResult;
  ClimbStatsHistoryEntry: ClimbStatsHistoryEntry;
  Comment: Comment;
  CommentAdded: CommentAdded;
  CommentConnection: CommentConnection;
  CommentDeleted: CommentDeleted;
  CommentEvent: ResolversUnionTypes<ResolversParentTypes>['CommentEvent'];
  CommentUpdated: CommentUpdated;
  CommentsInput: CommentsInput;
  CommunityRoleAssignment: CommunityRoleAssignment;
  CommunitySetting: CommunitySetting;
  ControllerEvent: ResolversUnionTypes<ResolversParentTypes>['ControllerEvent'];
  ControllerInfo: ControllerInfo;
  ControllerPing: ControllerPing;
  ControllerQueueItem: ControllerQueueItem;
  ControllerQueueSync: ControllerQueueSync;
  ControllerRegistration: ControllerRegistration;
  CreateBoardInput: CreateBoardInput;
  CreateGymInput: CreateGymInput;
  CreatePlaylistInput: CreatePlaylistInput;
  CreateProposalInput: CreateProposalInput;
  CreateSessionInput: CreateSessionInput;
  CurrentClimbChanged: CurrentClimbChanged;
  DeleteAccountInfo: DeleteAccountInfo;
  DeleteAccountInput: DeleteAccountInput;
  DeleteProposalInput: DeleteProposalInput;
  DeviceLogEntry: DeviceLogEntry;
  DiscoverPlaylistsInput: DiscoverPlaylistsInput;
  DiscoverPlaylistsResult: DiscoverPlaylistsResult;
  DiscoverablePlaylist: DiscoverablePlaylist;
  DiscoverableSession: DiscoverableSession;
  DriverChanged: DriverChanged;
  EventsReplayResponse: Omit<EventsReplayResponse, 'events'> & { events: Array<ResolversParentTypes['QueueEvent']> };
  FavoritesCount: FavoritesCount;
  FeedbackContextInput: FeedbackContextInput;
  Float: Scalars['Float']['output'];
  FollowBoardInput: FollowBoardInput;
  FollowConnection: FollowConnection;
  FollowGymInput: FollowGymInput;
  FollowInput: FollowInput;
  FollowListInput: FollowListInput;
  FollowPlaylistInput: FollowPlaylistInput;
  FollowSetterInput: FollowSetterInput;
  FollowingAscentFeedItem: FollowingAscentFeedItem;
  FollowingAscentsFeedInput: FollowingAscentsFeedInput;
  FollowingAscentsFeedResult: FollowingAscentsFeedResult;
  FollowingClimbAscentsInput: FollowingClimbAscentsInput;
  FollowingClimbAscentsResult: FollowingClimbAscentsResult;
  FreezeClimbInput: FreezeClimbInput;
  FullSync: FullSync;
  GetAllUserPlaylistsInput: GetAllUserPlaylistsInput;
  GetClimbProposalsInput: GetClimbProposalsInput;
  GetMyPinnedPlaylistsInput: GetMyPinnedPlaylistsInput;
  GetPlaylistClimbsInput: GetPlaylistClimbsInput;
  GetPlaylistCreatorsInput: GetPlaylistCreatorsInput;
  GetPlaylistsForClimbInput: GetPlaylistsForClimbInput;
  GetPlaylistsForClimbsInput: GetPlaylistsForClimbsInput;
  GetSmartPlaylistInput: GetSmartPlaylistInput;
  GetTicksInput: GetTicksInput;
  GetUserFavoriteClimbsInput: GetUserFavoriteClimbsInput;
  GetUserPlaylistsInput: GetUserPlaylistsInput;
  GlobalCommentFeedInput: GlobalCommentFeedInput;
  Grade: Grade;
  GradeCount: GradeCount;
  GrantRoleInput: GrantRoleInput;
  GroupedAscentFeedItem: GroupedAscentFeedItem;
  GroupedAscentFeedResult: GroupedAscentFeedResult;
  GroupedNotification: GroupedNotification;
  GroupedNotificationActor: GroupedNotificationActor;
  GroupedNotificationConnection: GroupedNotificationConnection;
  Gym: Gym;
  GymConnection: GymConnection;
  GymMember: GymMember;
  GymMemberConnection: GymMemberConnection;
  GymMembersInput: GymMembersInput;
  ID: Scalars['ID']['output'];
  Int: Scalars['Int']['output'];
  JSON: Scalars['JSON']['output'];
  LayoutStats: LayoutStats;
  LeaderChanged: LeaderChanged;
  LedCommand: LedCommand;
  LedCommandInput: LedCommandInput;
  LedUpdate: LedUpdate;
  LinkBoardToGymInput: LinkBoardToGymInput;
  MoonBoardClimbDuplicateCandidateInput: MoonBoardClimbDuplicateCandidateInput;
  MoonBoardClimbDuplicateMatch: MoonBoardClimbDuplicateMatch;
  MoonBoardHoldsInput: MoonBoardHoldsInput;
  Mutation: {};
  MyBoardsInput: MyBoardsInput;
  MyGymsInput: MyGymsInput;
  NewClimbCreatedEvent: NewClimbCreatedEvent;
  NewClimbFeedInput: NewClimbFeedInput;
  NewClimbFeedItem: NewClimbFeedItem;
  NewClimbFeedResult: NewClimbFeedResult;
  NewClimbSubscription: NewClimbSubscription;
  NewClimbSubscriptionInput: NewClimbSubscriptionInput;
  Notification: Notification;
  NotificationConnection: NotificationConnection;
  NotificationEvent: NotificationEvent;
  OutlierAnalysis: OutlierAnalysis;
  PinPlaylistInput: PinPlaylistInput;
  Playlist: Playlist;
  PlaylistClimb: PlaylistClimb;
  PlaylistClimbsResult: PlaylistClimbsResult;
  PlaylistCreator: PlaylistCreator;
  PopularBoardConfig: PopularBoardConfig;
  PopularBoardConfigConnection: PopularBoardConfigConnection;
  PopularBoardConfigsInput: PopularBoardConfigsInput;
  ProfileStats: ProfileStats;
  Proposal: Proposal;
  ProposalConnection: ProposalConnection;
  ProposalVoteSummary: ProposalVoteSummary;
  PublicUserProfile: PublicUserProfile;
  Query: {};
  QueueEvent: ResolversUnionTypes<ResolversParentTypes>['QueueEvent'];
  QueueItemAdded: QueueItemAdded;
  QueueItemRemoved: QueueItemRemoved;
  QueueItemUser: QueueItemUser;
  QueueItemUserInput: QueueItemUserInput;
  QueueNavigationContext: QueueNavigationContext;
  QueueNavigationItem: QueueNavigationItem;
  QueueReordered: QueueReordered;
  QueueState: QueueState;
  RecentBetaLink: RecentBetaLink;
  RecordBoardSendInput: RecordBoardSendInput;
  RegisterControllerInput: RegisterControllerInput;
  RemoveClimbFromPlaylistInput: RemoveClimbFromPlaylistInput;
  RemoveGymMemberInput: RemoveGymMemberInput;
  RemoveUserFromSessionInput: RemoveUserFromSessionInput;
  ResolveProposalInput: ResolveProposalInput;
  RevokeRoleInput: RevokeRoleInput;
  SaveAuroraCredentialInput: SaveAuroraCredentialInput;
  SaveClimbInput: SaveClimbInput;
  SaveClimbResult: SaveClimbResult;
  SaveMoonBoardClimbInput: SaveMoonBoardClimbInput;
  SaveTickInput: SaveTickInput;
  SearchBoardsInput: SearchBoardsInput;
  SearchGymsInput: SearchGymsInput;
  SearchPlaylistsInput: SearchPlaylistsInput;
  SearchPlaylistsResult: SearchPlaylistsResult;
  SearchUsersInput: SearchUsersInput;
  SendDeviceLogsInput: SendDeviceLogsInput;
  SendDeviceLogsResponse: SendDeviceLogsResponse;
  Session: Session;
  SessionBoardSerialChanged: SessionBoardSerialChanged;
  SessionDetail: SessionDetail;
  SessionDetailTick: SessionDetailTick;
  SessionEnded: SessionEnded;
  SessionEvent: ResolversUnionTypes<ResolversParentTypes>['SessionEvent'];
  SessionFeedItem: SessionFeedItem;
  SessionFeedParticipant: SessionFeedParticipant;
  SessionFeedResult: SessionFeedResult;
  SessionGradeCount: SessionGradeCount;
  SessionGradeDistributionItem: SessionGradeDistributionItem;
  SessionHardestClimb: SessionHardestClimb;
  SessionParticipant: SessionParticipant;
  SessionStatsUpdated: SessionStatsUpdated;
  SessionSummary: SessionSummary;
  SessionUser: SessionUser;
  SetCommunitySettingInput: SetCommunitySettingInput;
  SetterClimb: SetterClimb;
  SetterClimbsConnection: SetterClimbsConnection;
  SetterClimbsFullInput: SetterClimbsFullInput;
  SetterClimbsInput: SetterClimbsInput;
  SetterOverrideInput: SetterOverrideInput;
  SetterProfile: SetterProfile;
  SetterProfileInput: SetterProfileInput;
  SetterSearchResult: SetterSearchResult;
  SharedPlaylistToggled: SharedPlaylistToggled;
  SimilarClimb: SimilarClimb;
  SimilarClimbsInput: SimilarClimbsInput;
  SmartPlaylistCount: SmartPlaylistCount;
  SmartPlaylistMeta: SmartPlaylistMeta;
  SmartPlaylistResult: SmartPlaylistResult;
  String: Scalars['String']['output'];
  SubmitAppFeedbackInput: SubmitAppFeedbackInput;
  Subscription: {};
  Tick: Tick;
  ToggleFavoriteInput: ToggleFavoriteInput;
  ToggleFavoriteResult: ToggleFavoriteResult;
  UnifiedSearchConnection: UnifiedSearchConnection;
  UnifiedSearchResult: UnifiedSearchResult;
  UpdateBoardInput: UpdateBoardInput;
  UpdateClimbInput: UpdateClimbInput;
  UpdateClimbResult: UpdateClimbResult;
  UpdateCommentInput: UpdateCommentInput;
  UpdateGymInput: UpdateGymInput;
  UpdateInferredSessionInput: UpdateInferredSessionInput;
  UpdatePlaylistInput: UpdatePlaylistInput;
  UpdateProfileInput: UpdateProfileInput;
  UpdateTickInput: UpdateTickInput;
  UserBoard: UserBoard;
  UserBoardConnection: UserBoardConnection;
  UserClimbPercentile: UserClimbPercentile;
  UserClimbsInput: UserClimbsInput;
  UserJoined: UserJoined;
  UserLeft: UserLeft;
  UserPresenceChanged: UserPresenceChanged;
  UserProfile: UserProfile;
  UserSearchConnection: UserSearchConnection;
  UserSearchResult: UserSearchResult;
  VoteInput: VoteInput;
  VoteOnProposalInput: VoteOnProposalInput;
  VoteSummary: VoteSummary;
  WallConfirmedClimb: WallConfirmedClimb;
  ZoneBoxInput: ZoneBoxInput;
}>;

export type ActivityFeedItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ActivityFeedItem'] = ResolversParentTypes['ActivityFeedItem'],
> = ResolversObject<{
  actorAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  actorDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  actorId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  attemptCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  boardType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  boardUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  comment?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  commentBody?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  difficulty?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  entityId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  entityType?: Resolver<ResolversTypes['SocialEntityType'], ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gradeName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isBenchmark?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  isMirror?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  isNoMatch?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  metadata?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  quality?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  setterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  type?: Resolver<ResolversTypes['ActivityFeedItemType'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ActivityFeedResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ActivityFeedResult'] = ResolversParentTypes['ActivityFeedResult'],
> = ResolversObject<{
  cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['ActivityFeedItem']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type AllUserPlaylistsResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['AllUserPlaylistsResult'] = ResolversParentTypes['AllUserPlaylistsResult'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  playlists?: Resolver<Array<ResolversTypes['Playlist']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type AngleResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Angle'] = ResolversParentTypes['Angle'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type AscentFeedItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['AscentFeedItem'] = ResolversParentTypes['AscentFeedItem'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  attemptCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  comment?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  consensusDifficulty?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  consensusDifficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  difficulty?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isBenchmark?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isMirror?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isNoMatch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  quality?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  qualityAverage?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  setterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['TickStatus'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type AscentFeedResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['AscentFeedResult'] = ResolversParentTypes['AscentFeedResult'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['AscentFeedItem']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type AuroraCredentialResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['AuroraCredential'] = ResolversParentTypes['AuroraCredential'],
> = ResolversObject<{
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  syncedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  token?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  username?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type AuroraCredentialStatusResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['AuroraCredentialStatus'] = ResolversParentTypes['AuroraCredentialStatus'],
> = ResolversObject<{
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  hasToken?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  syncedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  username?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BetaLinkResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BetaLink'] = ResolversParentTypes['BetaLink'],
> = ResolversObject<{
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  foreignUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isListed?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  link?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  thumbnail?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BoardHistoryEntryResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardHistoryEntry'] = ResolversParentTypes['BoardHistoryEntry'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  boardId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  boardSerial?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isMirror?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sentAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sessionId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  source?: Resolver<ResolversTypes['BoardHistorySource'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  username?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BoardHistoryEntryAddedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardHistoryEntryAdded'] = ResolversParentTypes['BoardHistoryEntryAdded'],
> = ResolversObject<{
  entry?: Resolver<ResolversTypes['BoardHistoryEntry'], ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BoardHistoryEventResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardHistoryEvent'] = ResolversParentTypes['BoardHistoryEvent'],
> = ResolversObject<{
  __resolveType: TypeResolveFn<'BoardHistoryEntryAdded' | 'BoardHistoryFullSync', ParentType, ContextType>;
}>;

export type BoardHistoryFullSyncResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardHistoryFullSync'] = ResolversParentTypes['BoardHistoryFullSync'],
> = ResolversObject<{
  entries?: Resolver<Array<ResolversTypes['BoardHistoryEntry']>, ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BoardLeaderboardResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardLeaderboard'] = ResolversParentTypes['BoardLeaderboard'],
> = ResolversObject<{
  boardUuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  entries?: Resolver<Array<ResolversTypes['BoardLeaderboardEntry']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  periodLabel?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BoardLeaderboardEntryResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardLeaderboardEntry'] = ResolversParentTypes['BoardLeaderboardEntry'],
> = ResolversObject<{
  hardestGrade?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  hardestGradeName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  rank?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalFlashes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalSends?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalSessions?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BoardSerialConfigResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardSerialConfig'] = ResolversParentTypes['BoardSerialConfig'],
> = ResolversObject<{
  boardName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  boardSlug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  boardUuid?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  serialNumber?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  setIds?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sizeId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type BoardSessionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['BoardSession'] = ResolversParentTypes['BoardSession'],
> = ResolversObject<{
  boardPath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  endedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sharedPlaylistEnabled?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  startedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Climb'] = ResolversParentTypes['Climb'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ascensionist_count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  benchmark_difficulty?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  boardType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  created_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  difficulty?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  difficulty_error?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  frames?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  is_draft?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  is_no_match?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  mirrored?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  published_at?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  quality_average?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  setter_username?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stars?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  userAscents?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  userAttempts?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  userId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbClassicStatusResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbClassicStatus'] = ResolversParentTypes['ClimbClassicStatus'],
> = ResolversObject<{
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  isClassic?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  updatedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbCommunityStatusResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbCommunityStatus'] = ResolversParentTypes['ClimbCommunityStatus'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  communityGrade?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  freezeReason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isBenchmark?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isClassic?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isFrozen?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  openProposalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  outlierAnalysis?: Resolver<Maybe<ResolversTypes['OutlierAnalysis']>, ParentType, ContextType>;
  updatedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbMatchResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbMatchResult'] = ResolversParentTypes['ClimbMatchResult'],
> = ResolversObject<{
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  matched?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbMirroredResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbMirrored'] = ResolversParentTypes['ClimbMirrored'],
> = ResolversObject<{
  mirrored?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stateHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uuid?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbPlaylistMembershipResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbPlaylistMembership'] = ResolversParentTypes['ClimbPlaylistMembership'],
> = ResolversObject<{
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  playlistUuids?: Resolver<Array<ResolversTypes['ID']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbQueueItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbQueueItem'] = ResolversParentTypes['ClimbQueueItem'],
> = ResolversObject<{
  addedBy?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  addedByUser?: Resolver<Maybe<ResolversTypes['QueueItemUser']>, ParentType, ContextType>;
  climb?: Resolver<ResolversTypes['Climb'], ParentType, ContextType>;
  suggested?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  tickedBy?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbSearchResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbSearchResult'] = ResolversParentTypes['ClimbSearchResult'],
> = ResolversObject<{
  climbs?: Resolver<Array<ResolversTypes['Climb']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ClimbStatsHistoryEntryResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ClimbStatsHistoryEntry'] = ResolversParentTypes['ClimbStatsHistoryEntry'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ascensionistCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  difficultyAverage?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  displayDifficulty?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  qualityAverage?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CommentResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Comment'] = ResolversParentTypes['Comment'],
> = ResolversObject<{
  body?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  downvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  entityId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  entityType?: Resolver<ResolversTypes['SocialEntityType'], ParentType, ContextType>;
  isDeleted?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  parentCommentUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  replyCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  upvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  userVote?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  voteScore?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CommentAddedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CommentAdded'] = ResolversParentTypes['CommentAdded'],
> = ResolversObject<{
  comment?: Resolver<ResolversTypes['Comment'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CommentConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CommentConnection'] = ResolversParentTypes['CommentConnection'],
> = ResolversObject<{
  comments?: Resolver<Array<ResolversTypes['Comment']>, ParentType, ContextType>;
  cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CommentDeletedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CommentDeleted'] = ResolversParentTypes['CommentDeleted'],
> = ResolversObject<{
  commentUuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  entityId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  entityType?: Resolver<ResolversTypes['SocialEntityType'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CommentEventResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CommentEvent'] = ResolversParentTypes['CommentEvent'],
> = ResolversObject<{
  __resolveType: TypeResolveFn<'CommentAdded' | 'CommentDeleted' | 'CommentUpdated', ParentType, ContextType>;
}>;

export type CommentUpdatedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CommentUpdated'] = ResolversParentTypes['CommentUpdated'],
> = ResolversObject<{
  comment?: Resolver<ResolversTypes['Comment'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CommunityRoleAssignmentResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CommunityRoleAssignment'] = ResolversParentTypes['CommunityRoleAssignment'],
> = ResolversObject<{
  boardType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  grantedBy?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  grantedByDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  role?: Resolver<ResolversTypes['CommunityRoleType'], ParentType, ContextType>;
  userAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CommunitySettingResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CommunitySetting'] = ResolversParentTypes['CommunitySetting'],
> = ResolversObject<{
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  key?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  scope?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  scopeKey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  setBy?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  value?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ControllerEventResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ControllerEvent'] = ResolversParentTypes['ControllerEvent'],
> = ResolversObject<{
  __resolveType: TypeResolveFn<'ControllerPing' | 'ControllerQueueSync' | 'LedUpdate', ParentType, ContextType>;
}>;

export type ControllerInfoResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ControllerInfo'] = ResolversParentTypes['ControllerInfo'],
> = ResolversObject<{
  boardName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isOnline?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  lastSeen?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  setIds?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sizeId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ControllerPingResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ControllerPing'] = ResolversParentTypes['ControllerPing'],
> = ResolversObject<{
  timestamp?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ControllerQueueItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ControllerQueueItem'] = ResolversParentTypes['ControllerQueueItem'],
> = ResolversObject<{
  climbUuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  grade?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  gradeColor?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ControllerQueueSyncResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ControllerQueueSync'] = ResolversParentTypes['ControllerQueueSync'],
> = ResolversObject<{
  currentIndex?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  queue?: Resolver<Array<ResolversTypes['ControllerQueueItem']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ControllerRegistrationResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ControllerRegistration'] = ResolversParentTypes['ControllerRegistration'],
> = ResolversObject<{
  apiKey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  controllerId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type CurrentClimbChangedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['CurrentClimbChanged'] = ResolversParentTypes['CurrentClimbChanged'],
> = ResolversObject<{
  clientId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  correlationId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  item?: Resolver<Maybe<ResolversTypes['ClimbQueueItem']>, ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stateHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type DeleteAccountInfoResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['DeleteAccountInfo'] = ResolversParentTypes['DeleteAccountInfo'],
> = ResolversObject<{
  publishedClimbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type DiscoverPlaylistsResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['DiscoverPlaylistsResult'] = ResolversParentTypes['DiscoverPlaylistsResult'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  playlists?: Resolver<Array<ResolversTypes['DiscoverablePlaylist']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type DiscoverablePlaylistResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['DiscoverablePlaylist'] = ResolversParentTypes['DiscoverablePlaylist'],
> = ResolversObject<{
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  color?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  creatorId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  creatorName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  icon?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type DiscoverableSessionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['DiscoverableSession'] = ResolversParentTypes['DiscoverableSession'],
> = ResolversObject<{
  boardPath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  color?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdByUserId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  distance?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  goal?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isActive?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPermanent?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  isPublic?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  latitude?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  longitude?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  participantCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type DriverChangedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['DriverChanged'] = ResolversParentTypes['DriverChanged'],
> = ResolversObject<{
  driverParticipantId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  previousDriverParticipantId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type EventsReplayResponseResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['EventsReplayResponse'] = ResolversParentTypes['EventsReplayResponse'],
> = ResolversObject<{
  currentSequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  events?: Resolver<Array<ResolversTypes['QueueEvent']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type FavoritesCountResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['FavoritesCount'] = ResolversParentTypes['FavoritesCount'],
> = ResolversObject<{
  boardName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type FollowConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['FollowConnection'] = ResolversParentTypes['FollowConnection'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  users?: Resolver<Array<ResolversTypes['PublicUserProfile']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type FollowingAscentFeedItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['FollowingAscentFeedItem'] = ResolversParentTypes['FollowingAscentFeedItem'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  attemptCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  comment?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  commentCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  difficulty?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  downvotes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isBenchmark?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isMirror?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isNoMatch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  quality?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  setterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  upvotes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  userAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type FollowingAscentsFeedResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['FollowingAscentsFeedResult'] =
    ResolversParentTypes['FollowingAscentsFeedResult'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['FollowingAscentFeedItem']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type FollowingClimbAscentsResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['FollowingClimbAscentsResult'] =
    ResolversParentTypes['FollowingClimbAscentsResult'],
> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['FollowingAscentFeedItem']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type FullSyncResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['FullSync'] = ResolversParentTypes['FullSync'],
> = ResolversObject<{
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  state?: Resolver<ResolversTypes['QueueState'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GradeResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Grade'] = ResolversParentTypes['Grade'],
> = ResolversObject<{
  difficultyId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GradeCountResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GradeCount'] = ResolversParentTypes['GradeCount'],
> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  grade?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GroupedAscentFeedItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GroupedAscentFeedItem'] = ResolversParentTypes['GroupedAscentFeedItem'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  attemptCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  bestQuality?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  date?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  flashCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isBenchmark?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isMirror?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isNoMatch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['AscentFeedItem']>, ParentType, ContextType>;
  key?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  latestComment?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  sendCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  setterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GroupedAscentFeedResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GroupedAscentFeedResult'] = ResolversParentTypes['GroupedAscentFeedResult'],
> = ResolversObject<{
  groups?: Resolver<Array<ResolversTypes['GroupedAscentFeedItem']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GroupedNotificationResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GroupedNotification'] = ResolversParentTypes['GroupedNotification'],
> = ResolversObject<{
  actorCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  actors?: Resolver<Array<ResolversTypes['GroupedNotificationActor']>, ParentType, ContextType>;
  boardType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  commentBody?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  entityId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  entityType?: Resolver<Maybe<ResolversTypes['SocialEntityType']>, ParentType, ContextType>;
  isRead?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  proposalUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  setterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  type?: Resolver<ResolversTypes['NotificationType'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GroupedNotificationActorResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GroupedNotificationActor'] =
    ResolversParentTypes['GroupedNotificationActor'],
> = ResolversObject<{
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  displayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GroupedNotificationConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GroupedNotificationConnection'] =
    ResolversParentTypes['GroupedNotificationConnection'],
> = ResolversObject<{
  groups?: Resolver<Array<ResolversTypes['GroupedNotification']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unreadCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GymResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Gym'] = ResolversParentTypes['Gym'],
> = ResolversObject<{
  address?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  boardCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  commentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  contactEmail?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  contactPhone?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  followerCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  imageUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isFollowedByMe?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isMember?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPublic?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  latitude?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  longitude?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  memberCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  myRole?: Resolver<Maybe<ResolversTypes['GymMemberRole']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  ownerAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  ownerDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  ownerId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  slug?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GymConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GymConnection'] = ResolversParentTypes['GymConnection'],
> = ResolversObject<{
  gyms?: Resolver<Array<ResolversTypes['Gym']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GymMemberResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GymMember'] = ResolversParentTypes['GymMember'],
> = ResolversObject<{
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  displayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  role?: Resolver<ResolversTypes['GymMemberRole'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type GymMemberConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['GymMemberConnection'] = ResolversParentTypes['GymMemberConnection'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  members?: Resolver<Array<ResolversTypes['GymMember']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export interface JsonScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['JSON'], any> {
  name: 'JSON';
}

export type LayoutStatsResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['LayoutStats'] = ResolversParentTypes['LayoutStats'],
> = ResolversObject<{
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  distinctClimbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  gradeCounts?: Resolver<Array<ResolversTypes['GradeCount']>, ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  layoutKey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type LeaderChangedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['LeaderChanged'] = ResolversParentTypes['LeaderChanged'],
> = ResolversObject<{
  leaderConnectionId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  leaderId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type LedCommandResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['LedCommand'] = ResolversParentTypes['LedCommand'],
> = ResolversObject<{
  b?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  g?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  position?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  r?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type LedUpdateResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['LedUpdate'] = ResolversParentTypes['LedUpdate'],
> = ResolversObject<{
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  boardPath?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  clientId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbGrade?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  commands?: Resolver<Array<ResolversTypes['LedCommand']>, ParentType, ContextType>;
  gradeColor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  navigation?: Resolver<Maybe<ResolversTypes['QueueNavigationContext']>, ParentType, ContextType>;
  queueItemUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type MoonBoardClimbDuplicateMatchResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['MoonBoardClimbDuplicateMatch'] =
    ResolversParentTypes['MoonBoardClimbDuplicateMatch'],
> = ResolversObject<{
  clientKey?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  existingClimbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  existingClimbUuid?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  exists?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type MutationResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation'],
> = ResolversObject<{
  addClimbToPlaylist?: Resolver<
    ResolversTypes['PlaylistClimb'],
    ParentType,
    ContextType,
    RequireFields<MutationAddClimbToPlaylistArgs, 'input'>
  >;
  addComment?: Resolver<
    ResolversTypes['Comment'],
    ParentType,
    ContextType,
    RequireFields<MutationAddCommentArgs, 'input'>
  >;
  addGymMember?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationAddGymMemberArgs, 'input'>
  >;
  addQueueItem?: Resolver<
    ResolversTypes['ClimbQueueItem'],
    ParentType,
    ContextType,
    RequireFields<MutationAddQueueItemArgs, 'item'>
  >;
  addUserToSession?: Resolver<
    Maybe<ResolversTypes['SessionDetail']>,
    ParentType,
    ContextType,
    RequireFields<MutationAddUserToSessionArgs, 'input'>
  >;
  attachBetaLink?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationAttachBetaLinkArgs, 'input'>
  >;
  authorizeControllerForSession?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationAuthorizeControllerForSessionArgs, 'controllerId' | 'sessionId'>
  >;
  confirmClimbOnWall?: Resolver<
    ResolversTypes['Session'],
    ParentType,
    ContextType,
    RequireFields<MutationConfirmClimbOnWallArgs, 'climbUuid'>
  >;
  controllerHeartbeat?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationControllerHeartbeatArgs, 'sessionId'>
  >;
  createBoard?: Resolver<
    ResolversTypes['UserBoard'],
    ParentType,
    ContextType,
    RequireFields<MutationCreateBoardArgs, 'input'>
  >;
  createGym?: Resolver<ResolversTypes['Gym'], ParentType, ContextType, RequireFields<MutationCreateGymArgs, 'input'>>;
  createPlaylist?: Resolver<
    ResolversTypes['Playlist'],
    ParentType,
    ContextType,
    RequireFields<MutationCreatePlaylistArgs, 'input'>
  >;
  createProposal?: Resolver<
    ResolversTypes['Proposal'],
    ParentType,
    ContextType,
    RequireFields<MutationCreateProposalArgs, 'input'>
  >;
  createSession?: Resolver<
    ResolversTypes['Session'],
    ParentType,
    ContextType,
    RequireFields<MutationCreateSessionArgs, 'input'>
  >;
  deleteAccount?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteAccountArgs, 'input'>
  >;
  deleteAuroraCredential?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteAuroraCredentialArgs, 'boardType'>
  >;
  deleteBoard?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteBoardArgs, 'boardUuid'>
  >;
  deleteComment?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteCommentArgs, 'commentUuid'>
  >;
  deleteController?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteControllerArgs, 'controllerId'>
  >;
  deleteDraftClimb?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteDraftClimbArgs, 'boardType' | 'uuid'>
  >;
  deleteGym?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteGymArgs, 'gymUuid'>
  >;
  deletePlaylist?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeletePlaylistArgs, 'playlistId'>
  >;
  deleteProposal?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteProposalArgs, 'input'>
  >;
  deleteTick?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationDeleteTickArgs, 'uuid'>
  >;
  endSession?: Resolver<
    Maybe<ResolversTypes['SessionSummary']>,
    ParentType,
    ContextType,
    RequireFields<MutationEndSessionArgs, 'sessionId'>
  >;
  followBoard?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationFollowBoardArgs, 'input'>
  >;
  followGym?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationFollowGymArgs, 'input'>
  >;
  followPlaylist?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationFollowPlaylistArgs, 'input'>
  >;
  followSetter?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationFollowSetterArgs, 'input'>
  >;
  followUser?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationFollowUserArgs, 'input'>
  >;
  freezeClimb?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationFreezeClimbArgs, 'input'>
  >;
  grantRole?: Resolver<
    ResolversTypes['CommunityRoleAssignment'],
    ParentType,
    ContextType,
    RequireFields<MutationGrantRoleArgs, 'input'>
  >;
  joinSession?: Resolver<
    ResolversTypes['Session'],
    ParentType,
    ContextType,
    RequireFields<MutationJoinSessionArgs, 'boardPath' | 'sessionId'>
  >;
  leaveSession?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  linkBoardToGym?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationLinkBoardToGymArgs, 'input'>
  >;
  markAllNotificationsRead?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  markGroupNotificationsRead?: Resolver<
    ResolversTypes['Int'],
    ParentType,
    ContextType,
    RequireFields<MutationMarkGroupNotificationsReadArgs, 'type'>
  >;
  markNotificationRead?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationMarkNotificationReadArgs, 'notificationUuid'>
  >;
  mirrorCurrentClimb?: Resolver<
    Maybe<ResolversTypes['ClimbQueueItem']>,
    ParentType,
    ContextType,
    RequireFields<MutationMirrorCurrentClimbArgs, 'mirrored'>
  >;
  navigateQueue?: Resolver<
    Maybe<ResolversTypes['ClimbQueueItem']>,
    ParentType,
    ContextType,
    RequireFields<MutationNavigateQueueArgs, 'direction' | 'sessionId'>
  >;
  pinPlaylist?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationPinPlaylistArgs, 'input'>
  >;
  recordBoardSend?: Resolver<
    ResolversTypes['BoardHistoryEntry'],
    ParentType,
    ContextType,
    RequireFields<MutationRecordBoardSendArgs, 'input'>
  >;
  registerActivityPushToken?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationRegisterActivityPushTokenArgs, 'sessionId' | 'token'>
  >;
  registerController?: Resolver<
    ResolversTypes['ControllerRegistration'],
    ParentType,
    ContextType,
    RequireFields<MutationRegisterControllerArgs, 'input'>
  >;
  releaseControl?: Resolver<ResolversTypes['Session'], ParentType, ContextType>;
  removeClimbFromPlaylist?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationRemoveClimbFromPlaylistArgs, 'input'>
  >;
  removeGymMember?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationRemoveGymMemberArgs, 'input'>
  >;
  removeQueueItem?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationRemoveQueueItemArgs, 'uuid'>
  >;
  removeUserFromSession?: Resolver<
    Maybe<ResolversTypes['SessionDetail']>,
    ParentType,
    ContextType,
    RequireFields<MutationRemoveUserFromSessionArgs, 'input'>
  >;
  reorderQueueItem?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationReorderQueueItemArgs, 'newIndex' | 'oldIndex' | 'uuid'>
  >;
  replaceQueueItem?: Resolver<
    ResolversTypes['ClimbQueueItem'],
    ParentType,
    ContextType,
    RequireFields<MutationReplaceQueueItemArgs, 'item' | 'uuid'>
  >;
  resolveProposal?: Resolver<
    ResolversTypes['Proposal'],
    ParentType,
    ContextType,
    RequireFields<MutationResolveProposalArgs, 'input'>
  >;
  revokeRole?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationRevokeRoleArgs, 'input'>
  >;
  saveAuroraCredential?: Resolver<
    ResolversTypes['AuroraCredentialStatus'],
    ParentType,
    ContextType,
    RequireFields<MutationSaveAuroraCredentialArgs, 'input'>
  >;
  saveClimb?: Resolver<
    ResolversTypes['SaveClimbResult'],
    ParentType,
    ContextType,
    RequireFields<MutationSaveClimbArgs, 'input'>
  >;
  saveMoonBoardClimb?: Resolver<
    ResolversTypes['SaveClimbResult'],
    ParentType,
    ContextType,
    RequireFields<MutationSaveMoonBoardClimbArgs, 'input'>
  >;
  saveTick?: Resolver<ResolversTypes['Tick'], ParentType, ContextType, RequireFields<MutationSaveTickArgs, 'input'>>;
  sendDeviceLogs?: Resolver<
    ResolversTypes['SendDeviceLogsResponse'],
    ParentType,
    ContextType,
    RequireFields<MutationSendDeviceLogsArgs, 'input'>
  >;
  setClimbFromLedPositions?: Resolver<
    ResolversTypes['ClimbMatchResult'],
    ParentType,
    ContextType,
    RequireFields<MutationSetClimbFromLedPositionsArgs, 'sessionId'>
  >;
  setCommunitySettings?: Resolver<
    ResolversTypes['CommunitySetting'],
    ParentType,
    ContextType,
    RequireFields<MutationSetCommunitySettingsArgs, 'input'>
  >;
  setCurrentClimb?: Resolver<
    Maybe<ResolversTypes['ClimbQueueItem']>,
    ParentType,
    ContextType,
    Partial<MutationSetCurrentClimbArgs>
  >;
  setInferredSessionHealthKitWorkoutId?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationSetInferredSessionHealthKitWorkoutIdArgs, 'sessionId' | 'workoutId'>
  >;
  setQueue?: Resolver<
    ResolversTypes['QueueState'],
    ParentType,
    ContextType,
    RequireFields<MutationSetQueueArgs, 'queue'>
  >;
  setSessionBoardSerial?: Resolver<
    ResolversTypes['Session'],
    ParentType,
    ContextType,
    RequireFields<MutationSetSessionBoardSerialArgs, 'serial'>
  >;
  setSharedPlaylistEnabled?: Resolver<
    ResolversTypes['BoardSession'],
    ParentType,
    ContextType,
    RequireFields<MutationSetSharedPlaylistEnabledArgs, 'enabled' | 'sessionId'>
  >;
  setterOverrideCommunityStatus?: Resolver<
    ResolversTypes['ClimbCommunityStatus'],
    ParentType,
    ContextType,
    RequireFields<MutationSetterOverrideCommunityStatusArgs, 'input'>
  >;
  submitAppFeedback?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationSubmitAppFeedbackArgs, 'input'>
  >;
  subscribeNewClimbs?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationSubscribeNewClimbsArgs, 'input'>
  >;
  takeControl?: Resolver<ResolversTypes['Session'], ParentType, ContextType, Partial<MutationTakeControlArgs>>;
  toggleFavorite?: Resolver<
    ResolversTypes['ToggleFavoriteResult'],
    ParentType,
    ContextType,
    RequireFields<MutationToggleFavoriteArgs, 'input'>
  >;
  unfollowBoard?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnfollowBoardArgs, 'input'>
  >;
  unfollowGym?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnfollowGymArgs, 'input'>
  >;
  unfollowPlaylist?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnfollowPlaylistArgs, 'input'>
  >;
  unfollowSetter?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnfollowSetterArgs, 'input'>
  >;
  unfollowUser?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnfollowUserArgs, 'input'>
  >;
  unpinPlaylist?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnpinPlaylistArgs, 'input'>
  >;
  unregisterActivityPushToken?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnregisterActivityPushTokenArgs, 'sessionId' | 'token'>
  >;
  unsubscribeNewClimbs?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUnsubscribeNewClimbsArgs, 'input'>
  >;
  updateBoard?: Resolver<
    ResolversTypes['UserBoard'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdateBoardArgs, 'input'>
  >;
  updateClimb?: Resolver<
    ResolversTypes['UpdateClimbResult'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdateClimbArgs, 'input'>
  >;
  updateComment?: Resolver<
    ResolversTypes['Comment'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdateCommentArgs, 'input'>
  >;
  updateGym?: Resolver<ResolversTypes['Gym'], ParentType, ContextType, RequireFields<MutationUpdateGymArgs, 'input'>>;
  updateInferredSession?: Resolver<
    Maybe<ResolversTypes['SessionDetail']>,
    ParentType,
    ContextType,
    RequireFields<MutationUpdateInferredSessionArgs, 'input'>
  >;
  updatePlaylist?: Resolver<
    ResolversTypes['Playlist'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdatePlaylistArgs, 'input'>
  >;
  updatePlaylistLastAccessed?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdatePlaylistLastAccessedArgs, 'playlistId'>
  >;
  updateProfile?: Resolver<
    ResolversTypes['UserProfile'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdateProfileArgs, 'input'>
  >;
  updateTick?: Resolver<
    ResolversTypes['Tick'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdateTickArgs, 'input' | 'uuid'>
  >;
  updateUsername?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<MutationUpdateUsernameArgs, 'username'>
  >;
  vote?: Resolver<ResolversTypes['VoteSummary'], ParentType, ContextType, RequireFields<MutationVoteArgs, 'input'>>;
  voteOnProposal?: Resolver<
    ResolversTypes['Proposal'],
    ParentType,
    ContextType,
    RequireFields<MutationVoteOnProposalArgs, 'input'>
  >;
}>;

export type NewClimbCreatedEventResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['NewClimbCreatedEvent'] = ResolversParentTypes['NewClimbCreatedEvent'],
> = ResolversObject<{
  climb?: Resolver<ResolversTypes['NewClimbFeedItem'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type NewClimbFeedItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['NewClimbFeedItem'] = ResolversParentTypes['NewClimbFeedItem'],
> = ResolversObject<{
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isNoMatch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  setterAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  setterDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type NewClimbFeedResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['NewClimbFeedResult'] = ResolversParentTypes['NewClimbFeedResult'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['NewClimbFeedItem']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type NewClimbSubscriptionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['NewClimbSubscription'] = ResolversParentTypes['NewClimbSubscription'],
> = ResolversObject<{
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type NotificationResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Notification'] = ResolversParentTypes['Notification'],
> = ResolversObject<{
  actorAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  actorDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  actorId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  boardType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  commentBody?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  entityId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  entityType?: Resolver<Maybe<ResolversTypes['SocialEntityType']>, ParentType, ContextType>;
  isRead?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  proposalUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  type?: Resolver<ResolversTypes['NotificationType'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type NotificationConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['NotificationConnection'] = ResolversParentTypes['NotificationConnection'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  notifications?: Resolver<Array<ResolversTypes['Notification']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  unreadCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type NotificationEventResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['NotificationEvent'] = ResolversParentTypes['NotificationEvent'],
> = ResolversObject<{
  notification?: Resolver<ResolversTypes['Notification'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type OutlierAnalysisResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['OutlierAnalysis'] = ResolversParentTypes['OutlierAnalysis'],
> = ResolversObject<{
  currentGrade?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  gradeDifference?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  isOutlier?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  neighborAverage?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  neighborCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type PlaylistResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Playlist'] = ResolversParentTypes['Playlist'],
> = ResolversObject<{
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  color?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  followerCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  icon?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isFollowedByMe?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPinnedByMe?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPublic?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  lastAccessedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  userRole?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type PlaylistClimbResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['PlaylistClimb'] = ResolversParentTypes['PlaylistClimb'],
> = ResolversObject<{
  addedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  playlistId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  position?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type PlaylistClimbsResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['PlaylistClimbsResult'] = ResolversParentTypes['PlaylistClimbsResult'],
> = ResolversObject<{
  climbs?: Resolver<Array<ResolversTypes['Climb']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type PlaylistCreatorResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['PlaylistCreator'] = ResolversParentTypes['PlaylistCreator'],
> = ResolversObject<{
  displayName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  playlistCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type PopularBoardConfigResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['PopularBoardConfig'] = ResolversParentTypes['PopularBoardConfig'],
> = ResolversObject<{
  boardCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  displayName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  layoutName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  setIds?: Resolver<Array<ResolversTypes['Int']>, ParentType, ContextType>;
  setNames?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  sizeDescription?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sizeId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sizeName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  totalAscents?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type PopularBoardConfigConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['PopularBoardConfigConnection'] =
    ResolversParentTypes['PopularBoardConfigConnection'],
> = ResolversObject<{
  configs?: Resolver<Array<ResolversTypes['PopularBoardConfig']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ProfileStatsResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ProfileStats'] = ResolversParentTypes['ProfileStats'],
> = ResolversObject<{
  layoutStats?: Resolver<Array<ResolversTypes['LayoutStats']>, ParentType, ContextType>;
  totalDistinctClimbs?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ProposalResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Proposal'] = ResolversParentTypes['Proposal'],
> = ResolversObject<{
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbAscensionistCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  climbBenchmarkDifficulty?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbDifficulty?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbDifficultyError?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbIsNoMatch?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbQualityAverage?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbSetterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  currentValue?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  proposedValue?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  proposerAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  proposerDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  proposerId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  reason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  requiredUpvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  resolvedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  resolvedBy?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['ProposalStatus'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['ProposalType'], ParentType, ContextType>;
  userVote?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  weightedDownvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  weightedUpvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ProposalConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ProposalConnection'] = ResolversParentTypes['ProposalConnection'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  proposals?: Resolver<Array<ResolversTypes['Proposal']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ProposalVoteSummaryResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ProposalVoteSummary'] = ResolversParentTypes['ProposalVoteSummary'],
> = ResolversObject<{
  isApproved?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  requiredUpvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  weightedDownvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  weightedUpvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type PublicUserProfileResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['PublicUserProfile'] = ResolversParentTypes['PublicUserProfile'],
> = ResolversObject<{
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  displayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  followerCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  followingCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isFollowedByMe?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type QueryResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query'],
> = ResolversObject<{
  activityFeed?: Resolver<
    ResolversTypes['ActivityFeedResult'],
    ParentType,
    ContextType,
    Partial<QueryActivityFeedArgs>
  >;
  allUserPlaylists?: Resolver<
    ResolversTypes['AllUserPlaylistsResult'],
    ParentType,
    ContextType,
    RequireFields<QueryAllUserPlaylistsArgs, 'input'>
  >;
  angles?: Resolver<
    Array<ResolversTypes['Angle']>,
    ParentType,
    ContextType,
    RequireFields<QueryAnglesArgs, 'boardName' | 'layoutId'>
  >;
  auroraCredential?: Resolver<
    Maybe<ResolversTypes['AuroraCredential']>,
    ParentType,
    ContextType,
    RequireFields<QueryAuroraCredentialArgs, 'boardType'>
  >;
  auroraCredentials?: Resolver<Array<ResolversTypes['AuroraCredentialStatus']>, ParentType, ContextType>;
  betaLinks?: Resolver<
    Array<ResolversTypes['BetaLink']>,
    ParentType,
    ContextType,
    RequireFields<QueryBetaLinksArgs, 'boardType' | 'climbUuid'>
  >;
  board?: Resolver<
    Maybe<ResolversTypes['UserBoard']>,
    ParentType,
    ContextType,
    RequireFields<QueryBoardArgs, 'boardUuid'>
  >;
  boardBySlug?: Resolver<
    Maybe<ResolversTypes['UserBoard']>,
    ParentType,
    ContextType,
    RequireFields<QueryBoardBySlugArgs, 'slug'>
  >;
  boardHistory?: Resolver<
    Array<ResolversTypes['BoardHistoryEntry']>,
    ParentType,
    ContextType,
    RequireFields<QueryBoardHistoryArgs, 'boardSerial' | 'limit'>
  >;
  boardLeaderboard?: Resolver<
    ResolversTypes['BoardLeaderboard'],
    ParentType,
    ContextType,
    RequireFields<QueryBoardLeaderboardArgs, 'input'>
  >;
  boardsBySerialNumbers?: Resolver<
    Array<ResolversTypes['UserBoard']>,
    ParentType,
    ContextType,
    RequireFields<QueryBoardsBySerialNumbersArgs, 'serialNumbers'>
  >;
  browseProposals?: Resolver<
    ResolversTypes['ProposalConnection'],
    ParentType,
    ContextType,
    RequireFields<QueryBrowseProposalsArgs, 'input'>
  >;
  bulkClimbCommunityStatus?: Resolver<
    Array<ResolversTypes['ClimbCommunityStatus']>,
    ParentType,
    ContextType,
    RequireFields<QueryBulkClimbCommunityStatusArgs, 'angle' | 'boardType' | 'climbUuids'>
  >;
  bulkVoteSummaries?: Resolver<
    Array<ResolversTypes['VoteSummary']>,
    ParentType,
    ContextType,
    RequireFields<QueryBulkVoteSummariesArgs, 'input'>
  >;
  checkMoonBoardClimbDuplicates?: Resolver<
    Array<ResolversTypes['MoonBoardClimbDuplicateMatch']>,
    ParentType,
    ContextType,
    RequireFields<QueryCheckMoonBoardClimbDuplicatesArgs, 'input'>
  >;
  climb?: Resolver<
    Maybe<ResolversTypes['Climb']>,
    ParentType,
    ContextType,
    RequireFields<QueryClimbArgs, 'angle' | 'boardName' | 'climbUuid' | 'layoutId' | 'setIds' | 'sizeId'>
  >;
  climbClassicStatus?: Resolver<
    ResolversTypes['ClimbClassicStatus'],
    ParentType,
    ContextType,
    RequireFields<QueryClimbClassicStatusArgs, 'boardType' | 'climbUuid'>
  >;
  climbCommunityStatus?: Resolver<
    ResolversTypes['ClimbCommunityStatus'],
    ParentType,
    ContextType,
    RequireFields<QueryClimbCommunityStatusArgs, 'angle' | 'boardType' | 'climbUuid'>
  >;
  climbProposals?: Resolver<
    ResolversTypes['ProposalConnection'],
    ParentType,
    ContextType,
    RequireFields<QueryClimbProposalsArgs, 'input'>
  >;
  climbStatsHistory?: Resolver<
    Array<ResolversTypes['ClimbStatsHistoryEntry']>,
    ParentType,
    ContextType,
    RequireFields<QueryClimbStatsHistoryArgs, 'boardName' | 'climbUuid'>
  >;
  comments?: Resolver<
    ResolversTypes['CommentConnection'],
    ParentType,
    ContextType,
    RequireFields<QueryCommentsArgs, 'input'>
  >;
  communityRoles?: Resolver<
    Array<ResolversTypes['CommunityRoleAssignment']>,
    ParentType,
    ContextType,
    Partial<QueryCommunityRolesArgs>
  >;
  communitySettings?: Resolver<
    Array<ResolversTypes['CommunitySetting']>,
    ParentType,
    ContextType,
    RequireFields<QueryCommunitySettingsArgs, 'scope' | 'scopeKey'>
  >;
  defaultBoard?: Resolver<Maybe<ResolversTypes['UserBoard']>, ParentType, ContextType>;
  deleteAccountInfo?: Resolver<ResolversTypes['DeleteAccountInfo'], ParentType, ContextType>;
  discoverPlaylists?: Resolver<
    ResolversTypes['DiscoverPlaylistsResult'],
    ParentType,
    ContextType,
    RequireFields<QueryDiscoverPlaylistsArgs, 'input'>
  >;
  eventsReplay?: Resolver<
    ResolversTypes['EventsReplayResponse'],
    ParentType,
    ContextType,
    RequireFields<QueryEventsReplayArgs, 'sessionId' | 'sinceSequence'>
  >;
  favorites?: Resolver<
    Array<ResolversTypes['String']>,
    ParentType,
    ContextType,
    RequireFields<QueryFavoritesArgs, 'angle' | 'boardName' | 'climbUuids'>
  >;
  followers?: Resolver<
    ResolversTypes['FollowConnection'],
    ParentType,
    ContextType,
    RequireFields<QueryFollowersArgs, 'input'>
  >;
  following?: Resolver<
    ResolversTypes['FollowConnection'],
    ParentType,
    ContextType,
    RequireFields<QueryFollowingArgs, 'input'>
  >;
  followingAscentsFeed?: Resolver<
    ResolversTypes['FollowingAscentsFeedResult'],
    ParentType,
    ContextType,
    Partial<QueryFollowingAscentsFeedArgs>
  >;
  followingClimbAscents?: Resolver<
    ResolversTypes['FollowingClimbAscentsResult'],
    ParentType,
    ContextType,
    RequireFields<QueryFollowingClimbAscentsArgs, 'input'>
  >;
  globalAscentsFeed?: Resolver<
    ResolversTypes['FollowingAscentsFeedResult'],
    ParentType,
    ContextType,
    Partial<QueryGlobalAscentsFeedArgs>
  >;
  globalCommentFeed?: Resolver<
    ResolversTypes['CommentConnection'],
    ParentType,
    ContextType,
    Partial<QueryGlobalCommentFeedArgs>
  >;
  grades?: Resolver<
    Array<ResolversTypes['Grade']>,
    ParentType,
    ContextType,
    RequireFields<QueryGradesArgs, 'boardName'>
  >;
  groupedNotifications?: Resolver<
    ResolversTypes['GroupedNotificationConnection'],
    ParentType,
    ContextType,
    Partial<QueryGroupedNotificationsArgs>
  >;
  gym?: Resolver<Maybe<ResolversTypes['Gym']>, ParentType, ContextType, RequireFields<QueryGymArgs, 'gymUuid'>>;
  gymBySlug?: Resolver<
    Maybe<ResolversTypes['Gym']>,
    ParentType,
    ContextType,
    RequireFields<QueryGymBySlugArgs, 'slug'>
  >;
  gymMembers?: Resolver<
    ResolversTypes['GymMemberConnection'],
    ParentType,
    ContextType,
    RequireFields<QueryGymMembersArgs, 'input'>
  >;
  isFollowing?: Resolver<
    ResolversTypes['Boolean'],
    ParentType,
    ContextType,
    RequireFields<QueryIsFollowingArgs, 'userId'>
  >;
  myBoardSerialConfigs?: Resolver<
    Array<ResolversTypes['BoardSerialConfig']>,
    ParentType,
    ContextType,
    RequireFields<QueryMyBoardSerialConfigsArgs, 'serialNumbers'>
  >;
  myBoards?: Resolver<ResolversTypes['UserBoardConnection'], ParentType, ContextType, Partial<QueryMyBoardsArgs>>;
  myControllers?: Resolver<Array<ResolversTypes['ControllerInfo']>, ParentType, ContextType>;
  myGyms?: Resolver<ResolversTypes['GymConnection'], ParentType, ContextType, Partial<QueryMyGymsArgs>>;
  myNewClimbSubscriptions?: Resolver<Array<ResolversTypes['NewClimbSubscription']>, ParentType, ContextType>;
  myPinnedPlaylists?: Resolver<
    Array<ResolversTypes['Playlist']>,
    ParentType,
    ContextType,
    RequireFields<QueryMyPinnedPlaylistsArgs, 'input'>
  >;
  myRoles?: Resolver<Array<ResolversTypes['CommunityRoleAssignment']>, ParentType, ContextType>;
  mySessions?: Resolver<Array<ResolversTypes['DiscoverableSession']>, ParentType, ContextType>;
  mySmartPlaylistCounts?: Resolver<Array<ResolversTypes['SmartPlaylistCount']>, ParentType, ContextType>;
  nearbySessions?: Resolver<
    Array<ResolversTypes['DiscoverableSession']>,
    ParentType,
    ContextType,
    RequireFields<QueryNearbySessionsArgs, 'latitude' | 'longitude'>
  >;
  newClimbFeed?: Resolver<
    ResolversTypes['NewClimbFeedResult'],
    ParentType,
    ContextType,
    RequireFields<QueryNewClimbFeedArgs, 'input'>
  >;
  notifications?: Resolver<
    ResolversTypes['NotificationConnection'],
    ParentType,
    ContextType,
    Partial<QueryNotificationsArgs>
  >;
  playlist?: Resolver<
    Maybe<ResolversTypes['Playlist']>,
    ParentType,
    ContextType,
    RequireFields<QueryPlaylistArgs, 'playlistId'>
  >;
  playlistClimbs?: Resolver<
    ResolversTypes['PlaylistClimbsResult'],
    ParentType,
    ContextType,
    RequireFields<QueryPlaylistClimbsArgs, 'input'>
  >;
  playlistCreators?: Resolver<
    Array<ResolversTypes['PlaylistCreator']>,
    ParentType,
    ContextType,
    RequireFields<QueryPlaylistCreatorsArgs, 'input'>
  >;
  playlistsForClimb?: Resolver<
    Array<ResolversTypes['ID']>,
    ParentType,
    ContextType,
    RequireFields<QueryPlaylistsForClimbArgs, 'input'>
  >;
  playlistsForClimbs?: Resolver<
    Array<ResolversTypes['ClimbPlaylistMembership']>,
    ParentType,
    ContextType,
    RequireFields<QueryPlaylistsForClimbsArgs, 'input'>
  >;
  popularBoardConfigs?: Resolver<
    ResolversTypes['PopularBoardConfigConnection'],
    ParentType,
    ContextType,
    Partial<QueryPopularBoardConfigsArgs>
  >;
  profile?: Resolver<Maybe<ResolversTypes['UserProfile']>, ParentType, ContextType>;
  publicProfile?: Resolver<
    Maybe<ResolversTypes['PublicUserProfile']>,
    ParentType,
    ContextType,
    RequireFields<QueryPublicProfileArgs, 'userId'>
  >;
  recentBetaLinks?: Resolver<
    Array<ResolversTypes['RecentBetaLink']>,
    ParentType,
    ContextType,
    RequireFields<QueryRecentBetaLinksArgs, 'limit'>
  >;
  searchBoards?: Resolver<
    ResolversTypes['UserBoardConnection'],
    ParentType,
    ContextType,
    RequireFields<QuerySearchBoardsArgs, 'input'>
  >;
  searchClimbs?: Resolver<
    ResolversTypes['ClimbSearchResult'],
    ParentType,
    ContextType,
    RequireFields<QuerySearchClimbsArgs, 'input'>
  >;
  searchGyms?: Resolver<
    ResolversTypes['GymConnection'],
    ParentType,
    ContextType,
    RequireFields<QuerySearchGymsArgs, 'input'>
  >;
  searchPlaylists?: Resolver<
    ResolversTypes['SearchPlaylistsResult'],
    ParentType,
    ContextType,
    RequireFields<QuerySearchPlaylistsArgs, 'input'>
  >;
  searchUsers?: Resolver<
    ResolversTypes['UserSearchConnection'],
    ParentType,
    ContextType,
    RequireFields<QuerySearchUsersArgs, 'input'>
  >;
  searchUsersAndSetters?: Resolver<
    ResolversTypes['UnifiedSearchConnection'],
    ParentType,
    ContextType,
    RequireFields<QuerySearchUsersAndSettersArgs, 'input'>
  >;
  session?: Resolver<
    Maybe<ResolversTypes['Session']>,
    ParentType,
    ContextType,
    RequireFields<QuerySessionArgs, 'sessionId'>
  >;
  sessionDetail?: Resolver<
    Maybe<ResolversTypes['SessionDetail']>,
    ParentType,
    ContextType,
    RequireFields<QuerySessionDetailArgs, 'sessionId'>
  >;
  sessionGroupedFeed?: Resolver<
    ResolversTypes['SessionFeedResult'],
    ParentType,
    ContextType,
    Partial<QuerySessionGroupedFeedArgs>
  >;
  sessionSummary?: Resolver<
    Maybe<ResolversTypes['SessionSummary']>,
    ParentType,
    ContextType,
    RequireFields<QuerySessionSummaryArgs, 'sessionId'>
  >;
  setterClimbs?: Resolver<
    ResolversTypes['SetterClimbsConnection'],
    ParentType,
    ContextType,
    RequireFields<QuerySetterClimbsArgs, 'input'>
  >;
  setterClimbsFull?: Resolver<
    ResolversTypes['PlaylistClimbsResult'],
    ParentType,
    ContextType,
    RequireFields<QuerySetterClimbsFullArgs, 'input'>
  >;
  setterProfile?: Resolver<
    Maybe<ResolversTypes['SetterProfile']>,
    ParentType,
    ContextType,
    RequireFields<QuerySetterProfileArgs, 'input'>
  >;
  similarClimbs?: Resolver<
    Array<ResolversTypes['SimilarClimb']>,
    ParentType,
    ContextType,
    RequireFields<QuerySimilarClimbsArgs, 'input'>
  >;
  smartPlaylist?: Resolver<
    ResolversTypes['SmartPlaylistResult'],
    ParentType,
    ContextType,
    RequireFields<QuerySmartPlaylistArgs, 'input'>
  >;
  ticks?: Resolver<Array<ResolversTypes['Tick']>, ParentType, ContextType, RequireFields<QueryTicksArgs, 'input'>>;
  trendingFeed?: Resolver<
    ResolversTypes['ActivityFeedResult'],
    ParentType,
    ContextType,
    Partial<QueryTrendingFeedArgs>
  >;
  unreadNotificationCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userActiveBoards?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  userAscentsFeed?: Resolver<
    ResolversTypes['AscentFeedResult'],
    ParentType,
    ContextType,
    RequireFields<QueryUserAscentsFeedArgs, 'userId'>
  >;
  userBetaLinks?: Resolver<
    Array<ResolversTypes['RecentBetaLink']>,
    ParentType,
    ContextType,
    RequireFields<QueryUserBetaLinksArgs, 'limit' | 'userId'>
  >;
  userClimbPercentile?: Resolver<
    ResolversTypes['UserClimbPercentile'],
    ParentType,
    ContextType,
    RequireFields<QueryUserClimbPercentileArgs, 'userId'>
  >;
  userClimbs?: Resolver<
    ResolversTypes['PlaylistClimbsResult'],
    ParentType,
    ContextType,
    RequireFields<QueryUserClimbsArgs, 'input'>
  >;
  userFavoriteClimbs?: Resolver<
    ResolversTypes['PlaylistClimbsResult'],
    ParentType,
    ContextType,
    RequireFields<QueryUserFavoriteClimbsArgs, 'input'>
  >;
  userFavoritesCounts?: Resolver<Array<ResolversTypes['FavoritesCount']>, ParentType, ContextType>;
  userGroupedAscentsFeed?: Resolver<
    ResolversTypes['GroupedAscentFeedResult'],
    ParentType,
    ContextType,
    RequireFields<QueryUserGroupedAscentsFeedArgs, 'userId'>
  >;
  userPlaylists?: Resolver<
    Array<ResolversTypes['Playlist']>,
    ParentType,
    ContextType,
    RequireFields<QueryUserPlaylistsArgs, 'input'>
  >;
  userProfileStats?: Resolver<
    ResolversTypes['ProfileStats'],
    ParentType,
    ContextType,
    RequireFields<QueryUserProfileStatsArgs, 'userId'>
  >;
  userTicks?: Resolver<
    Array<ResolversTypes['Tick']>,
    ParentType,
    ContextType,
    RequireFields<QueryUserTicksArgs, 'boardType' | 'userId'>
  >;
  voteSummary?: Resolver<
    ResolversTypes['VoteSummary'],
    ParentType,
    ContextType,
    RequireFields<QueryVoteSummaryArgs, 'entityId' | 'entityType'>
  >;
}>;

export type QueueEventResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueEvent'] = ResolversParentTypes['QueueEvent'],
> = ResolversObject<{
  __resolveType: TypeResolveFn<
    'ClimbMirrored' | 'CurrentClimbChanged' | 'FullSync' | 'QueueItemAdded' | 'QueueItemRemoved' | 'QueueReordered',
    ParentType,
    ContextType
  >;
}>;

export type QueueItemAddedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueItemAdded'] = ResolversParentTypes['QueueItemAdded'],
> = ResolversObject<{
  item?: Resolver<ResolversTypes['ClimbQueueItem'], ParentType, ContextType>;
  position?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stateHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type QueueItemRemovedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueItemRemoved'] = ResolversParentTypes['QueueItemRemoved'],
> = ResolversObject<{
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stateHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type QueueItemUserResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueItemUser'] = ResolversParentTypes['QueueItemUser'],
> = ResolversObject<{
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  username?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type QueueNavigationContextResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueNavigationContext'] = ResolversParentTypes['QueueNavigationContext'],
> = ResolversObject<{
  currentIndex?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  nextClimb?: Resolver<Maybe<ResolversTypes['QueueNavigationItem']>, ParentType, ContextType>;
  previousClimbs?: Resolver<Array<ResolversTypes['QueueNavigationItem']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type QueueNavigationItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueNavigationItem'] = ResolversParentTypes['QueueNavigationItem'],
> = ResolversObject<{
  grade?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  gradeColor?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type QueueReorderedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueReordered'] = ResolversParentTypes['QueueReordered'],
> = ResolversObject<{
  newIndex?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  oldIndex?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stateHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type QueueStateResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['QueueState'] = ResolversParentTypes['QueueState'],
> = ResolversObject<{
  currentClimbQueueItem?: Resolver<Maybe<ResolversTypes['ClimbQueueItem']>, ParentType, ContextType>;
  queue?: Resolver<Array<ResolversTypes['ClimbQueueItem']>, ParentType, ContextType>;
  sequence?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  stateHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type RecentBetaLinkResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['RecentBetaLink'] = ResolversParentTypes['RecentBetaLink'],
> = ResolversObject<{
  betaLink?: Resolver<ResolversTypes['BetaLink'], ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SaveClimbResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SaveClimbResult'] = ResolversParentTypes['SaveClimbResult'],
> = ResolversObject<{
  createdAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  publishedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  synced?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SearchPlaylistsResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SearchPlaylistsResult'] = ResolversParentTypes['SearchPlaylistsResult'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  playlists?: Resolver<Array<ResolversTypes['DiscoverablePlaylist']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SendDeviceLogsResponseResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SendDeviceLogsResponse'] = ResolversParentTypes['SendDeviceLogsResponse'],
> = ResolversObject<{
  accepted?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Session'] = ResolversParentTypes['Session'],
> = ResolversObject<{
  boardPath?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  clientId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  color?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  driverParticipantId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  endedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  goal?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isLeader?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPermanent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPublic?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  lastConnectedBoardSerial?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  participantId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  queueState?: Resolver<ResolversTypes['QueueState'], ParentType, ContextType>;
  sharedPlaylistEnabled?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  startedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  users?: Resolver<Array<ResolversTypes['SessionUser']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionBoardSerialChangedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionBoardSerialChanged'] =
    ResolversParentTypes['SessionBoardSerialChanged'],
> = ResolversObject<{
  lastConnectedBoardSerial?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionDetailResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionDetail'] = ResolversParentTypes['SessionDetail'],
> = ResolversObject<{
  boardTypes?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  commentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  downvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  durationMinutes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  firstTickAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  goal?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gradeDistribution?: Resolver<Array<ResolversTypes['SessionGradeDistributionItem']>, ParentType, ContextType>;
  hardestGrade?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  healthKitWorkoutId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastTickAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  ownerUserId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  participants?: Resolver<Array<ResolversTypes['SessionFeedParticipant']>, ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  sessionName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sessionType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  tickCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ticks?: Resolver<Array<ResolversTypes['SessionDetailTick']>, ParentType, ContextType>;
  totalAttempts?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalFlashes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalSends?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  upvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  voteScore?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionDetailTickResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionDetailTick'] = ResolversParentTypes['SessionDetailTick'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  attemptCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  comment?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  difficulty?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isBenchmark?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isMirror?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isNoMatch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  quality?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  setterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  totalAttempts?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  upvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionEndedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionEnded'] = ResolversParentTypes['SessionEnded'],
> = ResolversObject<{
  newPath?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  reason?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionEventResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionEvent'] = ResolversParentTypes['SessionEvent'],
> = ResolversObject<{
  __resolveType: TypeResolveFn<
    | 'DriverChanged'
    | 'LeaderChanged'
    | 'SessionBoardSerialChanged'
    | 'SessionEnded'
    | 'SessionStatsUpdated'
    | 'SharedPlaylistToggled'
    | 'UserJoined'
    | 'UserLeft'
    | 'UserPresenceChanged'
    | 'WallConfirmedClimb',
    ParentType,
    ContextType
  >;
}>;

export type SessionFeedItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionFeedItem'] = ResolversParentTypes['SessionFeedItem'],
> = ResolversObject<{
  boardTypes?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  commentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  downvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  durationMinutes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  firstTickAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  goal?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gradeDistribution?: Resolver<Array<ResolversTypes['SessionGradeDistributionItem']>, ParentType, ContextType>;
  hardestGrade?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastTickAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  ownerUserId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  participants?: Resolver<Array<ResolversTypes['SessionFeedParticipant']>, ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  sessionName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sessionType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  tickCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalAttempts?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalFlashes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalSends?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  upvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  voteScore?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionFeedParticipantResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionFeedParticipant'] = ResolversParentTypes['SessionFeedParticipant'],
> = ResolversObject<{
  attempts?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  displayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  flashes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sends?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionFeedResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionFeedResult'] = ResolversParentTypes['SessionFeedResult'],
> = ResolversObject<{
  cursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sessions?: Resolver<Array<ResolversTypes['SessionFeedItem']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionGradeCountResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionGradeCount'] = ResolversParentTypes['SessionGradeCount'],
> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  grade?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionGradeDistributionItemResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionGradeDistributionItem'] =
    ResolversParentTypes['SessionGradeDistributionItem'],
> = ResolversObject<{
  attempt?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  flash?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  grade?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  send?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionHardestClimbResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionHardestClimb'] = ResolversParentTypes['SessionHardestClimb'],
> = ResolversObject<{
  climbName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  grade?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionParticipantResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionParticipant'] = ResolversParentTypes['SessionParticipant'],
> = ResolversObject<{
  attempts?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  displayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sends?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionStatsUpdatedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionStatsUpdated'] = ResolversParentTypes['SessionStatsUpdated'],
> = ResolversObject<{
  boardTypes?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  durationMinutes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  goal?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gradeDistribution?: Resolver<Array<ResolversTypes['SessionGradeDistributionItem']>, ParentType, ContextType>;
  hardestGrade?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  participants?: Resolver<Array<ResolversTypes['SessionFeedParticipant']>, ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  tickCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  ticks?: Resolver<Array<ResolversTypes['SessionDetailTick']>, ParentType, ContextType>;
  totalAttempts?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalFlashes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalSends?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionSummaryResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionSummary'] = ResolversParentTypes['SessionSummary'],
> = ResolversObject<{
  durationMinutes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  endedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  goal?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gradeDistribution?: Resolver<Array<ResolversTypes['SessionGradeCount']>, ParentType, ContextType>;
  hardestClimb?: Resolver<Maybe<ResolversTypes['SessionHardestClimb']>, ParentType, ContextType>;
  participants?: Resolver<Array<ResolversTypes['SessionParticipant']>, ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  startedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  totalAttempts?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalSends?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SessionUserResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SessionUser'] = ResolversParentTypes['SessionUser'],
> = ResolversObject<{
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  connectionState?: Resolver<ResolversTypes['SessionConnectionState'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  isLeader?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  userId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  username?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SetterClimbResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SetterClimb'] = ResolversParentTypes['SetterClimb'],
> = ResolversObject<{
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ascensionistCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  createdAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  qualityAverage?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SetterClimbsConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SetterClimbsConnection'] = ResolversParentTypes['SetterClimbsConnection'],
> = ResolversObject<{
  climbs?: Resolver<Array<ResolversTypes['SetterClimb']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SetterProfileResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SetterProfile'] = ResolversParentTypes['SetterProfile'],
> = ResolversObject<{
  boardTypes?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  climbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  followerCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  isFollowedByMe?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  linkedUserAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  linkedUserDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  linkedUserId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  username?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SetterSearchResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SetterSearchResult'] = ResolversParentTypes['SetterSearchResult'],
> = ResolversObject<{
  boardTypes?: Resolver<Array<ResolversTypes['String']>, ParentType, ContextType>;
  climbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  isFollowedByMe?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  username?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SharedPlaylistToggledResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SharedPlaylistToggled'] = ResolversParentTypes['SharedPlaylistToggled'],
> = ResolversObject<{
  enabled?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SimilarClimbResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SimilarClimb'] = ResolversParentTypes['SimilarClimb'],
> = ResolversObject<{
  angle?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  ascensionistCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  candidateHoldCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  compatibleSizeIds?: Resolver<Array<ResolversTypes['Int']>, ParentType, ContextType>;
  difficultyName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  frames?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  name?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  qualityAverage?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  setterUsername?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sharedHoldCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  similarity?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  targetHoldCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SmartPlaylistCountResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SmartPlaylistCount'] = ResolversParentTypes['SmartPlaylistCount'],
> = ResolversObject<{
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['SmartPlaylistType'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SmartPlaylistMetaResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SmartPlaylistMeta'] = ResolversParentTypes['SmartPlaylistMeta'],
> = ResolversObject<{
  climbCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['SmartPlaylistType'], ParentType, ContextType>;
  userAvatar?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  userName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SmartPlaylistResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['SmartPlaylistResult'] = ResolversParentTypes['SmartPlaylistResult'],
> = ResolversObject<{
  climbs?: Resolver<Array<ResolversTypes['Climb']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  meta?: Resolver<ResolversTypes['SmartPlaylistMeta'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type SubscriptionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Subscription'] = ResolversParentTypes['Subscription'],
> = ResolversObject<{
  boardHistoryEvents?: SubscriptionResolver<
    ResolversTypes['BoardHistoryEvent'],
    'boardHistoryEvents',
    ParentType,
    ContextType,
    RequireFields<SubscriptionBoardHistoryEventsArgs, 'boardSerial'>
  >;
  commentUpdates?: SubscriptionResolver<
    ResolversTypes['CommentEvent'],
    'commentUpdates',
    ParentType,
    ContextType,
    RequireFields<SubscriptionCommentUpdatesArgs, 'entityId' | 'entityType'>
  >;
  controllerEvents?: SubscriptionResolver<
    ResolversTypes['ControllerEvent'],
    'controllerEvents',
    ParentType,
    ContextType,
    RequireFields<SubscriptionControllerEventsArgs, 'sessionId'>
  >;
  newClimbCreated?: SubscriptionResolver<
    ResolversTypes['NewClimbCreatedEvent'],
    'newClimbCreated',
    ParentType,
    ContextType,
    RequireFields<SubscriptionNewClimbCreatedArgs, 'boardType' | 'layoutId'>
  >;
  notificationReceived?: SubscriptionResolver<
    ResolversTypes['NotificationEvent'],
    'notificationReceived',
    ParentType,
    ContextType
  >;
  queueUpdates?: SubscriptionResolver<
    ResolversTypes['QueueEvent'],
    'queueUpdates',
    ParentType,
    ContextType,
    RequireFields<SubscriptionQueueUpdatesArgs, 'sessionId'>
  >;
  sessionUpdates?: SubscriptionResolver<
    ResolversTypes['SessionEvent'],
    'sessionUpdates',
    ParentType,
    ContextType,
    RequireFields<SubscriptionSessionUpdatesArgs, 'sessionId'>
  >;
}>;

export type TickResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['Tick'] = ResolversParentTypes['Tick'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  attemptCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  auroraId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  auroraSyncedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  auroraType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  boardId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  climbedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  comment?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  commentCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  difficulty?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  downvotes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  effectiveDifficulty?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  isBenchmark?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isMirror?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  layoutId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  quality?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  sessionId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['TickStatus'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  upvotes?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type ToggleFavoriteResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['ToggleFavoriteResult'] = ResolversParentTypes['ToggleFavoriteResult'],
> = ResolversObject<{
  favorited?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UnifiedSearchConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UnifiedSearchConnection'] = ResolversParentTypes['UnifiedSearchConnection'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  results?: Resolver<Array<ResolversTypes['UnifiedSearchResult']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UnifiedSearchResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UnifiedSearchResult'] = ResolversParentTypes['UnifiedSearchResult'],
> = ResolversObject<{
  matchReason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  recentAscentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  setter?: Resolver<Maybe<ResolversTypes['SetterSearchResult']>, ParentType, ContextType>;
  user?: Resolver<Maybe<ResolversTypes['PublicUserProfile']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UpdateClimbResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UpdateClimbResult'] = ResolversParentTypes['UpdateClimbResult'],
> = ResolversObject<{
  createdAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  isDraft?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  publishedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserBoardResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserBoard'] = ResolversParentTypes['UserBoard'],
> = ResolversObject<{
  angle?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  boardType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  commentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  distanceMeters?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  followerCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  gymId?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  gymName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gymUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hideLocation?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isAngleAdjustable?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isFollowedByMe?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isOwned?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isPublic?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  isUnlisted?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  latitude?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  layoutId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  layoutName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  locationName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  longitude?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  ownerAvatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  ownerDisplayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  ownerId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  serialNumber?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  setIds?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  setNames?: Resolver<Maybe<Array<ResolversTypes['String']>>, ParentType, ContextType>;
  sizeDescription?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sizeId?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sizeName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  slug?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  totalAscents?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uniqueClimbers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserBoardConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserBoardConnection'] = ResolversParentTypes['UserBoardConnection'],
> = ResolversObject<{
  boards?: Resolver<Array<ResolversTypes['UserBoard']>, ParentType, ContextType>;
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserClimbPercentileResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserClimbPercentile'] = ResolversParentTypes['UserClimbPercentile'],
> = ResolversObject<{
  percentile?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  totalActiveUsers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalDistinctClimbs?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserJoinedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserJoined'] = ResolversParentTypes['UserJoined'],
> = ResolversObject<{
  user?: Resolver<ResolversTypes['SessionUser'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserLeftResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserLeft'] = ResolversParentTypes['UserLeft'],
> = ResolversObject<{
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserPresenceChangedResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserPresenceChanged'] = ResolversParentTypes['UserPresenceChanged'],
> = ResolversObject<{
  user?: Resolver<ResolversTypes['SessionUser'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserProfileResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserProfile'] = ResolversParentTypes['UserProfile'],
> = ResolversObject<{
  avatarUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  displayName?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  email?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserSearchConnectionResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserSearchConnection'] = ResolversParentTypes['UserSearchConnection'],
> = ResolversObject<{
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  results?: Resolver<Array<ResolversTypes['UserSearchResult']>, ParentType, ContextType>;
  totalCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type UserSearchResultResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['UserSearchResult'] = ResolversParentTypes['UserSearchResult'],
> = ResolversObject<{
  matchReason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  recentAscentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  user?: Resolver<ResolversTypes['PublicUserProfile'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type VoteSummaryResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['VoteSummary'] = ResolversParentTypes['VoteSummary'],
> = ResolversObject<{
  downvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  entityId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  entityType?: Resolver<ResolversTypes['SocialEntityType'], ParentType, ContextType>;
  upvotes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userVote?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  voteScore?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type WallConfirmedClimbResolvers<
  ContextType = ConnectionContext,
  ParentType extends ResolversParentTypes['WallConfirmedClimb'] = ResolversParentTypes['WallConfirmedClimb'],
> = ResolversObject<{
  climbUuid?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  confirmedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  confirmedByParticipantId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  queueItemUuid?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
}>;

export type Resolvers<ContextType = ConnectionContext> = ResolversObject<{
  ActivityFeedItem?: ActivityFeedItemResolvers<ContextType>;
  ActivityFeedResult?: ActivityFeedResultResolvers<ContextType>;
  AllUserPlaylistsResult?: AllUserPlaylistsResultResolvers<ContextType>;
  Angle?: AngleResolvers<ContextType>;
  AscentFeedItem?: AscentFeedItemResolvers<ContextType>;
  AscentFeedResult?: AscentFeedResultResolvers<ContextType>;
  AuroraCredential?: AuroraCredentialResolvers<ContextType>;
  AuroraCredentialStatus?: AuroraCredentialStatusResolvers<ContextType>;
  BetaLink?: BetaLinkResolvers<ContextType>;
  BoardHistoryEntry?: BoardHistoryEntryResolvers<ContextType>;
  BoardHistoryEntryAdded?: BoardHistoryEntryAddedResolvers<ContextType>;
  BoardHistoryEvent?: BoardHistoryEventResolvers<ContextType>;
  BoardHistoryFullSync?: BoardHistoryFullSyncResolvers<ContextType>;
  BoardLeaderboard?: BoardLeaderboardResolvers<ContextType>;
  BoardLeaderboardEntry?: BoardLeaderboardEntryResolvers<ContextType>;
  BoardSerialConfig?: BoardSerialConfigResolvers<ContextType>;
  BoardSession?: BoardSessionResolvers<ContextType>;
  Climb?: ClimbResolvers<ContextType>;
  ClimbClassicStatus?: ClimbClassicStatusResolvers<ContextType>;
  ClimbCommunityStatus?: ClimbCommunityStatusResolvers<ContextType>;
  ClimbMatchResult?: ClimbMatchResultResolvers<ContextType>;
  ClimbMirrored?: ClimbMirroredResolvers<ContextType>;
  ClimbPlaylistMembership?: ClimbPlaylistMembershipResolvers<ContextType>;
  ClimbQueueItem?: ClimbQueueItemResolvers<ContextType>;
  ClimbSearchResult?: ClimbSearchResultResolvers<ContextType>;
  ClimbStatsHistoryEntry?: ClimbStatsHistoryEntryResolvers<ContextType>;
  Comment?: CommentResolvers<ContextType>;
  CommentAdded?: CommentAddedResolvers<ContextType>;
  CommentConnection?: CommentConnectionResolvers<ContextType>;
  CommentDeleted?: CommentDeletedResolvers<ContextType>;
  CommentEvent?: CommentEventResolvers<ContextType>;
  CommentUpdated?: CommentUpdatedResolvers<ContextType>;
  CommunityRoleAssignment?: CommunityRoleAssignmentResolvers<ContextType>;
  CommunitySetting?: CommunitySettingResolvers<ContextType>;
  ControllerEvent?: ControllerEventResolvers<ContextType>;
  ControllerInfo?: ControllerInfoResolvers<ContextType>;
  ControllerPing?: ControllerPingResolvers<ContextType>;
  ControllerQueueItem?: ControllerQueueItemResolvers<ContextType>;
  ControllerQueueSync?: ControllerQueueSyncResolvers<ContextType>;
  ControllerRegistration?: ControllerRegistrationResolvers<ContextType>;
  CurrentClimbChanged?: CurrentClimbChangedResolvers<ContextType>;
  DeleteAccountInfo?: DeleteAccountInfoResolvers<ContextType>;
  DiscoverPlaylistsResult?: DiscoverPlaylistsResultResolvers<ContextType>;
  DiscoverablePlaylist?: DiscoverablePlaylistResolvers<ContextType>;
  DiscoverableSession?: DiscoverableSessionResolvers<ContextType>;
  DriverChanged?: DriverChangedResolvers<ContextType>;
  EventsReplayResponse?: EventsReplayResponseResolvers<ContextType>;
  FavoritesCount?: FavoritesCountResolvers<ContextType>;
  FollowConnection?: FollowConnectionResolvers<ContextType>;
  FollowingAscentFeedItem?: FollowingAscentFeedItemResolvers<ContextType>;
  FollowingAscentsFeedResult?: FollowingAscentsFeedResultResolvers<ContextType>;
  FollowingClimbAscentsResult?: FollowingClimbAscentsResultResolvers<ContextType>;
  FullSync?: FullSyncResolvers<ContextType>;
  Grade?: GradeResolvers<ContextType>;
  GradeCount?: GradeCountResolvers<ContextType>;
  GroupedAscentFeedItem?: GroupedAscentFeedItemResolvers<ContextType>;
  GroupedAscentFeedResult?: GroupedAscentFeedResultResolvers<ContextType>;
  GroupedNotification?: GroupedNotificationResolvers<ContextType>;
  GroupedNotificationActor?: GroupedNotificationActorResolvers<ContextType>;
  GroupedNotificationConnection?: GroupedNotificationConnectionResolvers<ContextType>;
  Gym?: GymResolvers<ContextType>;
  GymConnection?: GymConnectionResolvers<ContextType>;
  GymMember?: GymMemberResolvers<ContextType>;
  GymMemberConnection?: GymMemberConnectionResolvers<ContextType>;
  JSON?: GraphQLScalarType;
  LayoutStats?: LayoutStatsResolvers<ContextType>;
  LeaderChanged?: LeaderChangedResolvers<ContextType>;
  LedCommand?: LedCommandResolvers<ContextType>;
  LedUpdate?: LedUpdateResolvers<ContextType>;
  MoonBoardClimbDuplicateMatch?: MoonBoardClimbDuplicateMatchResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  NewClimbCreatedEvent?: NewClimbCreatedEventResolvers<ContextType>;
  NewClimbFeedItem?: NewClimbFeedItemResolvers<ContextType>;
  NewClimbFeedResult?: NewClimbFeedResultResolvers<ContextType>;
  NewClimbSubscription?: NewClimbSubscriptionResolvers<ContextType>;
  Notification?: NotificationResolvers<ContextType>;
  NotificationConnection?: NotificationConnectionResolvers<ContextType>;
  NotificationEvent?: NotificationEventResolvers<ContextType>;
  OutlierAnalysis?: OutlierAnalysisResolvers<ContextType>;
  Playlist?: PlaylistResolvers<ContextType>;
  PlaylistClimb?: PlaylistClimbResolvers<ContextType>;
  PlaylistClimbsResult?: PlaylistClimbsResultResolvers<ContextType>;
  PlaylistCreator?: PlaylistCreatorResolvers<ContextType>;
  PopularBoardConfig?: PopularBoardConfigResolvers<ContextType>;
  PopularBoardConfigConnection?: PopularBoardConfigConnectionResolvers<ContextType>;
  ProfileStats?: ProfileStatsResolvers<ContextType>;
  Proposal?: ProposalResolvers<ContextType>;
  ProposalConnection?: ProposalConnectionResolvers<ContextType>;
  ProposalVoteSummary?: ProposalVoteSummaryResolvers<ContextType>;
  PublicUserProfile?: PublicUserProfileResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  QueueEvent?: QueueEventResolvers<ContextType>;
  QueueItemAdded?: QueueItemAddedResolvers<ContextType>;
  QueueItemRemoved?: QueueItemRemovedResolvers<ContextType>;
  QueueItemUser?: QueueItemUserResolvers<ContextType>;
  QueueNavigationContext?: QueueNavigationContextResolvers<ContextType>;
  QueueNavigationItem?: QueueNavigationItemResolvers<ContextType>;
  QueueReordered?: QueueReorderedResolvers<ContextType>;
  QueueState?: QueueStateResolvers<ContextType>;
  RecentBetaLink?: RecentBetaLinkResolvers<ContextType>;
  SaveClimbResult?: SaveClimbResultResolvers<ContextType>;
  SearchPlaylistsResult?: SearchPlaylistsResultResolvers<ContextType>;
  SendDeviceLogsResponse?: SendDeviceLogsResponseResolvers<ContextType>;
  Session?: SessionResolvers<ContextType>;
  SessionBoardSerialChanged?: SessionBoardSerialChangedResolvers<ContextType>;
  SessionDetail?: SessionDetailResolvers<ContextType>;
  SessionDetailTick?: SessionDetailTickResolvers<ContextType>;
  SessionEnded?: SessionEndedResolvers<ContextType>;
  SessionEvent?: SessionEventResolvers<ContextType>;
  SessionFeedItem?: SessionFeedItemResolvers<ContextType>;
  SessionFeedParticipant?: SessionFeedParticipantResolvers<ContextType>;
  SessionFeedResult?: SessionFeedResultResolvers<ContextType>;
  SessionGradeCount?: SessionGradeCountResolvers<ContextType>;
  SessionGradeDistributionItem?: SessionGradeDistributionItemResolvers<ContextType>;
  SessionHardestClimb?: SessionHardestClimbResolvers<ContextType>;
  SessionParticipant?: SessionParticipantResolvers<ContextType>;
  SessionStatsUpdated?: SessionStatsUpdatedResolvers<ContextType>;
  SessionSummary?: SessionSummaryResolvers<ContextType>;
  SessionUser?: SessionUserResolvers<ContextType>;
  SetterClimb?: SetterClimbResolvers<ContextType>;
  SetterClimbsConnection?: SetterClimbsConnectionResolvers<ContextType>;
  SetterProfile?: SetterProfileResolvers<ContextType>;
  SetterSearchResult?: SetterSearchResultResolvers<ContextType>;
  SharedPlaylistToggled?: SharedPlaylistToggledResolvers<ContextType>;
  SimilarClimb?: SimilarClimbResolvers<ContextType>;
  SmartPlaylistCount?: SmartPlaylistCountResolvers<ContextType>;
  SmartPlaylistMeta?: SmartPlaylistMetaResolvers<ContextType>;
  SmartPlaylistResult?: SmartPlaylistResultResolvers<ContextType>;
  Subscription?: SubscriptionResolvers<ContextType>;
  Tick?: TickResolvers<ContextType>;
  ToggleFavoriteResult?: ToggleFavoriteResultResolvers<ContextType>;
  UnifiedSearchConnection?: UnifiedSearchConnectionResolvers<ContextType>;
  UnifiedSearchResult?: UnifiedSearchResultResolvers<ContextType>;
  UpdateClimbResult?: UpdateClimbResultResolvers<ContextType>;
  UserBoard?: UserBoardResolvers<ContextType>;
  UserBoardConnection?: UserBoardConnectionResolvers<ContextType>;
  UserClimbPercentile?: UserClimbPercentileResolvers<ContextType>;
  UserJoined?: UserJoinedResolvers<ContextType>;
  UserLeft?: UserLeftResolvers<ContextType>;
  UserPresenceChanged?: UserPresenceChangedResolvers<ContextType>;
  UserProfile?: UserProfileResolvers<ContextType>;
  UserSearchConnection?: UserSearchConnectionResolvers<ContextType>;
  UserSearchResult?: UserSearchResultResolvers<ContextType>;
  VoteSummary?: VoteSummaryResolvers<ContextType>;
  WallConfirmedClimb?: WallConfirmedClimbResolvers<ContextType>;
}>;
