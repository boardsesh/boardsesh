import { gql } from 'graphql-request';
import type { AdminBoard, AdminBoardConnection, AdminBoardsInput, UpdateBoardInput } from '@boardsesh/shared-schema';

const ADMIN_BOARD_FIELDS = `
  uuid slug ownerId ownerDisplayName boardType layoutId sizeId setIds name
  description locationName latitude longitude isPublic isUnlisted hideLocation
  isOwned angle isAngleAdjustable hasLeds serialNumber timerName createdAt updatedAt
  gymUuid gymName gymSlug canEdit
`;

export const ADMIN_BOARDS = gql`
  query AdminBoards($input: AdminBoardsInput!) {
    adminBoards(input: $input) {
      boards {
        uuid
        slug
        name
        boardType
        angle
        isPublic
        isUnlisted
        ownerId
        ownerDisplayName
        gymUuid
        gymName
        gymSlug
        canEdit
      }
      totalCount
      hasMore
    }
  }
`;

export const ADMIN_BOARD = gql`
  query AdminBoard($boardUuid: ID!) {
    adminBoard(boardUuid: $boardUuid) {
      ${ADMIN_BOARD_FIELDS}
    }
  }
`;

export const ADMIN_UPDATE_BOARD = gql`
  mutation AdminUpdateBoard($input: UpdateBoardInput!) {
    adminUpdateBoard(input: $input) {
      ${ADMIN_BOARD_FIELDS}
    }
  }
`;

export type AdminBoardsQueryVariables = { input: AdminBoardsInput };
export type AdminBoardSummary = Pick<
  AdminBoard,
  | 'uuid'
  | 'slug'
  | 'name'
  | 'boardType'
  | 'angle'
  | 'isPublic'
  | 'isUnlisted'
  | 'ownerId'
  | 'ownerDisplayName'
  | 'gymUuid'
  | 'gymName'
  | 'gymSlug'
  | 'canEdit'
>;
export type AdminBoardsQueryResponse = {
  adminBoards: Omit<AdminBoardConnection, 'boards'> & { boards: AdminBoardSummary[] };
};
export type AdminBoardQueryVariables = { boardUuid: string };
export type AdminBoardQueryResponse = { adminBoard: AdminBoard | null };
export type AdminUpdateBoardMutationVariables = { input: UpdateBoardInput };
export type AdminUpdateBoardMutationResponse = { adminUpdateBoard: AdminBoard };
