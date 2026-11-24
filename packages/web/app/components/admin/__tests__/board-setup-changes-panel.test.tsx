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

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'admin-token' }),
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

function changedSinceError(): Error {
  return Object.assign(new Error('This board has changed since.'), {
    response: {
      errors: [{ message: 'This board has changed since.', extensions: { code: 'BOARD_SETUP_CHANGED_SINCE' } }],
    },
  });
}

beforeEach(() => {
  mockRequest.mockReset();
  mockShowMessage.mockReset();
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

  it('asks first, then undoes the change and marks the row Undone', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document === GET_ADMIN_BOARD_SETUP_CHANGES) {
        return { adminBoardSetupChanges: { changes: [change()], nextCursor: null } };
      }
      return { undoBoardSetupChange: { uuid: 'board-1' } };
    });
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
  });

  it('says Changed since when the board changed again, and updates the row', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document === GET_ADMIN_BOARD_SETUP_CHANGES) {
        return { adminBoardSetupChanges: { changes: [change()], nextCursor: null } };
      }
      throw changedSinceError();
    });
    render(<BoardSetupChangesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo' }));

    const row = within(screen.getByTestId('setup-change-event-1'));
    await waitFor(() => expect(row.getByText('Changed since')).toBeTruthy());
    expect(row.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(mockShowMessage).toHaveBeenCalledWith(
      "Changed since: the board has another setup now, so this can't be undone.",
      'warning',
    );
  });

  it('leaves the row as it was when the undo fails for another reason', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document === GET_ADMIN_BOARD_SETUP_CHANGES) {
        return { adminBoardSetupChanges: { changes: [change()], nextCursor: null } };
      }
      throw new Error('network down');
    });
    render(<BoardSetupChangesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith("That didn't go through. Try again.", 'error'));
    expect(within(screen.getByTestId('setup-change-event-1')).getByText('Live')).toBeTruthy();
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
});
