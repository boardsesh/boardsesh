import { gql } from 'graphql-request';
import { BOARD_FIELDS } from './boards';
import type { SprayWallPhoto, SprayWallReportReason } from '../generated/graphql';

export type { SprayWallReportReason } from '../generated/graphql';

/**
 * Spray wall operations, shared by web and mobile.
 *
 * Two things about these documents are load-bearing rather than stylistic:
 *
 *  1. **`photo` is never cached.** Its `url` and `thumbUrl` are 15-minute
 *     presigned signatures over an object in the PRIVATE bucket, so a client that
 *     persists one gets a link that stops working. `expiresAt` is on every
 *     selection for exactly that reason — re-run the query, do not store the URL.
 *  2. **`SPRAY_WALL_RENDER_DATA` is the render path's whole payload.** The board
 *     surface asks for one wall at one version and gets the photo, the homography
 *     and the holds alive at that version in one round trip; no image is warped,
 *     so the client maps holds through the INVERSE of `homography` at draw time.
 */

const SPRAY_WALL_PHOTO_FIELDS = `
  url
  thumbUrl
  width
  height
  expiresAt
`;

const SPRAY_WALL_VERSION_FIELDS = `
  id
  number
  status
  anchors
  homography
  notes
  publishedAt
  createdAt
  addedHoldCount
  removedHoldCount
  photo {
    ${SPRAY_WALL_PHOTO_FIELDS}
  }
`;

const SPRAY_WALL_HOLD_FIELDS = `
  id
  cx
  cy
  r
  outline
  installedVersion
  removedVersion
  movedFromHoldId
  source
  confidence
`;

/**
 * The wall itself, without its version history.
 *
 * `versions` is deliberately absent here: a list row or a wall header needs the
 * current photo and the hold count, and a wall reset monthly for four years can
 * carry fifty versions, each of which costs two presigned signatures to build.
 * Ask for the history with `SPRAY_WALL_WITH_VERSIONS` on the screen that shows it.
 */
const SPRAY_WALL_ENTITY_FIELDS = `
  uuid
  layoutId
  sizeId
  referenceWidth
  referenceHeight
  holdCount
  publicPhotoUrl
  viewerCanEdit
  # Only ever non-null for the OWNER — a hidden wall does not resolve for anybody
  # else — so a client can render the notice off its presence alone (SW-17).
  hiddenAt
  # The wall's stored look is deliberately absent: see GET_SPRAY_WALL_LOOK. So
  # is its archive state: see GET_SPRAY_WALL_ARCHIVE, for the same reason.
  currentVersion {
    ${SPRAY_WALL_VERSION_FIELDS}
  }
`;

const SPRAY_WALL_FIELDS = `
  ${SPRAY_WALL_ENTITY_FIELDS}
  board {
    uuid
    slug
    name
    boardType
    layoutId
    sizeId
    setIds
    angle
    isPublic
    isUnlisted
    hasLeds
    isAngleAdjustable
    ownerId
    ownerDisplayName
    gymUuid
    gymName
    canEdit
  }
`;

export const GET_SPRAY_WALL = gql`
  query GetSprayWall($uuid: ID!) {
    sprayWall(uuid: $uuid) {
      ${SPRAY_WALL_FIELDS}
    }
  }
`;

/** Resolve a shared wall and the complete board entity needed for route adoption. */
export const GET_SPRAY_WALL_FOR_LINK = gql`
  query GetSprayWallForLink($uuid: ID!) {
    sprayWall(uuid: $uuid) {
      ${SPRAY_WALL_ENTITY_FIELDS}
      board {
        ${BOARD_FIELDS}
      }
    }
  }
`;

export const GET_SPRAY_WALL_WITH_VERSIONS = gql`
  query GetSprayWallWithVersions($uuid: ID!) {
    sprayWall(uuid: $uuid) {
      ${SPRAY_WALL_FIELDS}
      versions {
        ${SPRAY_WALL_VERSION_FIELDS}
      }
    }
  }
`;

export const GET_SPRAY_WALL_BY_LAYOUT = gql`
  query GetSprayWallByLayout($layoutId: Int!) {
    sprayWallByLayout(layoutId: $layoutId) {
      ${SPRAY_WALL_FIELDS}
    }
  }
`;

