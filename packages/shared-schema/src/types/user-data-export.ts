import type { BoardName } from './board-config';

export type UserDataExportFormat = 'boardsesh' | 'aurora';
export type UserDataExportState = 'not_requested' | 'generating' | 'ready' | 'failed' | 'unavailable';

export type UserDataExportFile = {
  format: UserDataExportFormat;
  filename: string;
  fileSize?: number;
  exportedAt: string;
  expiresAt: string;
};

export type UserDataExportStatus = {
  boardType: BoardName;
  period: string;
  status: UserDataExportState;
  files: UserDataExportFile[];
  refreshAt: string;
  requestedAt?: string;
  completedAt?: string;
  retryAt?: string;
  error?: string;
  /**
   * @deprecated Legacy authenticated Aurora HTTP download. New clients should
   * request a fresh userDataExportDownload link instead of proxying file bytes.
   */
  downloadUrl?: string;
  fileSize?: number;
};

export type UserDataExportDownloadLink = {
  url: string;
  expiresAt: string;
  filename: string;
};
