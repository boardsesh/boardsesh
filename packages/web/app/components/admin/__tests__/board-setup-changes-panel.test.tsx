import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { boardSetupSummary, getBoardLayouts, getBoardSizesForLayoutId } from '@boardsesh/board-config';
import type { BoardSetupChange } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

const mockAuth = vi.hoisted(() => ({ current: { token: 'admin-token' as string | null, isLoading: false } }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => mockAuth.current,
}));

const mockRefreshAccessToken = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/app/lib/auth/browser-access-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/auth/browser-access-token')>()),
  refreshAccessToken: mockRefreshAccessToken,
}));

const mockReplace = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => ({ current: '' }));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ replace: mockReplace }),
  usePathnameWithoutLocale: () => '/admin/board-reports',
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(mockSearch.current),
}));

const mockShowMessage = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

import BoardReportsPanel from '../board-reports-panel';
import BoardSetupChangesPanel from '../board-setup-changes-panel';
import {
  GET_ADMIN_BOARD_SETUP_CHANGES,
  GET_ADMIN_DIRECTORY_REPORTS,
  UNDO_BOARD_SETUP_CHANGE,
} from '@boardsesh/graphql/operations';

const kilterLayout = getBoardLayouts('kilter').find(
  (layout) => getBoardSizesForLayoutId('kilter', layout.id).length >= 2,
);
if (!kilterLayout) throw new Error('Expected a Kilter layout with two sizes');
const [kilterSize, otherKilterSize] = getBoardSizesForLayoutId('kilter', kilterLayout.id);

const before = { layoutId: kilterLayout.id, sizeId: kilterSize.id, setIds: '1', angle: null };
const after = { layoutId: kilterLayout.id, sizeId: otherKilterSize.id, setIds: '1', angle: null };

function change(overrides: Partial<BoardSetupChange> = {}): BoardSetupChange {
  return {
    eventId: 'event-1',
    board: { uuid: 'board-1', name: 'Crux Kilter', slug: 'crux-kilter', boardType: 'kilter' },
    gym: { uuid: 'gym-1', name: 'Crux', slug: 'crux' },
    before,
    after,
    climberDisplayName: 'Ana',
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    state: 'LIVE',
    ...overrides,
  };
}

function refusal(code: string): Error {
  return Object.assign(new Error(code), {
    response: { errors: [{ message: code, extensions: { code } }] },
  });
}

/**
 * The list answers `pages` in turn, the last one for every read after it; an
 * undo answers `undo` (a value, or an error to throw).
 */
function serve(pages: BoardSetupChange[][], undo: { ok: true } | { ok: false; error: Error }) {
  let reads = 0;
  mockRequest.mockImplementation(async (document: string) => {
    if (document === GET_ADMIN_BOARD_SETUP_CHANGES) {
      const page = pages[Math.min(reads, pages.length - 1)];
      reads += 1;
      return { adminBoardSetupChanges: { changes: page, nextCursor: null } };
    }
    if (undo.ok) return { undoBoardSetupChange: { uuid: 'board-1' } };
    throw undo.error;
  });
}

function listReads(): unknown[][] {
  return mockRequest.mock.calls.filter(([document]) => document === GET_ADMIN_BOARD_SETUP_CHANGES);
}

async function confirmUndo() {
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo' }));
}

beforeEach(() => {
  mockRequest.mockReset();
  mockShowMessage.mockReset();
  mockReplace.mockReset();
  mockRefreshAccessToken.mockClear();
  mockAuth.current = { token: 'admin-token', isLoading: false };
  mockSearch.current = '';
});