export const GET_SPRAY_WALL_RENDER_DATA = gql`
  query GetSprayWallRenderData($uuid: ID!, $version: Int) {
    sprayWallRenderData(uuid: $uuid, version: $version) {
      versionNumber
      boardWidth
      boardHeight
      homography
      photo {
        ${SPRAY_WALL_PHOTO_FIELDS}
      }
      holds {
        ${SPRAY_WALL_HOLD_FIELDS}
      }
      wall {
        ${SPRAY_WALL_FIELDS}
      }
    }
  }
`;

/**
 * Draft reads verify the immutable row id even when a discarded number is reused.
 *
 * The one read that asks for `photoFullUrl` (#5911): the hold editor swaps it in
 * once it zooms past 3x. The climb view's `GET_SPRAY_WALL_RENDER_DATA` leaves it
 * out, so the render path never pays for a second signature it would not use.
 */
export const GET_SPRAY_WALL_DRAFT_RENDER_DATA = gql`
  query GetSprayWallDraftRenderData($uuid: ID!, $version: Int) {
    sprayWallRenderData(uuid: $uuid, version: $version) {
      versionNumber
      boardWidth
      boardHeight
      homography
      photo {
        ${SPRAY_WALL_PHOTO_FIELDS}
      }
      photoFullUrl
      holds {
        ${SPRAY_WALL_HOLD_FIELDS}
      }
      wall {
        ${SPRAY_WALL_FIELDS}
        versions { id number status }
      }
    }
  }
`;

/**
 * What a LISTING row needs, and nothing that costs a signature.
 *
 * No `currentVersion`: its photo is a presigned URL over the private bucket, and
 * a gym page is server-rendered for a logged-out reader who cannot hold one.
 * `publicPhotoUrl` is the field that answers for a public wall — a stable URL
 * over the public copy — and is null for every wall that is not public, which is
 * exactly the "name only" row the gym page falls back to.
 */
const SPRAY_WALL_LISTING_FIELDS = `
  uuid
  layoutId
  holdCount
  publicPhotoUrl
  board {
    uuid
    slug
    name
    angle
    isPublic
    isUnlisted
    gymUuid
    gymName
  }
`;

/** Every spray wall on a gym that the caller may see, gym members included. */
export const GET_GYM_SPRAY_WALLS = gql`
  query GetGymSprayWalls($gymUuid: ID!) {
    gymSprayWalls(gymUuid: $gymUuid) {
      ${SPRAY_WALL_LISTING_FIELDS}
    }
  }
`;

/** One row of `GET_GYM_SPRAY_WALLS` — narrower than `SprayWall` by what it does not select. */
export type GymSprayWallListing = {
  uuid: string;
  layoutId: number;
  holdCount: number;
  publicPhotoUrl: string | null;
  board: {
    uuid: string;
    slug: string | null;
    name: string;
    angle: number;
    isPublic: boolean;
    isUnlisted: boolean;
    gymUuid: string | null;
    gymName: string | null;
  };
};

export type GetGymSprayWallsQueryVariables = {
  gymUuid: string;
};

export type GetGymSprayWallsQueryResponse = {
  gymSprayWalls: GymSprayWallListing[];
};

export const GET_MY_SPRAY_WALLS = gql`
  query GetMySprayWalls {
    mySprayWalls {
      ${SPRAY_WALL_FIELDS}
    }
  }
`;

export const CREATE_SPRAY_WALL = gql`
  mutation CreateSprayWall($input: CreateSprayWallInput!) {
    createSprayWall(input: $input) {
      ${SPRAY_WALL_FIELDS}
    }
  }
`;

/**
 * How many published and draft climbs use each hold. The hold editor asks before
 * it saves a removal or a move, so it can warn that published climbs will lose a
 * hold.
 */
export const GET_SPRAY_WALL_HOLD_USAGE = gql`
  query GetSprayWallHoldUsage($wallUuid: ID!, $holdIds: [Int!]!) {
    sprayWallHoldUsage(wallUuid: $wallUuid, holdIds: $holdIds) {
      holdId
      publishedClimbCount
      draftClimbCount
    }
  }
`;

/**
 * Start a reset: clone the wall's settings into a new, unfinished wall. The owner
 * photographs and marks it in the add-wall wizard, and its first publish archives
 * the old wall. Calling it again before then returns the same clone.
 */
export const RESET_SPRAY_WALL = gql`
  mutation ResetSprayWall($input: ResetSprayWallInput!) {
    resetSprayWall(input: $input) {
      ${SPRAY_WALL_FIELDS}
    }
  }
`;

