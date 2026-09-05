// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema/types';

export { AURORA_BOARDS, type AuroraBoardName };

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
};

export type Session = {
  user_id: number;
  token: string;
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

export type LastSyncData = {
  table_name: string;
  last_synchronized_at: string;
};

export type UserSyncData = LastSyncData & {
  user_id: number;
};

export const HOST_BASES: Record<AuroraBoardName, string> = {
  kilter: 'kilterboardapp',
  tension: 'tensionboardapp2',
  decoy: 'decoyboardapp',
  touchstone: 'touchstoneboardapp',
  grasshopper: 'grasshopperboardapp',
  soill: 'soillboardapp',
};

export const API_HOSTS: Record<AuroraBoardName, string> = Object.fromEntries(
  Object.entries(HOST_BASES).map(([board, hostBase]) => [board, `https://api.${hostBase}.com`]),
) as Record<AuroraBoardName, string>;

export const WEB_HOSTS: Record<AuroraBoardName, string> = Object.fromEntries(
  Object.entries(HOST_BASES).map(([board, hostBase]) => [board, `https://${hostBase}.com`]),
) as Record<AuroraBoardName, string>;

/**
 * The iOS app name each Aurora board ships under, used to build the User-Agent.
 *
 * Every request used to announce itself as "Kilter Board" regardless of which
 * board it was talking to — copied from the login code and then spread by
 * copy-paste. Aurora plainly does not validate it (a Kilter UA against the
 * Tension host works today), so this is not a functional fix; it is that
 * identifying as the wrong product to a third party is wrong on its face, and
 * the rest of this client deliberately mirrors the official app.
 *
 * An explicit map rather than a derivation from the board name: these are real
 * product names, and if someone captures a board's actual UA they should be
 * able to correct that one line without reverse-engineering a formatter.
 */
const AURORA_APP_NAMES: Record<AuroraBoardName, string> = {
  kilter: 'Kilter Board',
  tension: 'Tension Board',
  decoy: 'Decoy Board',
  touchstone: 'Touchstone Board',
  grasshopper: 'Grasshopper Board',
  soill: 'So iLL Board',
};

/**
 * The client version and platform suffix are shared across the apps and match
 * what the Kilter app was observed sending. Only the product name varies.
 */
const AURORA_USER_AGENT_SUFFIX = '/202 CFNetwork/1568.100.1 Darwin/24.0.0';

export function auroraUserAgent(board: AuroraBoardName): string {
  return `${AURORA_APP_NAMES[board]}${AURORA_USER_AGENT_SUFFIX}`;
}

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

export type ClientOptions = {
  boardName: AuroraBoardName;
  token?: string | null;
  apiVersion?: string;
};
