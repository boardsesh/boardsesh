import { describe, expect, it, vi } from 'vitest';
import type { UserDataExportStatus } from '@boardsesh/shared-schema';
import { buildUserDataExportModel, type UserDataExportModelInput } from '../user-data-export-model';
import type { MoreButtonRow, MoreRow } from '../MoreForm.types';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 86_400_000;

function status(overrides: Partial<UserDataExportStatus> = {}): UserDataExportStatus {
  return {
    boardType: 'kilter',
    period: '2026-W42',
    status: 'not_requested',
    files: [],
    refreshAt: new Date(NOW + 5 * DAY).toISOString(),
    ...overrides,
  };
}

function readyStatus(overrides: Partial<UserDataExportStatus> = {}): UserDataExportStatus {
  return status({
    status: 'ready',
    files: [
      {
        format: 'boardsesh',
        filename: 'kilter-boardsesh.json',
        exportedAt: new Date(NOW - DAY).toISOString(),
        expiresAt: new Date(NOW + 13 * DAY).toISOString(),
      },
    ],
    ...overrides,
  });
}

function makeInput(overrides: Partial<UserDataExportModelInput> = {}): UserDataExportModelInput {
  return {
    t: (key) => key,
    isWeb: false,
    boardOptions: [
      { key: 'kilter', label: 'Kilter' },
      { key: 'moonboard', label: 'MoonBoard' },
    ],
    boardType: 'kilter',
    onSelectBoard: vi.fn(),
    supportsAurora: true,
    format: 'boardsesh',
    onSelectFormat: vi.fn(),
    busy: false,
    isOffline: false,
    statusLoading: false,
    statusError: false,
    statusFetching: false,
    exportStatus: status(),
    pollLimitReached: false,
    requestPending: false,
    downloadPending: false,
    actionErrorCopy: null,
    now: NOW,
    formatDate: (timestamp) => timestamp.slice(0, 10),
    onGenerate: vi.fn(),
    onDownload: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

function rows(input: UserDataExportModelInput): MoreRow[] {
  return buildUserDataExportModel(input).sections.flatMap((section) => section.rows);
}

function rowKeys(input: UserDataExportModelInput): string[] {
  return rows(input).map((row) => row.key);
}

function buttonRow(input: UserDataExportModelInput, key: string): MoreButtonRow {
  const row = rows(input).find((candidate) => candidate.key === key);
  if (!row || row.kind !== 'button') throw new Error(`no button ${key}`);
  return row;
}

function statusFooter(input: UserDataExportModelInput): string[] {
  const footer = buildUserDataExportModel(input).sections.find((section) => section.key === 'status')?.footer;
  return footer ? footer.split('\n\n') : [];
}

describe('buildUserDataExportModel — pickers', () => {
  it('picks the board from a menu, with the explanation as its footer', () => {
    const [board] = buildUserDataExportModel(makeInput()).sections;
    expect(board.footer).toBe('export.description');
    expect(board.rows[0]).toMatchObject({ kind: 'select', key: 'boardType', selectedKey: 'kilter', disabled: false });
  });

  it('offers both formats as a segmented control on an Aurora board, described in the footer', () => {
    const format = buildUserDataExportModel(makeInput({ format: 'aurora' })).sections[1];
    expect(format.rows[0]).toMatchObject({ kind: 'segmented', selectedKey: 'aurora' });
    expect(format.footer).toBe('export.auroraDescription');
  });

  it('names the one format, with no control, on a board with no Aurora file', () => {
    const format = buildUserDataExportModel(makeInput({ supportsAurora: false })).sections[1];
    expect(format.rows[0]).toMatchObject({ kind: 'value', label: 'export.boardseshFormat' });
    expect(format.footer).toBe('export.boardseshDescription');
  });

  it('locks both pickers while an action runs', () => {
    const [board, format] = buildUserDataExportModel(makeInput({ busy: true })).sections;
    expect(board.rows[0]).toMatchObject({ disabled: true });
    expect(format.rows[0]).toMatchObject({ disabled: true });
  });
});

describe('buildUserDataExportModel — status', () => {
  it('spins while checking and while preparing, but not once polling has stopped', () => {
    expect(rows(makeInput({ statusLoading: true, exportStatus: undefined }))[2]).toMatchObject({
      key: 'checking',
      busy: true,
    });
    const generating = makeInput({ exportStatus: status({ status: 'generating' }) });
    expect(rows(generating).find((row) => row.key === 'generating')).toMatchObject({
      label: 'export.generating',
      busy: true,
    });
    const stopped = makeInput({ exportStatus: status({ status: 'generating' }), pollLimitReached: true });
    expect(rows(stopped).find((row) => row.key === 'generating')).toMatchObject({
      label: 'export.pollStopped',
      busy: false,
    });
  });

  it('offers Prepare export for a week with nothing prepared', () => {
    expect(rowKeys(makeInput())).toEqual(['boardType', 'format', 'notRequested', 'generate', 'refresh']);
  });

  it('shows the retry date and locks Try again during the weekly budget lock', () => {
    const input = makeInput({
      exportStatus: status({ status: 'failed', retryAt: new Date(NOW + DAY).toISOString() }),
    });
    expect(rows(input).find((row) => row.key === 'failed')).toMatchObject({
      label: 'export.failed',
      subtitle: 'export.retryAt',
    });
    expect(buttonRow(input, 'generate')).toMatchObject({ label: 'export.retry', disabled: true });
  });

  it.each([
    ['EXPORT_ARCHIVE_INVALID', 'export.archiveInvalid'],
    ['EXPORT_TOO_LARGE', 'export.tooLarge'],
  ] as const)('explains %s without a retry that cannot help', (errorCode, copy) => {
    const input = makeInput({
      exportStatus: status({ status: 'failed', errorCode, retryAt: new Date(NOW + DAY).toISOString() }),
    });
    const failed = rows(input).find((row) => row.key === 'failed');
    expect(failed).toMatchObject({ label: copy, subtitle: undefined });
    expect(rowKeys(input)).not.toContain('generate');
  });

  it('shows the ready file with its dates, and the next snapshot date in the footer', () => {
    const input = makeInput({ exportStatus: readyStatus() });
    expect(rowKeys(input)).toEqual(['boardType', 'format', 'file', 'exportedAt', 'expiresAt', 'download', 'refresh']);
    expect(statusFooter(input)).toEqual(['export.refreshAt', 'export.weekly', 'export.expiry']);
  });

  it('labels the download for the browser and for a phone', () => {
    expect(buttonRow(makeInput({ exportStatus: readyStatus(), isWeb: true }), 'download').label).toBe(
      'export.download',
    );
    expect(buttonRow(makeInput({ exportStatus: readyStatus() }), 'download').label).toBe('export.saveOrShare');
  });

  it('greys the download for an expired file and says why', () => {
    const expired = readyStatus();
    expired.files[0].expiresAt = new Date(NOW - 1).toISOString();
    const input = makeInput({ exportStatus: expired });
    expect(rowKeys(input)).toContain('fileExpired');
    expect(buttonRow(input, 'download').disabled).toBe(true);
  });

  it('says the selected format is missing rather than offering a dead download', () => {
    const input = makeInput({ exportStatus: readyStatus(), format: 'aurora' });
    expect(rowKeys(input)).toContain('formatUnavailable');
    expect(buttonRow(input, 'download').disabled).toBe(true);
  });

  it('keeps the complete archive downloadable while its Aurora companion is still preparing', () => {
    const input = makeInput({ exportStatus: readyStatus({ status: 'generating' }) });
    const file = rows(input).find((row) => row.key === 'file');
    expect(file).toMatchObject({ label: 'export.boardseshFormat' });
    expect(buttonRow(input, 'download').disabled).toBe(false);
  });
});

describe('buildUserDataExportModel — actions and errors', () => {
  it('disables every network action offline and says so first in the footer', () => {
    const input = makeInput({ isOffline: true, exportStatus: readyStatus({ status: 'failed' }) });
    expect(buttonRow(input, 'download').disabled).toBe(true);
    expect(buttonRow(input, 'generate').disabled).toBe(true);
    expect(buttonRow(input, 'refresh').disabled).toBe(true);
    expect(statusFooter(input)[0]).toBe('export.offline');
  });

  it('does not say the offline sentence twice when the failed action was itself offline', () => {
    const footer = statusFooter(makeInput({ isOffline: true, actionErrorCopy: 'export.offline' }));
    expect(footer.filter((note) => note === 'export.offline')).toHaveLength(1);
  });

  it('leads the footer with the last action error, ahead of the weekly rules', () => {
    expect(statusFooter(makeInput({ actionErrorCopy: 'export.requestFailed' }))).toEqual([
      'export.requestFailed',
      'export.weekly',
      'export.expiry',
    ]);
    expect(statusFooter(makeInput({ statusError: true, exportStatus: undefined }))[0]).toBe('export.loadFailed');
  });

  it('spins each button for its own action only', () => {
    const requesting = makeInput({ requestPending: true, busy: true });
    expect(buttonRow(requesting, 'generate')).toMatchObject({ loading: true, disabled: true });
    expect(buttonRow(requesting, 'refresh')).toMatchObject({ loading: false, disabled: true });
    const downloading = makeInput({ exportStatus: readyStatus(), downloadPending: true, busy: true });
    expect(buttonRow(downloading, 'download')).toMatchObject({ loading: true, disabled: true });
    const fetching = makeInput({ statusFetching: true });
    expect(buttonRow(fetching, 'refresh')).toMatchObject({ loading: true, disabled: true });
  });
});