/**
 * Rename, share, re-gym or re-angle a wall.
 *
 * Sharing is the point: a wall is created PRIVATE, so without this one it could
 * never be shown to anybody. The angle is only accepted while the wall has no
 * published version — stats are keyed by angle.
 */
export const UPDATE_SPRAY_WALL = gql`
  mutation UpdateSprayWall($input: UpdateSprayWallInput!) {
    updateSprayWall(input: $input) {
      ${SPRAY_WALL_FIELDS}
    }
  }
`;

/**
 * The wall's stored default look (`{ mode, boardsesh }`), or null.
 *
 * Its own query rather than a field on `SPRAY_WALL_FIELDS`. The app and the
 * backend ship on different trains, and a field the backend does not have yet
 * fails validation for the WHOLE operation it sits in. In the shared fragment it
 * broke creating, loading and drawing every wall at once; out here, a backend
 * without it costs only the look, which reads as "no stored look".
 */
export const GET_SPRAY_WALL_LOOK = gql`
  query GetSprayWallLook($uuid: ID!) {
    sprayWall(uuid: $uuid) {
      uuid
      renderSettings
    }
  }
`;

/**
 * Where the wall stands in a reset (`docs/spray-walls.md`, "Archive and reset"):
 * when a reset archived it, the wall it was cloned from, and the published wall
 * that replaced it.
 *
 * Its own query, never part of `SPRAY_WALL_FIELDS`, for the reason
 * `GET_SPRAY_WALL_LOOK` gives: a field the backend does not serve fails
 * validation for the WHOLE operation, so an app that reached a phone before the
 * backend (or a backend rolled back under it) would load no wall at all. Out
 * here, a backend without the fields costs only this answer, and the app reads
 * the wall as live. The server still refuses every write an archived wall does
 * not allow.
 */
export const GET_SPRAY_WALL_ARCHIVE = gql`
  query GetSprayWallArchive($uuid: ID!) {
    sprayWall(uuid: $uuid) {
      uuid
      archivedAt
      resetOfWallUuid
      replacedByWallUuid
    }
  }
`;

/** The answer of `GET_SPRAY_WALL_ARCHIVE`. */
export type SprayWallArchiveFields = {
  uuid: string;
  archivedAt?: string | null;
  resetOfWallUuid?: string | null;
  replacedByWallUuid?: string | null;
};

export type GetSprayWallArchiveQueryResponse = { sprayWall: SprayWallArchiveFields | null };

/**
 * The owner's walls with only what My Boards' Archived section and the add-a-wall
 * resume check read: no current version, so no presigned photo URLs for every
 * wall the owner ever had. Fail-soft like `GET_SPRAY_WALL_ARCHIVE`: on a backend
 * without the archive fields the query fails on its own, the Archived section is
 * simply absent, and the resume check offers what it always did.
 */
export const GET_MY_SPRAY_WALL_LIFECYCLE = gql`
  query GetMySprayWallLifecycle {
    mySprayWalls {
      uuid
      layoutId
      archivedAt
      resetOfWallUuid
      board {
        uuid
        name
      }
    }
  }
`;

/** One row of `GET_MY_SPRAY_WALL_LIFECYCLE`. */
export type SprayWallLifecycleRow = {
  uuid: string;
  layoutId: number;
  archivedAt?: string | null;
  resetOfWallUuid?: string | null;
  board: { uuid: string; name: string } | null;
};

export type GetMySprayWallLifecycleQueryResponse = { mySprayWalls: SprayWallLifecycleRow[] };

/**
 * One version's generated wall looks and its photo-quality verdict. Its own
 * query for the reason `GET_SPRAY_WALL_LOOK` gives: a backend without
 * `sprayWallArt` costs only the art, and the wall draws on its photo.
 */
export const GET_SPRAY_WALL_ART = gql`
  query GetSprayWallArt($uuid: ID!, $version: Int) {
    sprayWallArt(uuid: $uuid, version: $version) {
      versionNumber
      recipe
      status
      width
      height
      quality {
        stretch
        verdict
        reason
        frameShortEdge
      }
      crop {
        url
        thumbUrl
        width
        height
        expiresAt
      }
      cutout {
        url
        thumbUrl
        width
        height
        expiresAt
      }
    }
  }
`;

