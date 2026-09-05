// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';
import type {
  Gym,
  GymKiosk,
  CreateGymKioskInput,
  UpdateGymKioskInput,
  KioskHeartbeatInput,
} from '@boardsesh/shared-schema';

// ============================================
// Gym Kiosk Operations
// ============================================

// The resolved slot boards a kiosk renders. `boardId` is the presence-channel id
// that feeds boardNowPlaying(boardId) on the kiosk/embed surfaces.
const GYM_KIOSK_BOARD_FIELDS = `
  boardId
  boardUuid
  slug
  name
  boardType
  layoutId
  sizeId
  setIds
  angle
`;

// Gym fields the kiosk chrome + manage UI read: branding for the header, plus
// slug/isPublic/canEdit for URL + gating decisions.
const GYM_KIOSK_GYM_FIELDS = `
  uuid
  slug
  name
  isPublic
  logoUrl
  brandPrimaryColor
  brandAccentColor
  brandBackgroundColor
  canEdit
`;

const GYM_KIOSK_FIELDS = `
  uuid
  slug
  name
  layout
  createdAt
  updatedAt
  boards {
    ${GYM_KIOSK_BOARD_FIELDS}
  }
  gym {
    ${GYM_KIOSK_GYM_FIELDS}
  }
`;

export const GET_GYM_KIOSK = gql`
  query GetGymKiosk($gymSlug: String!, $kioskSlug: String) {
    gymKiosk(gymSlug: $gymSlug, kioskSlug: $kioskSlug) {
      ${GYM_KIOSK_FIELDS}
    }
  }
`;

// The manage list additionally reads per-kiosk liveness (edit-guarded). The
// public GET_GYM_KIOSK deliberately omits lastSeenAt — the resolver never
// populates it there, and owners are the only ones who should see whether a
// screen is live.
export const GET_GYM_KIOSKS = gql`
  query GetGymKiosks($gymUuid: ID!) {
    gymKiosks(gymUuid: $gymUuid) {
      ${GYM_KIOSK_FIELDS}
      lastSeenAt
    }
  }
`;

export const CREATE_GYM_KIOSK = gql`
  mutation CreateGymKiosk($input: CreateGymKioskInput!) {
    createGymKiosk(input: $input) {
      ${GYM_KIOSK_FIELDS}
    }
  }
`;

export const UPDATE_GYM_KIOSK = gql`
  mutation UpdateGymKiosk($input: UpdateGymKioskInput!) {
    updateGymKiosk(input: $input) {
      ${GYM_KIOSK_FIELDS}
    }
  }
`;

export const DELETE_GYM_KIOSK = gql`
  mutation DeleteGymKiosk($kioskUuid: ID!) {
    deleteGymKiosk(kioskUuid: $kioskUuid)
  }
`;

// Public, unauthenticated check-in fired by the kiosk TV pages. Returns a plain
// boolean — recorded / not recorded — so a since-deleted kiosk just stops being
// counted live without erroring the page.
export const KIOSK_HEARTBEAT = gql`
  mutation KioskHeartbeat($input: KioskHeartbeatInput!) {
    kioskHeartbeat(input: $input)
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

/**
 * Exactly the gym fields these operations select (GYM_KIOSK_GYM_FIELDS). The
 * response types narrow `gym` to this instead of the full `Gym` so a consumer
 * reading an unselected field (ownerId, counts, ...) is a compile error rather
 * than an `undefined` at runtime.
 */
export type GymKioskOperationGym = Pick<
  Gym,
  | 'uuid'
  | 'slug'
  | 'name'
  | 'isPublic'
  | 'logoUrl'
  | 'brandPrimaryColor'
  | 'brandAccentColor'
  | 'brandBackgroundColor'
  | 'canEdit'
>;

/**
 * A GymKiosk as returned by the shared selection: full kiosk minus `lastSeenAt`
 * (only the edit-guarded manage list selects that), with a narrowed gym. Both
 * omissions keep a consumer honest — reading a field the query didn't select is
 * a compile error rather than an `undefined` at runtime.
 */
export type GymKioskOperationResult = Omit<GymKiosk, 'gym' | 'lastSeenAt'> & { gym: GymKioskOperationGym };

/** The manage-list variant: the shared result plus per-kiosk liveness. */
export type GymKioskManageResult = GymKioskOperationResult & Pick<GymKiosk, 'lastSeenAt'>;

export type GetGymKioskQueryVariables = {
  gymSlug: string;
  kioskSlug?: string | null;
};

export type GetGymKioskQueryResponse = {
  gymKiosk: GymKioskOperationResult | null;
};

export type GetGymKiosksQueryVariables = {
  gymUuid: string;
};

export type GetGymKiosksQueryResponse = {
  gymKiosks: GymKioskManageResult[];
};

export type CreateGymKioskMutationVariables = {
  input: CreateGymKioskInput;
};

export type CreateGymKioskMutationResponse = {
  createGymKiosk: GymKioskOperationResult;
};

export type UpdateGymKioskMutationVariables = {
  input: UpdateGymKioskInput;
};

export type UpdateGymKioskMutationResponse = {
  updateGymKiosk: GymKioskOperationResult;
};

export type DeleteGymKioskMutationVariables = {
  kioskUuid: string;
};

export type DeleteGymKioskMutationResponse = {
  deleteGymKiosk: boolean;
};

export type KioskHeartbeatMutationVariables = {
  input: KioskHeartbeatInput;
};

export type KioskHeartbeatMutationResponse = {
  kioskHeartbeat: boolean;
};
