export type UserDataExportActionErrorReason =
  | 'session_changed'
  | 'offline'
  | 'browser_failed'
  | 'download_failed'
  | 'share_failed'
  | 'sharing_unavailable'
  | 'cleanup_failed';

/** Native errors can contain private signed URLs. Never preserve their cause. */
export class UserDataExportActionError extends Error {
  constructor(public readonly reason: UserDataExportActionErrorReason) {
    super(`User data export action: ${reason}`);
    this.name = 'UserDataExportActionError';
  }
}

export type UserDataExportDownloadRequest = {
  url: string;
  filename: string;
  credentialGeneration: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
};

export function requireCurrentExport(request: UserDataExportDownloadRequest): void {
  if (request.signal.aborted || !request.isCurrent()) {
    throw new UserDataExportActionError('session_changed');
  }
}
