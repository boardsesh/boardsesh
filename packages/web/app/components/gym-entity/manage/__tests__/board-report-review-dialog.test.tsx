import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  boardSetupSummary,
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
} from '@boardsesh/board-config';
import type { BoardSetup, DirectoryReport, UserBoard } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'staff-token' }),
}));

const mockShowMessage = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockTrack = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track: mockTrack }));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

import BoardReportReviewDialog from '../board-report-review-dialog';
import { RESOLVE_DIRECTORY_REPORT, UPDATE_BOARD } from '@boardsesh/graphql/operations';

// Real catalogue rows, so the summary the dialog prints is the shared one.
const kilterLayout = getBoardLayouts('kilter').find(
  (layout) => getBoardSizesForLayoutId('kilter', layout.id).length >= 2,
);
if (!kilterLayout) throw new Error('Expected a Kilter layout with two sizes');
const [kilterSize, otherKilterSize] = getBoardSizesForLayoutId('kilter', kilterLayout.id);
const setIdsOf = (sizeId: number) =>
  getBoardSetsForLayoutAndSize('kilter', kilterLayout.id, sizeId)
    .map((set) => set.id)
    .sort((first, second) => first - second)
    .join(',');

const board = {
  uuid: 'board-1',
  slug: 'crux-kilter',
  name: 'Crux Kilter',
  boardType: 'kilter',
  layoutId: kilterLayout.id,
  sizeId: kilterSize.id,
  setIds: setIdsOf(kilterSize.id),
  angle: 40,
  isAngleAdjustable: true,
  locationName: 'Crux',
  canEdit: true,
  canRemoveFromGym: true,
  canDelete: false,
} as UserBoard;

const suggested: BoardSetup = {
  layoutId: kilterLayout.id,
  sizeId: otherKilterSize.id,
  setIds: setIdsOf(otherKilterSize.id),
  angle: null,
};
// The same setup, sets in another order: one group, not two.
const suggestedReordered: BoardSetup = { ...suggested, setIds: suggested.setIds.split(',').reverse().join(',') };

function report(overrides: Partial<DirectoryReport> = {}): DirectoryReport {
  return {
    uuid: 'report-1',
    targetKind: 'board',
    reason: 'wrong_setup',
    status: 'open',
    routedTo: ['creator', 'gym_staff'],
    boardUuid: 'board-1',
    boardName: 'Crux Kilter',
    reporterCount: 3,
    notes: [
      { note: '', createdAt: '2026-11-20T10:00:00.000Z', suggestedSetup: suggested },
      { note: 'It is the big one', createdAt: '2026-11-21T10:00:00.000Z', suggestedSetup: suggestedReordered },
      { note: 'Holds are off', createdAt: '2026-11-22T10:00:00.000Z', suggestedSetup: null },
    ],
    createdAt: '2026-11-20T10:00:00.000Z',
    escalatesAt: '2026-12-04T10:00:00.000Z',
    viewerRole: 'gym_staff',
    viewerIsReporter: false,
    viewerCanResolve: true,
    ...overrides,
  };
}

function duplicateError(): Error {
  return Object.assign(new Error('You already have this board here'), {
    response: {
      errors: [
        {
          message: 'You already have this board here',
          extensions: {
            code: 'BOARD_DUPLICATE_CONFIG',
            existingBoardUuid: 'board-9',
            existingBoardName: 'Back Kilter',
          },
        },
      ],
    },
  });
}

function renderDialog(overrides: { board?: UserBoard } = {}) {
  const onClose = vi.fn();
  const onResolved = vi.fn();
  const onFix = vi.fn();
  const onRemove = vi.fn();
  render(
    <BoardReportReviewDialog
      board={overrides.board ?? board}
      gymName="Crux"
      onClose={onClose}
      onFix={onFix}
      onRemove={onRemove}
      onDelete={vi.fn()}
      allowDelete={false}
      onResolved={onResolved}
    />,
  );
  return { onClose, onResolved, onFix, onRemove };
}

beforeEach(() => {
  mockRequest.mockReset();
  mockShowMessage.mockReset();
  mockTrack.mockReset();
});

