import { gql } from 'graphql-request';
import type {
  BoardName,
  UserDataExportDownloadLink,
  UserDataExportFormat,
  UserDataExportStatus,
} from '@boardsesh/shared-schema';

const EXPORT_STATUS_FIELDS = gql`
  fragment UserDataExportStatusFields on UserDataExportStatus {
    boardType
    period
    status
    refreshAt
    requestedAt
    completedAt
    retryAt
    error
    files {
      format
      filename
      fileSize
      exportedAt
      expiresAt
    }
  }
`;

export const GET_USER_DATA_EXPORT = gql`
  query GetUserDataExport($boardType: String!, $period: String) {
    userDataExport(boardType: $boardType, period: $period) {
      ...UserDataExportStatusFields
    }
  }
  ${EXPORT_STATUS_FIELDS}
`;

export type UserDataExportVariables = { boardType: BoardName };
export type GetUserDataExportVariables = UserDataExportVariables & { period?: string };
export type GetUserDataExportResponse = { userDataExport: UserDataExportStatus };

export const REQUEST_USER_DATA_EXPORT = gql`
  mutation RequestUserDataExport($boardType: String!) {
    requestUserDataExport(boardType: $boardType) {
      ...UserDataExportStatusFields
    }
  }
  ${EXPORT_STATUS_FIELDS}
`;

export type RequestUserDataExportResponse = { requestUserDataExport: UserDataExportStatus };

export const GET_USER_DATA_EXPORT_DOWNLOAD = gql`
  query GetUserDataExportDownload($boardType: String!, $period: String!, $format: UserDataExportFormat!) {
    userDataExportDownload(boardType: $boardType, period: $period, format: $format) {
      url
      expiresAt
      filename
    }
  }
`;

export type UserDataExportDownloadVariables = UserDataExportVariables & {
  period: string;
  format: UserDataExportFormat;
};
export type GetUserDataExportDownloadResponse = { userDataExportDownload: UserDataExportDownloadLink };
