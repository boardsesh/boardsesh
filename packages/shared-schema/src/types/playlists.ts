// Playlist types

export type SearchPlaylistsInput = {
  query: string;
  boardType?: string;
  limit?: number;
  offset?: number;
};

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

export type SearchPlaylistsResult = {
  playlists: DiscoverablePlaylist[];
  totalCount: number;
  hasMore: boolean;
};
