import { gql } from 'graphql-request';

// Fragment for playlist fields
export const PLAYLIST_FIELDS = gql`
  fragment PlaylistFields on Playlist {
    id
    uuid
    boardType
    layoutId
    name
    description
    isPublic
    color
    icon
    createdAt
    updatedAt
    lastAccessedAt
    climbCount
    userRole
    followerCount
    isFollowedByMe
    isPinnedByMe
  }
`;

// Get user's playlists for a board+layout
export const GET_USER_PLAYLISTS = gql`
  ${PLAYLIST_FIELDS}
  query GetUserPlaylists($input: GetUserPlaylistsInput!) {
    userPlaylists(input: $input) {
      ...PlaylistFields
    }
  }
`;

// Get all user's playlists across boards (optional board filter, paginated)
export const GET_ALL_USER_PLAYLISTS = gql`
  ${PLAYLIST_FIELDS}
  query GetAllUserPlaylists($input: GetAllUserPlaylistsInput!) {
    allUserPlaylists(input: $input) {
      playlists {
        ...PlaylistFields
      }
      totalCount
      hasMore
    }
  }
`;

// Get the authenticated user's pinned playlists
export const GET_MY_PINNED_PLAYLISTS = gql`
  ${PLAYLIST_FIELDS}
  query GetMyPinnedPlaylists($input: GetMyPinnedPlaylistsInput!) {
    myPinnedPlaylists(input: $input) {
      ...PlaylistFields
    }
  }
`;

// Pin a playlist (idempotent)
export const PIN_PLAYLIST = gql`
  mutation PinPlaylist($input: PinPlaylistInput!) {
    pinPlaylist(input: $input)
  }
`;

// Unpin a playlist (idempotent)
export const UNPIN_PLAYLIST = gql`
  mutation UnpinPlaylist($input: PinPlaylistInput!) {
    unpinPlaylist(input: $input)
  }
`;

// Get playlist by ID
export const GET_PLAYLIST = gql`
  ${PLAYLIST_FIELDS}
  query GetPlaylist($playlistId: ID!) {
    playlist(playlistId: $playlistId) {
      ...PlaylistFields
    }
  }
`;

// Get playlists containing a climb (returns playlist IDs)
export const GET_PLAYLISTS_FOR_CLIMB = gql`
  query GetPlaylistsForClimb($input: GetPlaylistsForClimbInput!) {
    playlistsForClimb(input: $input)
  }
`;

// Get playlist memberships for multiple climbs in a single request
export const GET_PLAYLISTS_FOR_CLIMBS = gql`
  query GetPlaylistsForClimbs($input: GetPlaylistsForClimbsInput!) {
    playlistsForClimbs(input: $input) {
      climbUuid
      playlistUuids
    }
  }
`;

// Create new playlist
export const CREATE_PLAYLIST = gql`
  ${PLAYLIST_FIELDS}
  mutation CreatePlaylist($input: CreatePlaylistInput!) {
    createPlaylist(input: $input) {
      ...PlaylistFields
    }
  }
`;

// Update playlist
export const UPDATE_PLAYLIST = gql`
  ${PLAYLIST_FIELDS}
  mutation UpdatePlaylist($input: UpdatePlaylistInput!) {
    updatePlaylist(input: $input) {
      ...PlaylistFields
    }
  }
`;

// Delete playlist
export const DELETE_PLAYLIST = gql`
  mutation DeletePlaylist($playlistId: ID!) {
    deletePlaylist(playlistId: $playlistId)
  }
`;

// Add climb to playlist
export const ADD_CLIMB_TO_PLAYLIST = gql`
  mutation AddClimbToPlaylist($input: AddClimbToPlaylistInput!) {
    addClimbToPlaylist(input: $input) {
      id
      playlistId
      climbUuid
      angle
      position
      addedAt
    }
  }
`;

// Remove climb from playlist
export const REMOVE_CLIMB_FROM_PLAYLIST = gql`
  mutation RemoveClimbFromPlaylist($input: RemoveClimbFromPlaylistInput!) {
    removeClimbFromPlaylist(input: $input)
  }
`;

// Reorder a climb within a playlist (single move to a new 0-based index)
export const REORDER_PLAYLIST_CLIMB = gql`
  mutation ReorderPlaylistClimb($input: ReorderPlaylistClimbInput!) {
    reorderPlaylistClimb(input: $input)
  }
`;

