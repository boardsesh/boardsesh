import { PrivacyPublicationInputSchema } from './privacy-publication';
import { z } from 'zod';
import { isValidPlaylistColor } from '@boardsesh/shared-schema';
import { PLAYLIST_SORT_OPTIONS } from '@boardsesh/climb-filters';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';
import { ClimbSearchInputSchema } from './climbs';

export const PlaylistNameSchema = z.string().min(1, 'Playlist name cannot be empty').max(100, 'Playlist name too long');

export const PlaylistDescriptionSchema = z.string().max(500, 'Playlist description too long').optional();

export const PlaylistColorSchema = z
  .string()
  // Allow an empty string so an edit can explicitly clear a previously-set
  // colour. The update resolver only writes fields that are present, so '' is
  // the "clear" signal (undefined still means "leave unchanged").
  .refine((color) => color === '' || isValidPlaylistColor(color), 'Invalid color format (must be hex)')
  .optional();

export const PlaylistIconSchema = z.string().max(50, 'Icon name too long').optional();

export const CreatePlaylistInputSchema = z.object({
  privacy: PrivacyPublicationInputSchema.optional(),
  uuid: z.string().uuid('Invalid UUID format').optional(),
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive(),
  name: PlaylistNameSchema,
  description: PlaylistDescriptionSchema,
  color: PlaylistColorSchema,
  icon: PlaylistIconSchema,
});

export const UpdatePlaylistInputSchema = z.object({
  privacy: PrivacyPublicationInputSchema.optional(),
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
  // The board type comes from the stored playlist, so the resolver performs
  // the board-aware check after lookup.
  angle: z.number().int().min(-5).max(90),
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

/**
 * A playlist's sort and filters (`GetPlaylistClimbsInput.view`). The filter
 * fields are the climb search's own validators, picked rather than redeclared,
 * so a bound tightened for search (the holds-filter cap, the seed format, the
 * zone box) tightens here too.
 */
export const PlaylistClimbViewInputSchema = ClimbSearchInputSchema.pick({
  sortOrder: true,
  sortSeed: true,
  name: true,
  minGrade: true,
  maxGrade: true,
  gradeAccuracy: true,
  gradeSource: true,
  useMyGrades: true,
  minAscents: true,
  minRating: true,
  onlyBenchmarks: true,
  setter: true,
  onlyFollowedAuthors: true,
  onlyTallClimbs: true,
  onlyWideClimbs: true,
  onlyWithBetaVideos: true,
  boulders: true,
  routes: true,
  projectsOnly: true,
  hideAttempted: true,
  hideCompleted: true,
  showOnlyAttempted: true,
  showOnlyCompleted: true,
  minUserRating: true,
  onlyRatedByMe: true,
  onlyFavorited: true,
  holdsFilter: true,
  zoneBox: true,
  zoneMode: true,
}).extend({
  sortBy: z.enum(PLAYLIST_SORT_OPTIONS).optional(),
  onlyActiveBoard: z.boolean().optional(),
});

/**
 * The active board for a view's active-board filters (`activeBoardName` …
 * `activeSetIds`). A playlist in all-boards mode and the smart playlists take
 * the same fields under the same rules (`checkActiveBoardFields`).
 */
const ACTIVE_BOARD_FIELDS = {
  activeBoardName: BoardNameSchema.optional(),
  // Live board angle; Aurora supports negative tilt.
  activeAngle: z.number().int().min(-90).max(90).optional(),
  // The rest of the active board, for the view's active-board filters. Each
  // needs activeBoardName: a layout with no board type names nothing.
  activeLayoutId: z.number().int().positive().optional(),
  activeSizeId: z.number().int().positive().optional(),
  activeSetIds: z.string().min(1).max(500).optional(),
};

export type ActiveBoardFields = z.infer<z.ZodObject<typeof ACTIVE_BOARD_FIELDS>>;

function checkActiveBoardFields(input: ActiveBoardFields, ctx: z.RefinementCtx) {
  // Both are required together: one without the other would silently no-op.
  if ((input.activeBoardName == null) !== (input.activeAngle == null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'activeBoardName and activeAngle must be provided together',
      path: ['activeAngle'],
    });
  }
  if (
    input.activeBoardName == null &&
    (input.activeLayoutId != null || input.activeSizeId != null || input.activeSetIds != null)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'activeLayoutId, activeSizeId and activeSetIds need activeBoardName',
      path: ['activeBoardName'],
    });
  }
}

