// Aurora boards only - different from main BoardName which includes moonboard.
// Sourced from shared-schema so all packages agree on the canonical list.
export type { AuroraBoardName } from '@boardsesh/shared-schema';
import type { AuroraBoardName } from '@boardsesh/shared-schema';

export interface BoardUser {
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
}

export interface LoginResponse {
  error?: string;
  login?: {
    created_at: string;
    token: string;
    user_id: number;
  };
  token?: string;
  user?: BoardUser;
  user_id?: number;
  username?: string;
  session?: {
    token: string;
    user_id: number;
  };
}

export interface Session {
  user_id: number;
  token: string;
}

export interface SyncOptions {
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
}

export interface LastSyncData {
  table_name: string;
  last_synchronized_at: string;
}

export type UserSyncData = LastSyncData & {
  user_id: number;
};

export const HOST_BASES: Record<AuroraBoardName, string> = {
  kilter: 'kilterboardapp',
  tension: 'tensionboardapp2',
  decoy: 'decoyboardapp',
  touchstone: 'touchstoneboardapp',
  grasshopper: 'grasshopperboardapp',
};

export const API_HOSTS: Record<AuroraBoardName, string> = Object.fromEntries(
  Object.entries(HOST_BASES).map(([board, hostBase]) => [board, `https://api.${hostBase}.com`]),
) as Record<AuroraBoardName, string>;

export const WEB_HOSTS: Record<AuroraBoardName, string> = Object.fromEntries(
  Object.entries(HOST_BASES).map(([board, hostBase]) => [board, `https://${hostBase}.com`]),
) as Record<AuroraBoardName, string>;

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

export interface ClientOptions {
  boardName: AuroraBoardName;
  token?: string | null;
  apiVersion?: string;
}