// Get climbs in a playlist with full climb data
export const GET_PLAYLIST_CLIMBS = gql`
  query GetPlaylistClimbs($input: GetPlaylistClimbsInput!) {
    playlistClimbs(input: $input) {
      climbs {
        uuid
        layoutId
        boardType
        setter_username
        name
        description
        frames
        framesCount
        framesPace
        angle
        ascensionist_count
        difficulty
        quality_average
        stars
        difficulty_error
        benchmark_difficulty
      }
      totalCount
      hasMore
    }
  }
`;

// TypeScript types for operations

export type Playlist = {
  id: string;
  uuid: string;
  boardType: string;
  layoutId?: number | null; // Nullable for Aurora-synced circuits
  name: string;
  description?: string;
  isPublic: boolean;
  color?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string | null;
  climbCount: number;
  userRole?: string;
  followerCount: number;
  isFollowedByMe: boolean;
  isPinnedByMe: boolean;
};

export type GetAllUserPlaylistsInput = {
  boardType?: string;
  layoutId?: number;
  page?: number;
  pageSize?: number;
};

export type GetAllUserPlaylistsQueryVariables = {
  input: GetAllUserPlaylistsInput;
};

export type AllUserPlaylistsResult = {
  playlists: Playlist[];
  totalCount: number;
  hasMore: boolean;
};

export type GetAllUserPlaylistsQueryResponse = {
  allUserPlaylists: AllUserPlaylistsResult;
};

export type GetMyPinnedPlaylistsInput = {
  boardType?: string;
  layoutId?: number;
};

export type GetMyPinnedPlaylistsQueryVariables = {
  input: GetMyPinnedPlaylistsInput;
};

export type GetMyPinnedPlaylistsQueryResponse = {
  myPinnedPlaylists: Playlist[];
};

export type PinPlaylistInput = {
  playlistUuid: string;
};

export type PinPlaylistMutationVariables = {
  input: PinPlaylistInput;
};

export type PinPlaylistMutationResponse = {
  pinPlaylist: boolean;
};

export type UnpinPlaylistMutationVariables = {
  input: PinPlaylistInput;
};

export type UnpinPlaylistMutationResponse = {
  unpinPlaylist: boolean;
};

export type GetUserPlaylistsInput = {
  boardType: string;
  layoutId: number;
};

export type GetUserPlaylistsQueryVariables = {
  input: GetUserPlaylistsInput;
};

export type GetUserPlaylistsQueryResponse = {
  userPlaylists: Playlist[];
};

export type GetPlaylistQueryVariables = {
  playlistId: string;
};

export type GetPlaylistQueryResponse = {
  playlist: Playlist | null;
};

export type GetPlaylistsForClimbInput = {
  boardType: string;
  layoutId: number;
  climbUuid: string;
};

export type GetPlaylistsForClimbQueryVariables = {
  input: GetPlaylistsForClimbInput;
};

export type GetPlaylistsForClimbQueryResponse = {
  playlistsForClimb: string[];
};

export type GetPlaylistsForClimbsInput = {
  boardType: string;
  layoutId: number;
  climbUuids: string[];
};

export type GetPlaylistsForClimbsQueryVariables = {
  input: GetPlaylistsForClimbsInput;
};

export type ClimbPlaylistMembership = {
  climbUuid: string;
  playlistUuids: string[];
};

export type GetPlaylistsForClimbsQueryResponse = {
  playlistsForClimbs: ClimbPlaylistMembership[];
};

export type CreatePlaylistInput = {
  boardType: string;
  layoutId: number;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
};

export type CreatePlaylistMutationVariables = {
  input: CreatePlaylistInput;
};

export type CreatePlaylistMutationResponse = {
  createPlaylist: Playlist;
};

export type UpdatePlaylistInput = {
  playlistId: string;
  name?: string;
  description?: string;
  isPublic?: boolean;
  color?: string;
  icon?: string;
};

export type UpdatePlaylistMutationVariables = {
  input: UpdatePlaylistInput;
};

export type UpdatePlaylistMutationResponse = {
  updatePlaylist: Playlist;
};

export type DeletePlaylistMutationVariables = {
  playlistId: string;
};

export type DeletePlaylistMutationResponse = {
  deletePlaylist: boolean;
};

export type AddClimbToPlaylistInput = {
  playlistId: string;
  climbUuid: string;
  angle: number;
};

export type AddClimbToPlaylistMutationVariables = {
  input: AddClimbToPlaylistInput;
};

