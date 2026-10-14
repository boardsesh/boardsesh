import type { UserDataExportFormat, UserDataExportStatus } from '@boardsesh/shared-schema';
import type { MoreFormModel, MoreOption, MoreRow, MoreSection } from './MoreForm.types';

type Translation = (key: string, options?: Record<string, unknown>) => string;

export type UserDataExportModelInput = {
  t: Translation;
  /** The browser opens a download link; a phone saves or shares a file. */
  isWeb: boolean;
  boardOptions: MoreOption[];
  boardType: string;
  onSelectBoard: (boardKey: string) => void;
  /** Aurora JSON exists only for the six Aurora boards. */
  supportsAurora: boolean;
  format: UserDataExportFormat;
  onSelectFormat: (formatKey: string) => void;
  /** An outbox read, a request or a download is running: every control waits for it. */
  busy: boolean;
  isOffline: boolean;
  statusLoading: boolean;
  statusError: boolean;
  statusFetching: boolean;
  exportStatus: UserDataExportStatus | undefined;
  pollLimitReached: boolean;
  requestPending: boolean;
  downloadPending: boolean;
  /** The last action's failure, already translated, or null. */
  actionErrorCopy: string | null;
  /** Epoch ms, for the retry lock and the file expiry. */
  now: number;
  formatDate: (timestamp: string) => string;
  onGenerate: () => void;
  onDownload: () => void;
  onRefresh: () => void;
};

/**
 * Export climbing data as plain data: pick a board, pick a format, then one
 * status section that says where this week's snapshot is and carries the
 * buttons that move it along.
 *
 * Every state the old status card had is still here, as rows: a spinner row
 * while checking or preparing, the failure as the row's label with the retry
 * date under it, the ready file's dates as their own rows. What used to be red
 * error text is now the first thing in the status footer, ahead of the weekly
 * snapshot and expiry rules.
 */
