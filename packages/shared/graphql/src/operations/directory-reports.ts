import { gql } from 'graphql-request';
import type {
  DirectoryReport,
  DirectoryReportConnection,
  DirectoryReportStatus,
  DirectoryReportSubmitResult,
  DirectoryReportTargetKind,
  ReportBoardInput,
  ReportGymInput,
  ResolveDirectoryReportInput,
} from '@boardsesh/shared-schema';

// Report a problem with a board or a gym listing (docs/product/directory-reports.md).
// Nothing in the apps selects these yet: the mobile and web PRs wire them up
// once the backend that serves them is live.

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
 * The `directoryNotice` selection for the notification feeds. Add it to the
 * grouped and flat notification queries, and the live notification
 * subscription, only once the backend that serves it is in production: an
 * unknown field fails the whole query.
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
  }
`;

export const REPORT_BOARD = gql`
  mutation ReportBoard($input: ReportBoardInput!) {
    reportBoard(input: $input) {
      status
      reportUuid
      routedTo
      otherReporterCount
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
