import { gql } from 'graphql-request';
import type {
  BoardSetupChangeConnection,
  DirectoryReport,
  DirectoryReportConnection,
  DirectoryReportStatus,
  DirectoryReportSubmitResult,
  DirectoryReportTargetKind,
  ReportBoardInput,
  ReportGymInput,
  ResolveDirectoryReportInput,
  UserBoard,
} from '@boardsesh/shared-schema';
import { BOARD_FIELDS } from './boards';

// Report a problem with a board or a gym listing (docs/product/directory-reports.md).
// The mobile app sends these (PR 4 of #8043) and www selects them (the report
// dialog, Manage gym → Boards, /admin/board-reports). The grouped notification
// feed selects DIRECTORY_NOTICE_FIELDS, so a client that selects them ships
// only once the backend that serves them is in production: an unknown field
// fails the whole query.
//
// Suggested setups (docs/product/directory-reports.md, "Suggested setup"):
// REPORT_BOARD's result, a note's `suggestedSetup`, the climber-change notice
// fields, UNDO_BOARD_SETUP_CHANGE and GET_ADMIN_BOARD_SETUP_CHANGES.

/** Every `BoardSetup` field. */
export const BOARD_SETUP_FIELDS = `
  layoutId
  sizeId
  setIds
  angle
`;

/** Every `DirectoryReport` field. Interpolated, not a fragment, like the other shared field sets. */
export const DIRECTORY_REPORT_FIELDS = `
  uuid
  targetKind
  reason
  status
  routedTo
  boardUuid
  boardName
  boardType
  gymUuid
  gymName
  duplicateOfBoardUuid
  duplicateOfBoardName
  duplicateOfGymUuid
  duplicateOfGymName
  reporterCount
  notes {
    note
    createdAt
    reporter {
      userId
      displayName
      avatarUrl
    }
    suggestedSetup {
      ${BOARD_SETUP_FIELDS}
    }
  }
  createdAt
  remindedAt
  escalatedAt
  escalatesAt
  resolvedAt
  resolvedByRole
  resolutionNote
  viewerRole
  viewerIsReporter
  viewerCanResolve
`;

/**
 * The `directoryNotice` selection for the notification feeds. The grouped feed
 * (the app's inbox) selects it. The flat feed and the live subscription don't:
 * nothing reads it there yet.
 */
export const DIRECTORY_NOTICE_FIELDS = `
  directoryNotice {
    targetKind
    boardUuid
    boardName
    boardType
    gymUuid
    gymName
    reportUuid
    reason
    outcome
    resolvedByRole
    resolutionNote
    actorRole
    isReminder
    recipientIsCreator
    setupChangeEventId
    setupBefore {
      ${BOARD_SETUP_FIELDS}
    }
    setupAfter {
      ${BOARD_SETUP_FIELDS}
    }
    setupChangeState
  }
`;

export const REPORT_BOARD = gql`
  mutation ReportBoard($input: ReportBoardInput!) {
    reportBoard(input: $input) {
      status
      reportUuid
      routedTo
      otherReporterCount
      setupOutcome
      setupReviewReason
      board {
        ${BOARD_FIELDS}
      }
    }
  }
`;

export const REPORT_GYM = gql`
  mutation ReportGym($input: ReportGymInput!) {
    reportGym(input: $input) {
      status
      reportUuid
      routedTo
      otherReporterCount
    }
  }
`;

export const RESOLVE_DIRECTORY_REPORT = gql`
  mutation ResolveDirectoryReport($input: ResolveDirectoryReportInput!) {
    resolveDirectoryReport(input: $input) {
      ${DIRECTORY_REPORT_FIELDS}
    }
  }
`;

export const GET_BOARD_REPORTS = gql`
  query GetBoardReports($boardUuid: ID!) {
    boardReports(boardUuid: $boardUuid) {
      ${DIRECTORY_REPORT_FIELDS}
    }
  }
`;

export const GET_MY_DIRECTORY_REPORTS_TO_REVIEW = gql`
  query GetMyDirectoryReportsToReview($includeResolved: Boolean, $first: Int) {
    myDirectoryReportsToReview(includeResolved: $includeResolved, first: $first) {
      ${DIRECTORY_REPORT_FIELDS}
    }
  }
`;

export const GET_ADMIN_DIRECTORY_REPORTS = gql`
  query GetAdminDirectoryReports(
    $status: DirectoryReportStatus
    $targetKind: DirectoryReportTargetKind
    $first: Int
    $after: String
  ) {
    adminDirectoryReports(status: $status, targetKind: $targetKind, first: $first, after: $after) {
      reports {
        ${DIRECTORY_REPORT_FIELDS}
      }
      nextCursor
    }
  }
`;

/**
 * Put back the setup a climber's change replaced. Refused with
 * `BOARD_SETUP_CHANGED_SINCE` (`isBoardSetupChangedSinceError`) once the board
 * has changed again or the change was undone already.
 */
export const UNDO_BOARD_SETUP_CHANGE = gql`
  mutation UndoBoardSetupChange($eventId: ID!) {
    undoBoardSetupChange(eventId: $eventId) {
      ${BOARD_FIELDS}
    }
  }
`;

/** The admin list of climbers' setup changes, newest first. */
export const GET_ADMIN_BOARD_SETUP_CHANGES = gql`
  query GetAdminBoardSetupChanges($first: Int, $after: String) {
    adminBoardSetupChanges(first: $first, after: $after) {
      changes {
        eventId
        board {
          uuid
          name
          slug
          boardType
        }
        gym {
          uuid
          name
          slug
        }
        before {
          ${BOARD_SETUP_FIELDS}
        }
        after {
          ${BOARD_SETUP_FIELDS}
        }
        climberDisplayName
        createdAt
        state
      }
      nextCursor
    }
  }
`;

export type ReportBoardMutationVariables = { input: ReportBoardInput };
export type ReportBoardMutationResponse = { reportBoard: DirectoryReportSubmitResult };

export type ReportGymMutationVariables = { input: ReportGymInput };
export type ReportGymMutationResponse = { reportGym: DirectoryReportSubmitResult };

export type ResolveDirectoryReportMutationVariables = { input: ResolveDirectoryReportInput };
export type ResolveDirectoryReportMutationResponse = { resolveDirectoryReport: DirectoryReport };

export type GetBoardReportsQueryVariables = { boardUuid: string };
export type GetBoardReportsQueryResponse = { boardReports: DirectoryReport[] };

export type GetMyDirectoryReportsToReviewQueryVariables = { includeResolved?: boolean; first?: number };
export type GetMyDirectoryReportsToReviewQueryResponse = { myDirectoryReportsToReview: DirectoryReport[] };

export type GetAdminDirectoryReportsQueryVariables = {
  status?: DirectoryReportStatus;
  targetKind?: DirectoryReportTargetKind;
  first?: number;
  after?: string;
};
export type GetAdminDirectoryReportsQueryResponse = { adminDirectoryReports: DirectoryReportConnection };

export type UndoBoardSetupChangeMutationVariables = { eventId: string };
export type UndoBoardSetupChangeMutationResponse = { undoBoardSetupChange: UserBoard };

export type GetAdminBoardSetupChangesQueryVariables = { first?: number; after?: string };
export type GetAdminBoardSetupChangesQueryResponse = { adminBoardSetupChanges: BoardSetupChangeConnection };
