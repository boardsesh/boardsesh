import type { UserBoard } from './board-entities';
export type BoardMergeRequest = {
  reports: { reason: string; createdAt: string }[];
  uuid: string;
  status: string;
  reason: string;
  canonicalBoardUuid: string;
  boardUuids: string[];
  boards: UserBoard[];
  createdAt: string;
  canResolve: boolean;
  resolutionReason?: string | null;
};
export type BoardMergePreview = {
  boards: UserBoard[];
  suggestedCanonicalBoardUuid: string;
  canMerge: boolean;
  version: string;
  reason?: string | null;
};
export type BoardMergeCandidatesInput = {
  boardUuid?: string;
  gymUuid?: string;
  query?: string;
  limit?: number;
  offset?: number;
};
export type BoardMergeRequestsInput = {
  gymUuid?: string;
  boardType?: string;
  status?: string;
  limit?: number;
  offset?: number;
};
export type RequestBoardMergeInput = { boardUuids: string[]; canonicalBoardUuid: string; reason: string };
export type MergeBoardsInput = RequestBoardMergeInput & { version: string };
export type ResolveBoardMergeRequestInput = {
  requestUuid: string;
  approve: boolean;
  canonicalBoardUuid?: string;
  version?: string;
  reason?: string;
};