describe('BoardReportReviewDialog, suggested setups', () => {
  it('groups equal suggestions and never lists an empty note', async () => {
    mockRequest.mockResolvedValue({ boardReports: [report()] });
    renderDialog();
    const line = `2 climbers suggested ${boardSetupSummary('kilter', suggested)}`;
    expect(await screen.findByText(line)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Use this setup' })).toHaveLength(1);
    // Two notes with words; the suggestion-only reporter adds no empty bullet.
    expect(screen.getByText('It is the big one')).toBeTruthy();
    expect(screen.getAllByRole('listitem').filter((item) => item.textContent === '')).toHaveLength(0);
    // With a suggestion to use, editing by hand reads as the other way.
    expect(screen.getByText('Edit it yourself')).toBeTruthy();
  });

  it('Use this setup sends the suggested layout, size and sets, then closes', async () => {
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('boardReports')) return { boardReports: [report()] };
      return { updateBoard: { ...board, sizeId: otherKilterSize.id } };
    });
    const { onClose, onResolved } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Use this setup' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockRequest).toHaveBeenCalledWith(UPDATE_BOARD, {
      input: { boardUuid: 'board-1', layoutId: kilterLayout.id, sizeId: otherKilterSize.id, setIds: suggested.setIds },
    });
    expect(onResolved).toHaveBeenCalled();
    expect(mockShowMessage).toHaveBeenCalledWith("Saved. We'll tell the climbers who flagged it.", 'success');
  });

  it('sends the angle of a board that does not tilt', async () => {
    const withAngle: BoardSetup = { ...suggested, angle: 45 };
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('boardReports')) {
        return {
          boardReports: [
            report({ notes: [{ note: '', createdAt: '2026-11-20T10:00:00.000Z', suggestedSetup: withAngle }] }),
          ],
        };
      }
      return { updateBoard: board };
    });
    renderDialog({ board: { ...board, isAngleAdjustable: false } as UserBoard });
    fireEvent.click(await screen.findByRole('button', { name: 'Use this setup' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(UPDATE_BOARD, {
        input: {
          boardUuid: 'board-1',
          layoutId: kilterLayout.id,
          sizeId: otherKilterSize.id,
          setIds: suggested.setIds,
          angle: 45,
        },
      }),
    );
  });

  it('asks before copying another board, and Save anyway allows the duplicate', async () => {
    let updates = 0;
    mockRequest.mockImplementation(async (document: string) => {
      if (document.includes('boardReports')) return { boardReports: [report()] };
      updates += 1;
      if (updates === 1) throw duplicateError();
      return { updateBoard: board };
    });
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Use this setup' }));

    expect(await screen.findByText('You already have this setup')).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith(
      'Board Duplicate Prompted',
      expect.objectContaining({ boardType: 'kilter', source: 'web_report_review' }),
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const lastUpdate = mockRequest.mock.calls.filter(([document]) => document === UPDATE_BOARD).at(-1);
    expect(lastUpdate?.[1]).toEqual({
      input: {
        boardUuid: 'board-1',
        layoutId: kilterLayout.id,
        sizeId: otherKilterSize.id,
        setIds: suggested.setIds,
        allowDuplicateConfig: true,
      },
    });
  });

  it('offers no Use this setup to a viewer who can not edit the board', async () => {
    mockRequest.mockResolvedValue({ boardReports: [report()] });
    renderDialog({ board: { ...board, canEdit: false } as UserBoard });
    expect(await screen.findByText(`2 climbers suggested ${boardSetupSummary('kilter', suggested)}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this setup' })).toBeNull();
  });

  it('offers no Use this setup for the setup the board has now', async () => {
    mockRequest.mockResolvedValue({
      boardReports: [
        report({
          notes: [
            {
              note: '',
              createdAt: '2026-11-20T10:00:00.000Z',
              suggestedSetup: { layoutId: board.layoutId, sizeId: board.sizeId, setIds: board.setIds, angle: null },
            },
          ],
        }),
      ],
    });
    renderDialog();
    expect(await screen.findByText('The board has this setup now')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this setup' })).toBeNull();
    // No Use this setup to offer, so editing by hand is the fix, not the other way.
    expect(screen.queryByText('Edit it yourself')).toBeNull();
    expect(screen.getByText('Fix the setup')).toBeTruthy();
  });
});

describe('BoardReportReviewDialog, while a setup is being applied', () => {
  type Settle = { resolve: (response: unknown) => void; reject: (error: Error) => void };

  /** The reports load; UPDATE_BOARD waits until the test settles it. */
  function holdTheSetupSave(): () => Settle {
    let settle: Settle | null = null;
    mockRequest.mockImplementation((document: string) => {
      if (document.includes('boardReports')) return Promise.resolve({ boardReports: [report()] });
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    });
    return () => {
      if (!settle) throw new Error('No setup save in flight');
      return settle;
    };
  }

  const reviewAction = (label: string) => {
    const button = screen.getByText(label).closest('button');
    if (!button) throw new Error(`No button for ${label}`);
    return button;
  };
  const resolveRequests = () => mockRequest.mock.calls.filter(([document]) => document === RESOLVE_DIRECTORY_REPORT);

  it('disables keep, edit and remove, and refuses a click that lands before they re-render', async () => {
    const settleSave = holdTheSetupSave();
    const { onFix, onRemove } = renderDialog();
    const useSetup = await screen.findByRole('button', { name: 'Use this setup' });

    // Every click lands in one batch, before React re-renders the buttons
    // disabled: the handlers have to refuse on their own.
    act(() => {
      useSetup.click();
      reviewAction("It's right as it is").click();
      reviewAction('Edit it yourself').click();
      reviewAction('Remove from Crux').click();
    });

    expect(reviewAction("It's right as it is")).toHaveProperty('disabled', true);
    expect(reviewAction('Edit it yourself')).toHaveProperty('disabled', true);
    expect(reviewAction('Remove from Crux')).toHaveProperty('disabled', true);
    expect(screen.queryByLabelText('Tell them why (optional)')).toBeNull();
    expect(onFix).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    // The save failed: the other answers are back.
    await act(async () => settleSave().reject(new Error('offline')));
    expect(reviewAction("It's right as it is")).toHaveProperty('disabled', false);
    fireEvent.click(reviewAction("It's right as it is"));
    expect(screen.getByLabelText('Tell them why (optional)')).toBeTruthy();
  });

  it('sends no keep while the setup saves, even when keep opened in the same instant', async () => {
    const settleSave = holdTheSetupSave();
    const { onClose } = renderDialog();
    const useSetup = await screen.findByRole('button', { name: 'Use this setup' });

    act(() => {
      reviewAction("It's right as it is").click();
      useSetup.click();
    });

    // The keep step opened, but Send waits for the setup save.
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.click(send);
    expect(resolveRequests()).toHaveLength(0);

    await act(async () => settleSave().resolve({ updateBoard: { ...board, sizeId: otherKilterSize.id } }));
    expect(onClose).toHaveBeenCalled();
    // One decision reached the server: the new setup, never a keep.
    expect(resolveRequests()).toHaveLength(0);
  });
});
