import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema, UUIDSchema } from './primitives';

export const PlaylistNameSchema = z.string().min(1, 'Playlist name cannot be empty').max(100, 'Playlist name too long');

export const PlaylistDescriptionSchema = z.string().max(500, 'Playlist description too long').optional();

export const PlaylistColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid color format (must be hex)')
  .optional();

export const PlaylistIconSchema = z.string().max(50, 'Icon name too long').optional();

export const CreatePlaylistInputSchema = z.object({
  // Optional client-supplied UUID for idempotent offline replay. When present,
  // createPlaylist inserts with ON CONFLICT (uuid) DO NOTHING and returns the
  // existing playlist on conflict. When absent, the server generates a uuidv4.
  uuid: UUIDSchema.optional(),
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive(),
  name: PlaylistNameSchema,
  description: PlaylistDescriptionSchema,
  color: PlaylistColorSchema,
  icon: PlaylistIconSchema,
});

export const UpdatePlaylistInputSchema = z.object({
  playlistId: z.string().min(1),
  name: PlaylistNameSchema.optional(),
  description: PlaylistDescriptionSchema,
  isPublic: z.boolean().optional(),
  color: PlaylistColorSchema,
  icon: PlaylistIconSchema,
});

export const AddClimbToPlaylistInputSchema = z.object({
  playlistId: z.string().min(1),
  climbUuid: ExternalUUIDSchema,
  angle: z.number().int().min(0).max(90),
});

export const RemoveClimbFromPlaylistInputSchema = z.object({
  playlistId: z.string().min(1),
  climbUuid: ExternalUUIDSchema,
});

export const GetUserPlaylistsInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive(),
});

export const GetAllUserPlaylistsInputSchema = z.object({
  boardType: BoardNameSchema.optional(),
  layoutId: z.number().int().positive().optional(),
  page: z.number().int().min(0).optional(),
  // Owned-data query, no abuse vector — the climb-action picker fetches the
  // user's full library in one round-trip with pageSize 200, so the cap needs
  // to comfortably exceed that.
  pageSize: z.number().int().min(1).max(500).optional(),
});

export const PinPlaylistInputSchema = z.object({
  playlistUuid: z.string().min(1, 'Playlist UUID cannot be empty'),
});

export const GetMyPinnedPlaylistsInputSchema = z.object({
  boardType: BoardNameSchema.optional(),
  layoutId: z.number().int().positive().optional(),
});

export const GetPlaylistsForClimbInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive(),
  climbUuid: ExternalUUIDSchema,
});

export const GetPlaylistsForClimbsInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive(),
  climbUuids: z.array(ExternalUUIDSchema).min(1).max(500),
});

export const GetPlaylistClimbsInputSchema = z.object({
  playlistId: z.string().min(1),
  boardName: BoardNameSchema.optional(),
  layoutId: z.number().int().positive().optional(),
  sizeId: z.number().int().positive().optional(),
  setIds: z.string().min(1).optional(),
  angle: z.number().int().optional(),
  page: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export const DiscoverPlaylistsInputSchema = z.object({
  boardType: BoardNameSchema.optional(),
  layoutId: z.number().int().positive().optional(),
  name: z.string().max(100).optional(),
  creatorIds: z.array(z.string().min(1)).optional(),
  sortBy: z.enum(['recent', 'popular']).optional(),
  page: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export const GetPlaylistCreatorsInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive(),
  searchQuery: z.string().max(100).optional(),
});

export const SearchPlaylistsInputSchema = z.object({
  query: z.string().min(1).max(200),
  boardType: BoardNameSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export const SmartPlaylistTypeSchema = z.enum(['FIVE_STARS', 'MOST_REPEATED', 'PROJECTS', 'LIKED_CLIMBS']);

export const GetSmartPlaylistInputSchema = z.object({
  type: SmartPlaylistTypeSchema,
  userId: z.string().min(1),
  boardName: BoardNameSchema.optional(),
  page: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
