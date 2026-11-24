import type { SprayWallImportProgress } from '../spray-detection';
import type { PrivacyLocationAudience, PrivacyResourceAudience } from '../generated/types';

// Board entity types
export type ObservedBoardSerialInput = { boardType: string; observedSerialNumber: string };
export type ObservedBoardSerialMatch = ObservedBoardSerialInput & { candidates: UserBoard[] };

export type UserBoard = {
  uuid: string;
  slug: string;
  ownerId: string | null;
  ownerDisplayName?: string;
  ownerAvatarUrl?: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  description?: string | null;
  locationName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic: boolean;
  isUnlisted: boolean;
  hideLocation: boolean;
  isOwned: boolean;
  angle: number;
  isAngleAdjustable: boolean;
  /**
   * Whether this wall has an LED light kit. Optional on the client so a stale
   * persisted board snapshot (or a query that omits the field) degrades to
   * "has LEDs" instead of undefined. Every consumer branches on `=== false`.
   */
  hasLeds?: boolean;
  /**
   * An internet-connected wall device lights this wall from the board feed, so
   * climbers take the wall with no Bluetooth link. Optional for the same reason
   * as `hasLeds`; only an explicit `true` changes behaviour.
   */
  litByWallDevice?: boolean;
  createdAt: string;
  layoutName?: string | null;
  sizeName?: string | null;
  sizeDescription?: string | null;
  setNames?: string[] | null;
  totalAscents: number;
  uniqueClimbers: number;
  followerCount: number;
  commentCount: number;
  isFollowedByMe: boolean;
  gymId?: number | null;
  /** Numeric board-presence channel id (userBoards.id); set whenever the viewer may read the board. Feeds boardNowPlaying(boardId); the id alone is the no-link reading, so an Unlisted board's presence also needs `boardUuid`. */
  boardId?: number | null;
  gymUuid?: string | null;
  gymName?: string | null;
  gymIsListed?: boolean | null;
  distanceMeters?: number | null;
  serialNumber?: string | null;
  timerName?: string | null;
  /** Whether the current viewer may edit this board (owner, community admin/leader for its board type, or owner/admin of its linked gym). */
  canEdit?: boolean;
  /**
   * Whether the viewer may delete this board: its owner, the owner/admin of its
   * linked gym on a synced (system-owned) board, or a global admin. Optional here
   * (though `Boolean!` on the wire) for the same reason as `canEdit`: an offline
   * snapshot written before the field existed never carries it. Every document
   * that selects BOARD_FIELDS or GYM_BOARD_FIELDS asks for it.
   */
  canDelete?: boolean;
  /**
   * Whether the viewer may take this board off its gym's listing: its owner
   * (`linkBoardToGym` with no gym) or anyone with edit access to that gym
   * (`detachBoardFromGym`). A synced (system-owned) board is deleted instead,
   * so only a global admin may remove one. Optional for the same reason as
   * `canEdit`.
   */
  canRemoveFromGym?: boolean;
  /**
   * Waiting directory reports the viewer can act on (creator, the gym staff a
   * report went to, global admins); null for anyone else. Optional for the same
   * reason as `canEdit`. See docs/product/directory-reports.md.
   */
  openReportCount?: number | null;
  /** Whether the viewer is a reporter on a waiting report about this board; null signed out. */
  viewerHasOpenReport?: boolean | null;
  /**
   * Whether the viewer pinned this board to the front of their board list.
   * Optional here (though `Boolean!` on the wire) for the same reason as
   * `canEdit`: clients build partial UserBoards from offline snapshots and board
   * paths, and a snapshot written before this field existed will never carry it.
   */
  isPinnedByMe?: boolean;
  sprayImport?: SprayWallImportProgress | null;
};

export type UserBoardConnection = {
  boards: UserBoard[];
  totalCount: number;
  hasMore: boolean;
};

export type BoardLeaderboardEntry = {
  userId: string | null;
  userDisplayName?: string;
  userAvatarUrl?: string;
  rank: number;
  totalSends: number;
  totalFlashes: number;
  hardestGrade?: number | null;
  hardestGradeName?: string | null;
  totalSessions: number;
};

export type BoardLeaderboard = {
  boardUuid: string;
  entries: BoardLeaderboardEntry[];
  totalCount: number;
  hasMore: boolean;
  periodLabel: string;
};