export type AddClimbToPlaylistMutationResponse = {
  addClimbToPlaylist: {
    id: string;
    playlistId: string;
    climbUuid: string;
    angle: number;
    position: number;
    addedAt: string;
  };
};

export type RemoveClimbFromPlaylistInput = {
  playlistId: string;
  climbUuid: string;
};

export type RemoveClimbFromPlaylistMutationVariables = {
  input: RemoveClimbFromPlaylistInput;
};

export type RemoveClimbFromPlaylistMutationResponse = {
  removeClimbFromPlaylist: boolean;
};

export type ReorderPlaylistClimbInput = {
  playlistId: string;
  climbUuid: string;
  newIndex: number;
};

export type ReorderPlaylistClimbMutationVariables = {
  input: ReorderPlaylistClimbInput;
};

export type ReorderPlaylistClimbMutationResponse = {
  reorderPlaylistClimb: boolean;
};

export type GetPlaylistClimbsInput = {
  playlistId: string;
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  angle?: number;
  // All-boards mode only: render on-active-board climbs' grades at the user's
  // selected angle instead of the added-at / most-ascents fallback.
  activeBoardName?: string;
  activeAngle?: number;
  page?: number;
  pageSize?: number;
};

export type GetPlaylistClimbsQueryVariables = {
  input: GetPlaylistClimbsInput;
};

export type PlaylistClimbsResult = {
  climbs: Array<{
    uuid: string;
    layoutId?: number | null;
    boardType?: string;
    setter_username: string;
    name: string;
    description: string;
    frames: string;
    framesCount?: number | null;
    framesPace?: number | null;
    angle: number;
    ascensionist_count: number;
    difficulty: string;
    quality_average: string;
    stars: number;
    difficulty_error: string;
    benchmark_difficulty: string | null;
  }>;
  totalCount: number;
  hasMore: boolean;
};

export type GetPlaylistClimbsQueryResponse = {
  playlistClimbs: PlaylistClimbsResult;
};

// ============================================
// Discover Playlists Types and Operations
// ============================================

// Playlist creator info for autocomplete
export type PlaylistCreator = {
  userId: string;
  displayName: string;
  playlistCount: number;
};

// Discoverable playlist with creator info
export type DiscoverablePlaylist = {
  id: string;
  uuid: string;
  boardType: string;
  layoutId?: number | null;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  climbCount: number;
  creatorId: string;
  creatorName: string;
  isGeneratedRecommendation: boolean;
};

export type DiscoverPlaylistsInput = {
  boardType?: string;
  layoutId?: number;
  sizeId?: number | null;
  angle?: number | null;
  name?: string;
  creatorIds?: string[];
  generatedRecommendation?: boolean | null;
  sortBy?: 'recent' | 'popular';
  page?: number;
  pageSize?: number;
};

export type DiscoverPlaylistsResult = {
  playlists: DiscoverablePlaylist[];
  totalCount: number;
  hasMore: boolean;
};

export type DiscoverPlaylistsQueryVariables = {
  input: DiscoverPlaylistsInput;
};

export type DiscoverPlaylistsQueryResponse = {
  discoverPlaylists: DiscoverPlaylistsResult;
};

export type GetPlaylistCreatorsInput = {
  boardType: string;
  layoutId: number;
  searchQuery?: string;
};

export type GetPlaylistCreatorsQueryVariables = {
  input: GetPlaylistCreatorsInput;
};

export type GetPlaylistCreatorsQueryResponse = {
  playlistCreators: PlaylistCreator[];
};

// Discover public playlists
export const DISCOVER_PLAYLISTS = gql`
  query DiscoverPlaylists($input: DiscoverPlaylistsInput!) {
    discoverPlaylists(input: $input) {
      playlists {
        id
        uuid
        boardType
        layoutId
        name
        description
        color
        icon
        createdAt
        updatedAt
        climbCount
        creatorId
        creatorName
        isGeneratedRecommendation
      }
      totalCount
      hasMore
    }
  }
`;

// Get playlist creators for autocomplete
export const GET_PLAYLIST_CREATORS = gql`
  query GetPlaylistCreators($input: GetPlaylistCreatorsInput!) {
    playlistCreators(input: $input) {
      userId
      displayName
      playlistCount
    }
  }
`;

// Update playlist last accessed timestamp
export const UPDATE_PLAYLIST_LAST_ACCESSED = gql`
  mutation UpdatePlaylistLastAccessed($playlistId: ID!) {
    updatePlaylistLastAccessed(playlistId: $playlistId)
  }
`;