describe('BoardSetupChangesPanel', () => {
  it('lists each change with its links, before and after, the climber, when, and its state', async () => {
    mockRequest.mockResolvedValue({
      adminBoardSetupChanges: {
        changes: [
          change(),
          change({ eventId: 'event-0', state: 'UNDONE', climberDisplayName: null, gym: null }),
          change({ eventId: 'event-00', state: 'CHANGED_SINCE' }),
        ],
        nextCursor: null,
      },
    });
    render(<BoardSetupChangesPanel />);

    const row = within(await screen.findByTestId('setup-change-event-1'));
    expect(row.getByRole('link', { name: 'Crux Kilter' }).getAttribute('href')).toContain('/b/crux-kilter');
    expect(row.getByRole('link', { name: 'Crux' }).getAttribute('href')).toContain('/gym/crux');
    expect(row.getByText(boardSetupSummary('kilter', before))).toBeTruthy();
    expect(row.getByText(boardSetupSummary('kilter', after))).toBeTruthy();
    expect(row.getByText('Changed by Ana 3 hours ago')).toBeTruthy();
    expect(row.getByText('Live')).toBeTruthy();
    expect(row.getByRole('button', { name: 'Undo' })).toBeTruthy();

    const undone = within(screen.getByTestId('setup-change-event-0'));
    expect(undone.getByText('Undone')).toBeTruthy();
    expect(undone.getByText('Changed by Deleted account 3 hours ago')).toBeTruthy();
    expect(undone.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(screen.getByTestId('setup-change-event-00')).getByText('Changed since')).toBeTruthy();

    expect(mockRequest).toHaveBeenCalledWith(GET_ADMIN_BOARD_SETUP_CHANGES, { first: 50, after: undefined });
  });

  it('pages with Load more', async () => {
    mockRequest
      .mockResolvedValueOnce({ adminBoardSetupChanges: { changes: [change()], nextCursor: 'cursor-1' } })
      .mockResolvedValueOnce({
        adminBoardSetupChanges: { changes: [change({ eventId: 'event-2' })], nextCursor: null },
      });
    render(<BoardSetupChangesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByTestId('setup-change-event-2')).toBeTruthy();
    expect(mockRequest).toHaveBeenLastCalledWith(GET_ADMIN_BOARD_SETUP_CHANGES, { first: 50, after: 'cursor-1' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('asks first, then undoes the change and reads the first page again', async () => {
    serve([[change()], [change({ state: 'UNDONE' })]], { ok: true });
    render(<BoardSetupChangesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Undo the change to Crux Kilter?')).toBeTruthy();
    expect(
      dialog.getByText(
        `It goes back to ${boardSetupSummary('kilter', before)} for everyone. Climbers' suggestions for this board get checked first for the next 90 days.`,
      ),
    ).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalledWith(UNDO_BOARD_SETUP_CHANGE, expect.anything());
    fireEvent.click(dialog.getByRole('button', { name: 'Undo' }));

    const row = within(screen.getByTestId('setup-change-event-1'));
    await waitFor(() => expect(row.getByText('Undone')).toBeTruthy());
    expect(mockRequest).toHaveBeenCalledWith(UNDO_BOARD_SETUP_CHANGE, { eventId: 'event-1' });
    expect(row.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(mockShowMessage).toHaveBeenCalledWith('Setup put back.', 'success');
    expect(listReads()).toHaveLength(2);
    expect(listReads()[1][1]).toEqual({ first: 50, after: undefined });
  });

  it('says someone already put it back, and shows the row as the server has it', async () => {
    serve([[change()], [change({ state: 'UNDONE' })]], { ok: false, error: refusal('BOARD_SETUP_ALREADY_UNDONE') });
    render(<BoardSetupChangesPanel />);
    await confirmUndo();

    await waitFor(() => expect(within(screen.getByTestId('setup-change-event-1')).getByText('Undone')).toBeTruthy());
    expect(mockShowMessage).toHaveBeenCalledWith('Someone already put the old setup back.', 'info');
    expect(listReads()).toHaveLength(2);
  });

  it('says Changed since when the board changed again, and reads the list again', async () => {
    serve([[change()], [change({ state: 'CHANGED_SINCE' })]], {
      ok: false,
      error: refusal('BOARD_SETUP_CHANGED_SINCE'),
    });
    render(<BoardSetupChangesPanel />);
    await confirmUndo();

    const row = within(screen.getByTestId('setup-change-event-1'));
    await waitFor(() => expect(row.getByText('Changed since')).toBeTruthy());
    expect(row.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(mockShowMessage).toHaveBeenCalledWith(
      "Changed since: the board has another setup now, so this can't be undone.",
      'warning',
    );
    expect(listReads()).toHaveLength(2);
  });

  it('says the undo failed for any other reason, and still reads the list again', async () => {
    serve([[change()]], { ok: false, error: new Error('network down') });
    render(<BoardSetupChangesPanel />);
    await confirmUndo();
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith("That didn't go through. Try again.", 'error'));
    await waitFor(() => expect(listReads()).toHaveLength(2));
    expect(within(screen.getByTestId('setup-change-event-1')).getByText('Live')).toBeTruthy();
  });

  it('reads the first page again after an undo, even with more pages loaded', async () => {
    let reads = 0;
    mockRequest.mockImplementation(async (document: string, variables: { after?: string }) => {
      if (document !== GET_ADMIN_BOARD_SETUP_CHANGES) return { undoBoardSetupChange: { uuid: 'board-1' } };
      reads += 1;
      if (variables.after === 'cursor-1') {
        return {
          adminBoardSetupChanges: { changes: [change({ eventId: 'event-2', state: 'UNDONE' })], nextCursor: null },
        };
      }
      const first = reads === 1 ? change() : change({ state: 'UNDONE' });
      return { adminBoardSetupChanges: { changes: [first], nextCursor: 'cursor-1' } };
    });
    render(<BoardSetupChangesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByTestId('setup-change-event-2')).toBeTruthy();
    await confirmUndo();

    await waitFor(() => expect(within(screen.getByTestId('setup-change-event-1')).getByText('Undone')).toBeTruthy());
    // The list is page one again, its Load more back for the rest.
    expect(screen.queryByTestId('setup-change-event-2')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());
  });

  it('says the list could not load when there is no token, instead of spinning, and Retry asks for one', () => {
    mockAuth.current = { token: null, isLoading: false };
    render(<BoardSetupChangesPanel />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText("Couldn't load setup changes. Try again.")).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('spins while the token is still loading', () => {
    mockAuth.current = { token: null, isLoading: true };
    render(<BoardSetupChangesPanel />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.queryByText("Couldn't load setup changes. Try again.")).toBeNull();
  });

  it('says an undo did not go through when the token went away, and sends nothing', async () => {
    serve([[change()]], { ok: true });
    const { rerender } = render(<BoardSetupChangesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    mockAuth.current = { token: null, isLoading: false };
    rerender(<BoardSetupChangesPanel />);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith("That didn't go through. Try again.", 'error'));
    expect(mockRequest).not.toHaveBeenCalledWith(UNDO_BOARD_SETUP_CHANGE, expect.anything());
    expect(mockRefreshAccessToken).toHaveBeenCalled();
    // The row keeps its Undo for a try once a token is back.
    await waitFor(() =>
      expect(within(screen.getByTestId('setup-change-event-1')).getByRole('button', { name: 'Undo' })).toBeTruthy(),
    );
  });
});

describe('BoardReportsPanel tabs', () => {
  it('opens on the reports, and switches to the setup changes', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document === GET_ADMIN_DIRECTORY_REPORTS) {
        return { adminDirectoryReports: { reports: [], nextCursor: null } };
      }
      return { adminBoardSetupChanges: { changes: [change()], nextCursor: null } };
    });
    render(<BoardReportsPanel highlightReportUuid={null} />);
    expect(await screen.findByText('Nothing here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Setup changes by climbers' }));
    expect(await screen.findByTestId('setup-change-event-1')).toBeTruthy();
  });

  it('opens on the setup changes from ?tab=setup-changes', async () => {
    mockRequest.mockResolvedValue({ adminBoardSetupChanges: { changes: [], nextCursor: null } });
    render(<BoardReportsPanel highlightReportUuid={null} initialTab="setup-changes" />);
    expect(await screen.findByText('No climber has changed a board yet.')).toBeTruthy();
  });

  it('writes the tab back to the URL with a replace, keeping the other parameters', async () => {
    mockSearch.current = 'report=0c7a7b1e-1f2b-4c3d-9e8f-001122334455';
    mockRequest.mockImplementation(async (document: string) => {
      if (document === GET_ADMIN_DIRECTORY_REPORTS) {
        return { adminDirectoryReports: { reports: [], nextCursor: null } };
      }
      return { adminBoardSetupChanges: { changes: [], nextCursor: null } };
    });
    render(<BoardReportsPanel highlightReportUuid={null} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Setup changes by climbers' }));
    expect(mockReplace).toHaveBeenLastCalledWith(
      '/admin/board-reports?report=0c7a7b1e-1f2b-4c3d-9e8f-001122334455&tab=setup-changes',
      { scroll: false },
    );

    mockSearch.current = 'report=0c7a7b1e-1f2b-4c3d-9e8f-001122334455&tab=setup-changes';
    fireEvent.click(screen.getByRole('tab', { name: 'Reports' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/board-reports?report=0c7a7b1e-1f2b-4c3d-9e8f-001122334455', {
      scroll: false,
    });
    expect(mockReplace).toHaveBeenCalledTimes(2);
  });
});