export type CreateBoardInput = {
  audience?: PrivacyResourceAudience;
  locationAudience?: PrivacyLocationAudience;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  description?: string;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  isOwned?: boolean;
  gymUuid?: string;
  angle?: number;
  isAngleAdjustable?: boolean;
  hasLeds?: boolean;
  litByWallDevice?: boolean;
  serialNumber?: string;
  timerName?: string | null;
  /**
   * Create even though the caller already owns this configuration at this
   * place. Set only after the user confirms it is a different physical wall.
   */
  allowDuplicateConfig?: boolean;
  // Opt-in for creating a board whose serial is already registered to another
  // user's same-config board; without it such creates fail BOARD_SERIAL_EXISTS.
  allowDuplicateSerial?: boolean;
  /**
   * Opt in to the existing-wall recheck (#8151). Absent keeps the old
   * behaviour; see `ExistingWallCheck`.
   */
  existingWallCheck?: ExistingWallCheck;
  /** With CONFIRMED_SEPARATE: the walls the climber saw and said are different. At most 40. */
  acknowledgedWallUuids?: string[];
};

/**
 * How createBoard treats walls that already exist where the new board lands.
 * REJECT_IF_FOUND refuses on a same-layout wall; CONFIRMED_SEPARATE refuses only
 * on a same-setup wall the climber didn't acknowledge.
 */
export type ExistingWallCheck = 'REJECT_IF_FOUND' | 'CONFIRMED_SEPARATE';

/** How an existing wall compares with a draft setup. `classifyWallMatch` in @boardsesh/board-config computes it. */
export type WallMatchKind = 'EXACT' | 'SETS_DIFFER' | 'LAYOUT_OR_SIZE_DIFFERS';

/** Where an existing wall was found relative to the chosen gym. */
export type WallCandidateSource = 'SELECTED_GYM' | 'MERGED_LISTING' | 'NEARBY_LISTING';

export type ExistingWallCandidatesInput = {
  boardType: string;
  gymUuid: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  limit?: number;
};

export type ExistingWallCandidate = {
  board: UserBoard;
  matchKind: WallMatchKind | null;
  missingSetIds: number[];
  extraSetIds: number[];
  source: WallCandidateSource;
  gymName: string;
  gymDistanceMeters: number | null;
};

export type ExistingWallCandidates = {
  candidates: ExistingWallCandidate[];
  truncated: boolean;
};

export type UpdateBoardInput = {
  boardUuid: string;
  name?: string;
  slug?: string;
  // Nullable clearable fields: `undefined` leaves the value unchanged, `null`
  // clears it server-side (the resolver applies any value that isn't undefined,
  // and the Zod schema accepts null). The edit form sends null for an emptied
  // field that previously had a value.
  description?: string | null;
  locationName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  isOwned?: boolean;
  angle?: number;
  isAngleAdjustable?: boolean;
  hasLeds?: boolean;
  litByWallDevice?: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  serialNumber?: string | null;
  timerName?: string | null;
  /**
   * Save even though the owner already has another board with the resulting
   * configuration at this place. Set only after the user confirms it is a
   * different physical wall.
   */
  allowDuplicateConfig?: boolean;
};

export type BoardLeaderboardInput = {
  boardUuid: string;
  period?: string;
  limit?: number;
  offset?: number;
};

export type MyBoardsInput = {
  limit?: number;
  offset?: number;
  /** Also list the viewer's own never-published spray walls (My Boards / Manage only). */
  includeUnfinishedSprayWalls?: boolean;
};

export type FollowBoardInput = {
  boardUuid: string;
};

export type BoardDiscoveryInput = {
  gymUuid?: string;
  limit?: number;
};

export type BoardDiscoveryClimb = {
  uuid: string;
  name: string | null;
  frames: string;
  angle: number;
};

export type BoardDiscoveryBoard = {
  uuid: string;
  slug: string;
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  gymUuid: string;
  gymName: string;
  gymSlug: string;
  locationName: string | null;
  uniqueClimbers: number;
  currentClimb: BoardDiscoveryClimb | null;
  popularClimb?: BoardDiscoveryClimb | null;
};

export type SearchBoardsInput = {
  query?: string;
  boardType?: string;
  boardTypes?: string[];
  angles?: number[];
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit?: number;
  offset?: number;
};

export type PopularBoardConfig = {
  boardType: string;
  layoutId: number;
  layoutName?: string | null;
  sizeId: number;
  sizeName?: string | null;
  sizeDescription?: string | null;
  setIds: number[];
  setNames: string[];
  climbCount: number;
  totalAscents: number;
  boardCount: number;
  displayName: string;
};

export type PopularBoardConfigConnection = {
  configs: PopularBoardConfig[];
  totalCount: number;
  hasMore: boolean;
};

export type PopularBoardConfigsInput = {
  boardType?: string;
  limit?: number;
  offset?: number;
};
