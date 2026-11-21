// Aurora boards only - different from main BoardName which includes moonboard
export type AuroraBoardName = 'kilter' | 'tension' | 'decoy' | 'touchstone' | 'grasshopper' | 'soill';

export type BoardUser = {
  id: number;
  username: string;
  email_address: string;
  created_at: string;
  updated_at: string;
  is_listed: boolean;
  is_public: boolean;
  avatar_image: string | null;
  banner_image: string | null;
  city: string | null;
  country: string | null;
  height: number | null;
  weight: number | null;
  wingspan: number | null;
};

export type LoginResponse = {
  error: string;
  login: {
    created_at: string;
    token: string;
    user_id: number;
  };
  token: string;
  user: BoardUser;
  user_id: number;
  username: string;
};

export type SyncOptions = {
  tables?: string[];
  walls?: Array<{
    uuid: string;
    name: string;
    user_id: number;
    product_id: number;
    is_adjustable: boolean;
    angle: number;
    layout_id: number;
    product_size_id: number;
    hsm: number;
    serial_number: string | null;
    set_ids: number[];
    is_listed: boolean;
    created_at: string;
    updated_at: string;
  }>;
  wallExpungements?: Array<{
    wall_uuid: string;
    created_at: string;
    updated_at: string;
  }>;
  sharedSyncs?: Array<LastSyncData>;
  userSyncs?: Array<UserSyncData>;
};
export type ClimbStats = {
  display_difficulty: number;
  benchmark_difficulty: number | null;
  repeats: number;
  sends: number;
  ascensionist_count?: number;
  difficulty_average?: number;
  quality_average?: number;
  fa_username?: string;
  fa_at?: string;
};
export type SaveAscentOptions = {
  uuid: string;
  user_id: number;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  attempt_id: number | null;
  bid_count: number;
  /** Aurora-scale rating: 0 = unrated, 1-3 = stars (NOT the Boardsesh 1-5 scale). */
  quality: number;
  difficulty: number;
  is_benchmark: boolean;
  comment: string;
  climbed_at: string;
};
export type SaveAttemptOptions = {
  user_id: string;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  bid_count: number;
  comment: string;
  climbed_at: string;
};
export type SaveClimbOptions = {
  layout_id: number;
  user_id: string; // NextAuth user ID (UUID)
  name: string;
  description: string;
  is_draft: boolean;
  frames: string;
  frames_count?: number;
  frames_pace?: number;
  angle: number;
  setter_username?: string;
};
export const HOST_BASES: Record<AuroraBoardName, string> = {
  kilter: 'kilterboardapp',
  tension: 'tensionboardapp2',
  decoy: 'decoyboardapp',
  touchstone: 'touchstoneboardapp',
  grasshopper: 'grasshopperboardapp',
  soill: 'soillboardapp',
};

export const WEB_HOSTS: Record<AuroraBoardName, string> = Object.fromEntries(
  Object.entries(HOST_BASES).map(([board, hostBase]) => [board, `https://${hostBase}.com`]),
) as Record<AuroraBoardName, string>;

export type Ascent = {
  uuid: string;
  wall_uuid: string | null;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  user_id: number;
  attempt_id: number;
  bid_count: number;
  quality: number;
  difficulty: number;
  is_benchmark: boolean;
  is_listed: boolean;
  comment: string;
  climbed_at: string;
  created_at: string;
  updated_at: string;
};

// LogbookEntry covers both ascents and attempts. Difficulty is intentionally
// nullable — see docs/data/ascents-and-attempts.md. Attempts never carry a grade,
// and ascents may be saved without a user override.
export type LogbookEntry = Omit<Ascent, 'bid_count' | 'difficulty'> & {
  tries: number;
  is_ascent: boolean;
  difficulty: number | null;
};

export type ClimbStat = {
  climb_uuid: string;
  angle: number;
  ascensionist_count: number;
  difficulty_average: number;
  quality_average: number;
  fa_uid: number;
  fa_username: string;
  fa_at: string;
  created_at: string;
  updated_at: string;
};

export type AscentSavedEvent = {
  _type: 'ascent_saved';
  ascent: Ascent & {
    is_listed: boolean;
    created_at: string;
    updated_at: string;
  };
};

export type ClimbStatSavedEvent = {
  _type: 'climb_stat_saved';
  climb_stat: ClimbStat;
};

export type SaveAscentResponse = {
  events: (AscentSavedEvent | ClimbStatSavedEvent)[];
};
export type LastSyncData = {
  table_name: string;
  last_synchronized_at: string;
};

export type UserSyncData = LastSyncData & {
  user_id: number;
};

export const USER_TABLES = [
  'users',
  'walls',
  'wall_expungements',
  'draft_climbs',
  'ascents',
  'bids',
  'tags',
  'circuits',
];
export const SHARED_SYNC_TABLES = [
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
