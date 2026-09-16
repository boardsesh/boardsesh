import { gql } from 'graphql-request';

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
const SPRAY_WALL_FIELDS = `
  uuid
  layoutId
  sizeId
  referenceWidth
  referenceHeight
  holdCount
  viewerCanEdit
  # Only ever non-null for the OWNER — a hidden wall does not resolve for anybody
  # else — so a client can render the notice off its presence alone (SW-17).
  hiddenAt
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
  currentVersion {
    ${SPRAY_WALL_VERSION_FIELDS}
  }
`;

export const GET_SPRAY_WALL = gql`
  query GetSprayWall($uuid: ID!) {
    sprayWall(uuid: $uuid) {
      ${SPRAY_WALL_FIELDS}
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

// ---------------------------------------------------------------------------
// Resets (SW-12 / SW-13)
//
// Three documents for three very different acts. `PROPOSE_SPRAY_WALL_RESET` is a
// QUERY and writes nothing at all, so the compare screen may re-ask as often as
// the owner changes their mind. `COMMIT_SPRAY_WALL_VERSION` is the one call that
// lands a new generation of the wall. `REMIX_CLIMB` writes nothing either — it
// hands back a starting point, and the child is saved as an ordinary climb.
// ---------------------------------------------------------------------------

/**
 * What a reset would do, computed and thrown away.
 *
 * `detections` are already in the wall's CANONICAL frame — the client maps them
 * through the draft version's own homography before sending, because the server
 * never warps an image and never re-runs detection. The draft must carry anchors
 * or this is refused with `SPRAY_WALL_ANCHORS_REQUIRED`: from version 2 on, the
 * four corners are the only thing that says where the new photograph's pixels
 * sit in the frame version 1 defined.
 */
export const PROPOSE_SPRAY_WALL_RESET = gql`
  query ProposeSprayWallReset($input: ProposeSprayWallResetInput!) {
    proposeSprayWallReset(input: $input) {
      versionNumber
      kept {
        holdId
        detectionIndex
        confidence
      }
      removed
      added
      lowConfidence
      climbsAffected
      movesSuggested {
        movedFromHoldId
        detectionIndex
        distance
      }
      aspectMismatch
    }
  }
`;

/**
 * Apply the reviewed decisions and publish the draft, in one transaction.
 *
 * Every decision is re-validated under the wall lock against the wall as it is
 * NOW, so a proposal the owner sat on while another editor published is rejected
 * rather than applied.
 */
export const COMMIT_SPRAY_WALL_VERSION = gql`
  mutation CommitSprayWallVersion($input: CommitSprayWallVersionInput!) {
    commitSprayWallVersion(input: $input) {
      version {
        ${SPRAY_WALL_VERSION_FIELDS}
      }
      keptCount
      removedCount
      addedCount
      climbsChanged
    }
  }
`;

/**
 * A remix starting point: the parent's frames with the holds it has lost taken
 * out, plus the successors the reset review linked for them.
 *
 * `sprayWallUuid` carries the share-link capability — send it whenever the
 * viewer reached the wall by its uuid rather than by owning it, or a crew holding
 * an unlisted wall's link could set climbs on it and not remix one.
 */
export const REMIX_CLIMB = gql`
  query RemixClimb($parentUuid: ID!, $sprayWallUuid: ID) {
    remixClimb(parentUuid: $parentUuid, sprayWallUuid: $sprayWallUuid) {
      parentUuid
      parentName
      layoutId
      angle
      frames
      lostHoldIds
      keptHoldIds
      suggestedHoldIds
    }
  }
`;