export type UpdatePlaylistLastAccessedMutationVariables = {
  playlistId: string;
};

export type UpdatePlaylistLastAccessedMutationResponse = {
  updatePlaylistLastAccessed: boolean;
};

// ============================================
// Search Playlists (Global) Types and Operations
// ============================================

export const SEARCH_PLAYLISTS = gql`
  query SearchPlaylists($input: SearchPlaylistsInput!) {
    searchPlaylists(input: $input) {
      playlists {
        id
        uuid
        boardType
        layoutId
        name
        description
        color
        icon
        climbCount
        creatorId
        creatorName
        createdAt
        updatedAt
      }
      totalCount
      hasMore
    }
  }
`;

export type SearchPlaylistsQueryVariables = {
  input: {
    query: string;
    boardType?: string;
    limit?: number;
    offset?: number;
  };
};

export type SearchPlaylistsQueryResponse = {
  searchPlaylists: {
    playlists: DiscoverablePlaylist[];
    totalCount: number;
    hasMore: boolean;
  };
};

// ============================================
// Playlist Follow Types and Operations
// ============================================

export const FOLLOW_PLAYLIST = gql`
  mutation FollowPlaylist($input: FollowPlaylistInput!) {
    followPlaylist(input: $input)
  }
`;

export const UNFOLLOW_PLAYLIST = gql`
  mutation UnfollowPlaylist($input: FollowPlaylistInput!) {
    unfollowPlaylist(input: $input)
  }
`;

export type FollowPlaylistInput = {
  playlistUuid: string;
};

export type FollowPlaylistMutationVariables = {
  input: FollowPlaylistInput;
};

export type FollowPlaylistMutationResponse = {
  followPlaylist: boolean;
};

export type UnfollowPlaylistMutationVariables = {
  input: FollowPlaylistInput;
};

export type UnfollowPlaylistMutationResponse = {
  unfollowPlaylist: boolean;
};

// ============================================
// Smart (computed) Playlist Types and Operations
// ============================================

export type SmartPlaylistType =
  | 'FIVE_STARS'
  | 'MOST_REPEATED'
  | 'PROJECTS'
  | 'LIKED_CLIMBS'
  | 'RECOMMENDED_CROWD_FAVORITES'
  | 'RECOMMENDED_HIDDEN_GEMS'
  | 'RECOMMENDED_AT_LEVEL'
  | 'RECOMMENDED_FRESH';

export type SmartPlaylistMeta = {
  type: SmartPlaylistType;
  userId: string;
  userName: string;
  userAvatar: string | null;
  climbCount: number;
};

export type SmartPlaylistResult = {
  meta: SmartPlaylistMeta;
  climbs: PlaylistClimbsResult['climbs'];
  totalCount: number;
  hasMore: boolean;
};

export type GetSmartPlaylistInput = {
  type: SmartPlaylistType;
  userId: string;
  boardName?: string;
  /** Recommendation: the specific owned board (uuid) to recommend for. */
  boardUuid?: string;
  /** Recommendation board-size override (size the user is browsing). */
  sizeId?: number;
  /** Recommendation board-angle override. */
  angle?: number;
  page?: number;
  pageSize?: number;
};

export type GetSmartPlaylistQueryVariables = {
  input: GetSmartPlaylistInput;
};

export type GetSmartPlaylistQueryResponse = {
  smartPlaylist: SmartPlaylistResult;
};

export type SmartPlaylistCount = {
  type: SmartPlaylistType;
  count: number;
};

export type GetMySmartPlaylistCountsQueryResponse = {
  mySmartPlaylistCounts: SmartPlaylistCount[];
};

export const GET_SMART_PLAYLIST = gql`
  query GetSmartPlaylist($input: GetSmartPlaylistInput!) {
    smartPlaylist(input: $input) {
      meta {
        type
        userId
        userName
        userAvatar
        climbCount
      }
      climbs {
        uuid
        layoutId
        boardType
        setter_username
        name
        description
        frames
        framesCount
        framesPace
        angle
        ascensionist_count
        difficulty
        quality_average
        stars
        difficulty_error
        benchmark_difficulty
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_MY_SMART_PLAYLIST_COUNTS = gql`
  query GetMySmartPlaylistCounts {
    mySmartPlaylistCounts {
      type
      count
    }
  }
`;