export const GetPlaylistClimbsInputSchema = z
  .object({
    playlistId: z.string().min(1),
    boardName: BoardNameSchema.optional(),
    layoutId: z.number().int().positive().optional(),
    sizeId: z.number().int().positive().optional(),
    setIds: z.string().min(1).optional(),
    angle: z.number().int().optional(),
    // All-boards mode only: activeBoardName + activeAngle render on-active-board
    // climbs' grades at the user's selected angle instead of the added-at /
    // most-ascents fallback; the rest of the active board feeds the view's
    // active-board filters.
    ...ACTIVE_BOARD_FIELDS,
    view: PlaylistClimbViewInputSchema.optional(),
    page: z.number().int().min(0).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .superRefine(checkActiveBoardFields);

export const DiscoverPlaylistsInputSchema = z
  .object({
    boardType: BoardNameSchema.optional(),
    layoutId: z.number().int().positive().optional(),
    sizeId: z.number().int().positive().nullable().optional(),
    // Live board angle; Aurora supports negative tilt.
    angle: z.number().int().min(-90).max(90).nullable().optional(),
    name: z.string().max(100).optional(),
    creatorIds: z.array(z.string().min(1)).optional(),
    excludeCreatorIds: z.array(z.string().min(1)).max(100).optional(),
    minClimbs: z.number().int().min(1).max(1000).optional(),
    maxClimbs: z.number().int().min(1).max(10000).optional(),
    generatedRecommendation: z.boolean().nullable().optional(),
    // Difficulty ids, the same numbers SearchClimbs' grade band takes.
    minGrade: z.number().int().min(1).max(100).nullable().optional(),
    maxGrade: z.number().int().min(1).max(100).nullable().optional(),
    followedOnly: z.boolean().nullable().optional(),
    sortBy: z.enum(['recent', 'popular']).optional(),
    page: z.number().int().min(0).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  // An inverted band is not an empty result, it is a caller bug. Without this it
  // returns zero rows and looks exactly like "the catalogue has nothing to show",
  // which is the hardest kind of mistake to notice from the outside.
  .refine((input) => input.minClimbs == null || input.maxClimbs == null || input.minClimbs <= input.maxClimbs, {
    message: 'minClimbs must be less than or equal to maxClimbs',
    path: ['minClimbs'],
  })
  .refine((input) => input.minGrade == null || input.maxGrade == null || input.minGrade <= input.maxGrade, {
    message: 'minGrade must be less than or equal to maxGrade',
    path: ['minGrade'],
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

export const GetSmartPlaylistInputSchema = z
  .object({
    type: SmartPlaylistTypeSchema,
    userId: z.string().min(1),
    boardName: BoardNameSchema.optional(),
    boardUuid: z.string().min(1).optional(),
    sizeId: z.number().int().positive().optional(),
    // Live board angle; Aurora supports negative tilt.
    angle: z.number().int().min(-90).max(90).optional(),
    // Only a view's active-board filters read these. Views are for the logbook
    // types; the resolver rejects one on a recommendation.
    ...ACTIVE_BOARD_FIELDS,
    view: PlaylistClimbViewInputSchema.optional(),
    page: z.number().int().min(0).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .superRefine(checkActiveBoardFields);

/** The most setters `playlistSetters` returns. */
export const PLAYLIST_SETTERS_LIMIT = 200;

/**
 * `playlistSetters`: a user playlist (playlistId, with playlistClimbs' board
 * fields) or a logbook smart list (smartType + userId, with its board-type
 * filter). The resolver rejects a recommendation type, as `smartPlaylist`
 * rejects a view on one.
 */
export const PlaylistSettersInputSchema = z
  .object({
    playlistId: z.string().min(1).optional(),
    smartType: SmartPlaylistTypeSchema.optional(),
    userId: z.string().min(1).optional(),
    boardName: BoardNameSchema.optional(),
    layoutId: z.number().int().positive().optional(),
    sizeId: z.number().int().positive().optional(),
    setIds: z.string().min(1).max(500).optional(),
    search: z.string().trim().max(100).optional(),
  })
  .superRefine((input, ctx) => {
    const namesSmartList = input.smartType != null || input.userId != null;
    if ((input.playlistId != null) === namesSmartList) {
      ctx.addIssue({
        code: 'custom',
        message: 'Name either playlistId or smartType with userId',
        path: ['playlistId'],
      });
    }
    if (namesSmartList && (input.smartType == null || input.userId == null)) {
      ctx.addIssue({ code: 'custom', message: 'smartType and userId go together', path: ['smartType'] });
    }
    if (namesSmartList && (input.layoutId != null || input.sizeId != null || input.setIds != null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'A smart list takes boardName only, not layoutId, sizeId or setIds',
        path: ['layoutId'],
      });
    }
  });
