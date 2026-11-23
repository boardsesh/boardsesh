import { gql } from 'graphql-request';
import { BOARD_FIELDS } from './boards';
import type {
  UserBoard,
  BoardMergeRequest,
  BoardMergePreview,
  BoardMergeCandidatesInput,
  BoardMergeRequestsInput,
  RequestBoardMergeInput,
  MergeBoardsInput,
  ResolveBoardMergeRequestInput,
} from '@boardsesh/shared-schema';
const REQUEST_FIELDS = `reports { reason createdAt } uuid status reason canonicalBoardUuid boardUuids createdAt canResolve resolutionReason boards { ${BOARD_FIELDS} }`;
export const BOARD_MERGE_CANDIDATES = gql`query BoardMergeCandidates($input: BoardMergeCandidatesInput) { boardMergeCandidates(input: $input) { boards { ${BOARD_FIELDS} } hasMore } }`;
export const BOARD_MERGE_PREVIEW = gql`query BoardMergePreview($boardUuids: [ID!]!) { boardMergePreview(boardUuids: $boardUuids) { boards { ${BOARD_FIELDS} } suggestedCanonicalBoardUuid canMerge version reason } }`;
export const BOARD_MERGE_REQUESTS = gql`query BoardMergeRequests($input: BoardMergeRequestsInput) { boardMergeRequests(input: $input) { requests { ${REQUEST_FIELDS} } hasMore } }`;
export const REQUEST_BOARD_MERGE = gql`mutation RequestBoardMerge($input: RequestBoardMergeInput!) { requestBoardMerge(input: $input) { ${REQUEST_FIELDS} } }`;
export const MERGE_BOARDS = gql`
  mutation MergeBoards($input: MergeBoardsInput!) {
    mergeBoards(input: $input) {
      canonicalBoardUuid
    }
  }
`;
export const RESOLVE_BOARD_MERGE_REQUEST = gql`mutation ResolveBoardMergeRequest($input: ResolveBoardMergeRequestInput!) { resolveBoardMergeRequest(input: $input) { ${REQUEST_FIELDS} } }`;
export type BoardMergeCandidatesQueryResponse = { boardMergeCandidates: { boards: UserBoard[]; hasMore: boolean } };
export type BoardMergeCandidatesQueryVariables = { input?: BoardMergeCandidatesInput };
export type BoardMergePreviewQueryResponse = { boardMergePreview: BoardMergePreview };
export type BoardMergePreviewQueryVariables = { boardUuids: string[] };
export type BoardMergeRequestsQueryResponse = {
  boardMergeRequests: { requests: BoardMergeRequest[]; hasMore: boolean };
};
export type BoardMergeRequestsQueryVariables = { input?: BoardMergeRequestsInput };
export type RequestBoardMergeMutationResponse = { requestBoardMerge: BoardMergeRequest };
export type RequestBoardMergeMutationVariables = { input: RequestBoardMergeInput };
export type MergeBoardsMutationResponse = { mergeBoards: { canonicalBoardUuid: string } };
export type MergeBoardsMutationVariables = { input: MergeBoardsInput };
export type ResolveBoardMergeRequestMutationResponse = { resolveBoardMergeRequest: BoardMergeRequest };
export type ResolveBoardMergeRequestMutationVariables = { input: ResolveBoardMergeRequestInput };
