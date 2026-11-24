import {
  GET_GYM,
  SEARCH_GYMS,
  GET_GYM_STATS,
  GET_GYM_GRADE_COMPARISON,
  GET_GYM_GRADE_COLLECTION_OPTIONS,
  SET_GYM_GRADE_COLLECTION,
  GET_GYM_MEMBERS,
  STRAY_BOARDS_FOR_GYM,
  SET_GYM_REPORTING_TIME_ZONE,
  SET_GYM_REPORTING_BOARD_ALIAS,
  UPDATE_GYM,
  GRANT_GYM_WRITE_ACCESS,
  REVOKE_GYM_WRITE_ACCESS,
  REMOVE_GYM_MEMBER,
  LINK_BOARD_TO_GYM,
  ATTACH_BOARD_TO_GYM,
  DETACH_BOARD_FROM_GYM,
  FOLLOW_GYM,
  UNFOLLOW_GYM,
  REQUEST_GYM_CLAIM,
  REPORT_GYM_DUPLICATE,
} from '@boardsesh/graphql/operations/gyms';
import {
  GET_GYM_KIOSKS,
  CREATE_GYM_KIOSK,
  UPDATE_GYM_KIOSK,
  DELETE_GYM_KIOSK,
} from '@boardsesh/graphql/operations/gym-kiosks';
import {
  GET_COMMENTS,
  ADD_COMMENT,
  UPDATE_COMMENT,
  DELETE_COMMENT,
  VOTE,
} from '@boardsesh/graphql/operations/comments-votes';

/** Explicit projection: an MCP response never includes a board's pairing serial. */
export const MCP_BOARD_FIELDS = `
  uuid slug ownerId ownerDisplayName boardType layoutId sizeId setIds
  name description locationName latitude longitude isPublic isUnlisted hideLocation
  isOwned angle isAngleAdjustable hasLeds litByWallDevice gymUuid gymName
  canEdit canDelete canRemoveFromGym openReportCount
`;

/** Staff see the same anonymized report notes as the gym page, even if globally privileged. */
const MCP_REPORT_FIELDS = `
  uuid targetKind reason status boardUuid gymUuid
  duplicateOfBoardUuid duplicateOfGymUuid routedTo reporterCount
  notes { note suggestedSetup { layoutId sizeId setIds angle } }
  createdAt escalatesAt resolvedAt resolutionNote viewerCanResolve
`;

export const gymMcpDocuments = {
  getGym: GET_GYM,
  searchGyms: SEARCH_GYMS,
  getStats: GET_GYM_STATS,
  getGradeComparison: GET_GYM_GRADE_COMPARISON,
  getGradeCollectionOptions: GET_GYM_GRADE_COLLECTION_OPTIONS,
  setGradeCollection: SET_GYM_GRADE_COLLECTION,
  getMembers: GET_GYM_MEMBERS,
  getStrays: STRAY_BOARDS_FOR_GYM,
  setTimeZone: SET_GYM_REPORTING_TIME_ZONE,
  setBoardAlias: SET_GYM_REPORTING_BOARD_ALIAS,
  updateGym: UPDATE_GYM,
  grantAccess: GRANT_GYM_WRITE_ACCESS,
  revokeAccess: REVOKE_GYM_WRITE_ACCESS,
  removeMember: REMOVE_GYM_MEMBER,
  linkBoard: LINK_BOARD_TO_GYM,
  attachBoard: ATTACH_BOARD_TO_GYM,
  detachBoard: DETACH_BOARD_FROM_GYM,
  followGym: FOLLOW_GYM,
  unfollowGym: UNFOLLOW_GYM,
  requestClaim: REQUEST_GYM_CLAIM,
  reportDuplicate: REPORT_GYM_DUPLICATE,
  getKiosks: GET_GYM_KIOSKS,
  createKiosk: CREATE_GYM_KIOSK,
  updateKiosk: UPDATE_GYM_KIOSK,
  deleteKiosk: DELETE_GYM_KIOSK,
  getComments: GET_COMMENTS,
  addComment: ADD_COMMENT,
  updateComment: UPDATE_COMMENT,
  deleteComment: DELETE_COMMENT,
  vote: VOTE,
  reportBoard: `mutation GymMcpReportBoard($input: ReportBoardInput!) { reportBoard(input: $input) {
    status reportUuid routedTo otherReporterCount setupOutcome setupReviewReason board { ${MCP_BOARD_FIELDS} }
  } }`,
  reportGym:
    'mutation GymMcpReportGym($input: ReportGymInput!) { reportGym(input: $input) { status reportUuid routedTo otherReporterCount } }',
  resolveReport: `mutation GymMcpResolveReport($input: ResolveDirectoryReportInput!) { resolveDirectoryReport(input: $input) { ${MCP_REPORT_FIELDS} } }`,
  getBoards: `query GymMcpBoards($gymUuid: ID!) { gymBoards(gymUuid: $gymUuid) { ${MCP_BOARD_FIELDS} } }`,
  getBoard: `query GymMcpBoard($boardUuid: ID!) { board(boardUuid: $boardUuid) { ${MCP_BOARD_FIELDS} } }`,
  updateBoard: `mutation GymMcpUpdateBoard($input: UpdateBoardInput!) { updateBoard(input: $input) { ${MCP_BOARD_FIELDS} } }`,
  deleteBoard: 'mutation GymMcpDeleteBoard($boardUuid: ID!) { deleteBoard(boardUuid: $boardUuid) }',
  getBoardReports: `query GymMcpBoardReports($boardUuid: ID!) { boardReports(boardUuid: $boardUuid) { ${MCP_REPORT_FIELDS} } }`,
  getPendingClaim:
    'query GymMcpPendingClaim($gymUuid: ID!) { gym(gymUuid: $gymUuid) { uuid myPendingClaim { id method createdAt } } }',
  searchUsers: `query GymMcpSearchUsers($input: SearchUsersInput!) {
    searchUsers(input: $input) { results { user { id displayName avatarUrl } } totalCount hasMore }
  }`,
} as const;

export type GymMcpDocumentName = keyof typeof gymMcpDocuments;
