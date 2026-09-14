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

export const DELETE_SPRAY_WALL = gql`
  mutation DeleteSprayWall($uuid: ID!) {
    deleteSprayWall(uuid: $uuid)
  }
`;