/**
 * Store the wall's default look (`{ mode, boardsesh }`), or clear it with
 * `renderSettings: null`. Same edit gate as `UPDATE_SPRAY_WALL`. Selects only
 * the look, for the reason `GET_SPRAY_WALL_LOOK` gives.
 */
export const SET_SPRAY_WALL_RENDER_SETTINGS = gql`
  mutation SetSprayWallRenderSettings($input: SetSprayWallRenderSettingsInput!) {
    setSprayWallRenderSettings(input: $input) {
      uuid
      renderSettings
    }
  }
`;

export const CREATE_SPRAY_WALL_VERSION = gql`
  mutation CreateSprayWallVersion($input: CreateSprayWallVersionInput!) {
    createSprayWallVersion(input: $input) {
      ${SPRAY_WALL_VERSION_FIELDS}
    }
  }
`;

export const UPSERT_SPRAY_WALL_HOLDS = gql`
  mutation UpsertSprayWallHolds($input: UpsertSprayWallHoldsInput!) {
    upsertSprayWallHolds(input: $input) {
      ${SPRAY_WALL_HOLD_FIELDS}
    }
  }
`;

export const REMOVE_SPRAY_WALL_HOLDS = gql`
  mutation RemoveSprayWallHolds($input: RemoveSprayWallHoldsInput!) {
    removeSprayWallHolds(input: $input)
  }
`;

export const PUBLISH_SPRAY_WALL_VERSION = gql`
  mutation PublishSprayWallVersion($input: PublishSprayWallVersionInput!) {
    publishSprayWallVersion(input: $input) {
      ${SPRAY_WALL_VERSION_FIELDS}
    }
  }
`;

/**
 * Abandon a draft. A wall carries one open draft at a time, so this and
 * `PUBLISH_SPRAY_WALL_VERSION` are the two ways out of one.
 */
export const DISCARD_SPRAY_WALL_VERSION = gql`
  mutation DiscardSprayWallVersion($input: PublishSprayWallVersionInput!) {
    discardSprayWallVersion(input: $input)
  }
`;

export const DELETE_SPRAY_WALL = gql`
  mutation DeleteSprayWall($uuid: ID!) {
    deleteSprayWall(uuid: $uuid)
  }
`;

/** Reports never accept free text; duplicate reports preserve the first reason. */
export const REPORT_SPRAY_WALL = gql`
  mutation ReportSprayWall($input: ReportSprayWallInput!) {
    reportSprayWall(input: $input) {
      status
    }
  }
`;

/** Admin-only previews include private and hidden walls; never persist photo URLs. */
export const GET_SPRAY_WALL_REPORTS = gql`
  query GetSprayWallReports($uuid: ID) {
    sprayWallReports(uuid: $uuid) {
      id
      wallUuid
      wallName
      layoutId
      reason
      hidden
      createdAt
      photo {
        ${SPRAY_WALL_PHOTO_FIELDS}
      }
    }
  }
`;

/** Either review outcome clears every pending report for this wall. */
export const SET_SPRAY_WALL_HIDDEN = gql`
  mutation SetSprayWallHidden($input: SetSprayWallHiddenInput!) {
    setSprayWallHidden(input: $input) {
      uuid
      layoutId
      hidden
      hiddenAt
    }
  }
`;

export type SprayWallPhotoData = Required<Pick<SprayWallPhoto, 'url' | 'thumbUrl' | 'width' | 'height' | 'expiresAt'>>;

export type SprayWallReportData = {
  id: string;
  wallUuid: string;
  wallName: string;
  layoutId: number;
  reason: SprayWallReportReason;
  hidden: boolean;
  createdAt: string;
  photo: SprayWallPhotoData | null;
};

export type ReportSprayWallMutationVariables = {
  input: { wallUuid: string; reason: SprayWallReportReason };
};

export type ReportSprayWallMutationResponse = {
  reportSprayWall: { status: 'CREATED' | 'ALREADY_REPORTED' };
};

export type GetSprayWallReportsQueryVariables = {
  uuid?: string | null;
};

export type GetSprayWallReportsQueryResponse = {
  sprayWallReports: SprayWallReportData[];
};

export type SetSprayWallHiddenMutationVariables = {
  input: { uuid: string; hidden: boolean };
};

export type SetSprayWallHiddenMutationResponse = {
  setSprayWallHidden: { uuid: string; layoutId: number; hidden: boolean; hiddenAt: string | null };
};
