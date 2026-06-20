import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

export const PlaylistNameSchema = z.string().min(1, 'Playlist name cannot be empty').max(100, 'Playlist name too long');

export const PlaylistDescriptionSchema = z.string().max(500, 'Playlist description too long').optional();

export const PlaylistColorSchema = z
  .string()
  // Allow an empty string so an edit can explicitly clear a previously-set
  // colour. The update resolver only writes fields that are present, so '' is
  // the "clear" signal (undefined still means "leave unchanged").
  .regex(/^(#[0-9A-Fa-f]{6})?$/, 'Invalid color format (must be hex)')
  .optional();

export const PlaylistIconSchema = z.string().max(50, 'Icon name too long').optional();

export const CreatePlaylistInputSchema = z.object({
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

export const ReorderPlaylistClimbInputSchema = z.object({
  playlistId: z.string().min(1),
  climbUuid: ExternalUUIDSchema,
  newIndex: z.number().int().min(0),
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

export const GetPlaylistClimbsInputSchema = z
  .object({
    playlistId: z.string().min(1),
    boardName: BoardNameSchema.optional(),
    layoutId: z.number().int().positive().optional(),
    sizeId: z.number().int().positive().optional(),
    setIds: z.string().min(1).optional(),
    angle: z.number().int().optional(),
    // All-boards mode only: render on-active-board climbs' grades at the user's
    // selected angle instead of the added-at / most-ascents fallback. Both are
    // required together — one without the other would silently no-op.
    activeBoardName: BoardNameSchema.optional(),
    activeAngle: z.number().int().min(0).max(90).optional(),
    page: z.number().int().min(0).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .refine((input) => (input.activeBoardName == null) === (input.activeAngle == null), {
    message: 'activeBoardName and activeAngle must be provided together',
    path: ['activeAngle'],
  });

export const DiscoverPlaylistsInputSchema = z.object({
  boardType: BoardNameSchema.optional(),
  layoutId: z.number().int().positive().optional(),
  sizeId: z.number().int().positive().nullable().optional(),
  angle: z.number().int().min(0).max(90).nullable().optional(),
  name: z.string().max(100).optional(),
  creatorIds: z.array(z.string().min(1)).optional(),
  generatedRecommendation: z.boolean().nullable().optional(),
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

export const SmartPlaylistTypeSchema = z.enum([
  'FIVE_STARS',
  'MOST_REPEATED',
  'PROJECTS',
  'LIKED_CLIMBS',
  'RECOMMENDED_CROWD_FAVORITES',
  'RECOMMENDED_HIDDEN_GEMS',
  'RECOMMENDED_AT_LEVEL',
  'RECOMMENDED_FRESH',
]);

export const GetSmartPlaylistInputSchema = z.object({
  type: SmartPlaylistTypeSchema,
  userId: z.string().min(1),
  boardName: BoardNameSchema.optional(),
  boardUuid: z.string().min(1).optional(),
  sizeId: z.number().int().positive().optional(),
  angle: z.number().int().min(0).max(70).optional(),
  page: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