export function buildUserDataExportModel(input: UserDataExportModelInput): MoreFormModel {
  const { t, exportStatus, format, busy, isOffline, now } = input;
  const sections: MoreSection[] = [];

  sections.push({
    key: 'board',
    footer: t('export.description'),
    rows: [
      {
        kind: 'select',
        key: 'boardType',
        label: t('export.boardType'),
        options: input.boardOptions,
        selectedKey: input.boardType,
        onSelect: input.onSelectBoard,
        disabled: busy,
      },
    ],
  });

  sections.push({
    key: 'format',
    title: t('export.format'),
    footer: format === 'boardsesh' ? t('export.boardseshDescription') : t('export.auroraDescription'),
    rows: [
      input.supportsAurora
        ? {
            kind: 'segmented',
            key: 'format',
            label: t('export.format'),
            options: [
              { key: 'boardsesh', label: t('export.boardseshFormat') },
              { key: 'aurora', label: t('export.auroraFormat') },
            ],
            selectedKey: format,
            onSelect: input.onSelectFormat,
            disabled: busy,
          }
        : // The other three boards have one format. Say which, rather than offer a
          // one-segment control.
          { kind: 'value', key: 'format', label: t('export.boardseshFormat') },
    ],
  });

  const selectedFile = exportStatus?.files.find((file) => file.format === format);
  const retryWaiting = !!exportStatus?.retryAt && Date.parse(exportStatus.retryAt) > now;
  const terminalFailure =
    exportStatus?.errorCode === 'EXPORT_ARCHIVE_INVALID' || exportStatus?.errorCode === 'EXPORT_TOO_LARGE';
  const fileExpired = !!selectedFile && Date.parse(selectedFile.expiresAt) <= now;

  const statusRows: MoreRow[] = [];
  if (input.statusLoading && !isOffline) {
    statusRows.push({ kind: 'value', key: 'checking', label: t('export.checking'), busy: true });
  }
  switch (exportStatus?.status) {
    case 'not_requested':
      statusRows.push({ kind: 'value', key: 'notRequested', label: t('export.notRequested') });
      break;
    case 'generating':
      statusRows.push({
        kind: 'value',
        key: 'generating',
        // Past the polling limit nothing is checking any more, so a spinner would
        // promise an update that only Refresh can bring.
        label: input.pollLimitReached ? t('export.pollStopped') : t('export.generating'),
        busy: !input.pollLimitReached,
      });
      break;
    case 'unavailable':
      statusRows.push({ kind: 'value', key: 'unavailable', label: t('export.unavailable') });
      break;
    case 'failed':
      statusRows.push({
        kind: 'value',
        key: 'failed',
        label:
          exportStatus.errorCode === 'EXPORT_ARCHIVE_INVALID'
            ? t('export.archiveInvalid')
            : exportStatus.errorCode === 'EXPORT_TOO_LARGE'
              ? t('export.tooLarge')
              : t('export.failed'),
        // Archive-invalid and too-large won't fix themselves next week, so no date.
        subtitle:
          !terminalFailure && retryWaiting && exportStatus.retryAt
            ? t('export.retryAt', { date: input.formatDate(exportStatus.retryAt) })
            : undefined,
      });
      break;
    default:
      break;
  }

  // The complete archive stays downloadable while its Aurora companion is still
  // generating or has failed, so this keys on the FILE as well as the status.
  const showFile = !!selectedFile || exportStatus?.status === 'ready';
  if (showFile) {
    statusRows.push({
      kind: 'value',
      key: 'file',
      label:
        exportStatus?.status === 'ready'
          ? t('export.ready')
          : format === 'boardsesh'
            ? t('export.boardseshFormat')
            : t('export.auroraFormat'),
    });
    if (selectedFile) {
      statusRows.push(
        {
          kind: 'value',
          key: 'exportedAt',
          label: t('export.exportedAt', { date: input.formatDate(selectedFile.exportedAt) }),
        },
        {
          kind: 'value',
          key: 'expiresAt',
          label: t('export.expiresAt', { date: input.formatDate(selectedFile.expiresAt) }),
        },
      );
      if (fileExpired) statusRows.push({ kind: 'value', key: 'fileExpired', label: t('export.fileExpired') });
    } else {
      statusRows.push({ kind: 'value', key: 'formatUnavailable', label: t('export.formatUnavailable') });
    }
    statusRows.push({
      kind: 'button',
      key: 'download',
      label: input.isWeb ? t('export.download') : t('export.saveOrShare'),
      loading: input.downloadPending,
      disabled: busy || isOffline || !selectedFile || fileExpired,
      onPress: input.onDownload,
    });
  }

  if (
    exportStatus &&
    (exportStatus.status === 'not_requested' || (exportStatus.status === 'failed' && !terminalFailure))
  ) {
    statusRows.push({
      kind: 'button',
      key: 'generate',
      label: exportStatus.status === 'failed' ? t('export.retry') : t('export.generate'),
      loading: input.requestPending,
      disabled: busy || isOffline || retryWaiting,
      onPress: input.onGenerate,
    });
  }

  statusRows.push({
    kind: 'button',
    key: 'refresh',
    label: t('export.refresh'),
    loading: input.statusFetching,
    disabled: busy || isOffline || input.statusFetching,
    onPress: input.onRefresh,
  });

  // What went wrong first, then what is true of every export.
  const footerParts = [
    isOffline ? t('export.offline') : null,
    input.statusError ? t('export.loadFailed') : null,
    input.actionErrorCopy,
    showFile && exportStatus ? t('export.refreshAt', { date: input.formatDate(exportStatus.refreshAt) }) : null,
    t('export.weekly'),
    t('export.expiry'),
  ].filter((part): part is string => !!part);

  // A failed action while offline says the same sentence as the offline note.
  sections.push({ key: 'status', footer: [...new Set(footerParts)].join('\n\n'), rows: statusRows });

  return { sections };
}
