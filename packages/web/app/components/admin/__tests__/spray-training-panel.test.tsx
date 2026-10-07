import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SprayTrainingQueueItemData } from '@boardsesh/graphql/operations';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SprayTrainingPanel from '../spray-training-panel';

const mockRequest = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'admin-token' }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  GET_SPRAY_TRAINING_QUEUE: 'GET_SPRAY_TRAINING_QUEUE',
  SET_SPRAY_TRAINING_REVIEW: 'SET_SPRAY_TRAINING_REVIEW',
}));

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

function makeItem(versionId: string, versionNumber: number): SprayTrainingQueueItemData {
  return {
    versionId,
    wallUuid: `wall-${versionId}`,
    versionNumber,
    visibility: 'PRIVATE',
    createdAt: '2026-10-01T00:00:00.000Z',
    publishedAt: null,
    photo: {
      url: `https://photos.example/${versionId}.jpg`,
      thumbUrl: `https://photos.example/${versionId}-thumb.jpg`,
      width: 800,
      height: 600,
      expiresAt: FAR_FUTURE,
    } as SprayTrainingQueueItemData['photo'],
    photoWidth: 800,
    photoHeight: 600,
    holds: [
      { id: 1, cx: 100, cy: 100, r: 10, outline: null, source: 'MANUAL', autoReview: null, confidence: null },
      {
        id: 2,
        cx: 200,
        cy: 200,
        r: 10,
        outline: [1, 0, 0, 1, -1, 0],
        source: 'AUTO',
        autoReview: 'ACCEPTED',
        confidence: 0.9,
      },
    ],
    unmappableHoldCount: 0,
    candidates: [
      { index: 0, cx: 300, cy: 300, r: 10, confidence: 0.4, outline: null, fate: 'DELETED' },
      { index: 1, cx: 400, cy: 400, r: 10, confidence: 0.3, outline: null, fate: 'NOT_SHOWN' },
    ],
    detectionModelVersion: 'v1',
    stats: {
      holdCount: 4,
      manualHoldCount: 1,
      autoHoldCount: 3,
      acceptedHoldCount: 2,
      confirmedHoldCount: 0,
      editedHoldCount: 1,
      candidateCount: 2,
      keptCandidateCount: 0,
      editedCandidateCount: 0,
      deletedCandidateCount: 1,
      notShownCandidateCount: 1,
    },
    review: { status: 'UNREVIEWED', reason: null, notes: null, reviewedAt: null },
  };
}

function queueResponse(items: SprayTrainingQueueItemData[], hasMore = false) {
  return {
    sprayTrainingQueue: { hasMore, totals: { unreviewed: items.length, approved: 0, rejected: 0 }, items },
  };
}

beforeEach(() => {
  mockRequest.mockReset();
});

describe('SprayTrainingPanel', () => {
  it('shows a card per wall with the four chips and the tab totals', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 3)]));

    render(<SprayTrainingPanel />);

    const card = await screen.findByRole('button', { name: 'Review wall version 3' });
    expect(card).toBeTruthy();
    expect(screen.getByText('Holds: 4')).toBeTruthy();
    expect(screen.getByText('Edited: 25%')).toBeTruthy();
    expect(screen.getByText('Accepted unchecked: 50%')).toBeTruthy();
    expect(screen.getByText('Deleted suggestions: 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unreviewed (1)' })).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledWith('GET_SPRAY_TRAINING_QUEUE', {
      status: 'UNREVIEWED',
      limit: 25,
      offset: 0,
    });
  });

  it('asks for the next page at the loaded offset', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)], true));
    render(<SprayTrainingPanel />);
    const more = await screen.findByRole('button', { name: 'Load more' });

    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v2', 2)]));
    fireEvent.click(more);

    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', {
        status: 'UNREVIEWED',
        limit: 25,
        offset: 1,
      }),
    );
    expect(await screen.findByRole('button', { name: 'Review wall version 2' })).toBeTruthy();
  });

  it('retries the failed page', async () => {
    mockRequest.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SprayTrainingPanel />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    fireEvent.click(retry);

    expect(await screen.findByRole('button', { name: 'Review wall version 1' })).toBeTruthy();
  });

  it('opens the review dialog with an overlay that hides never-shown suggestions', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));

    const overlay = await screen.findByTestId('spray-hold-overlay');
    expect(overlay.getAttribute('viewBox')).toBe('0 0 800 600');
    const kinds = Array.from(overlay.querySelectorAll('[data-kind]')).map((node) => node.getAttribute('data-kind'));
    expect(kinds).toEqual(['manual', 'accepted', 'deleted']);
    // The ring hold is a polygon scaled by its radius; the plain one is a circle.
    expect(overlay.querySelector('polygon')?.getAttribute('points')).toBe('210,200 200,210 190,200');
    expect(overlay.querySelectorAll('circle').length).toBe(2);
  });

  it('approves with A, advances to the next wall and moves the totals', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));
    await screen.findByTestId('spray-hold-overlay');

    mockRequest.mockResolvedValueOnce({
      setSprayTrainingReview: {
        versionId: 'v1',
        review: { status: 'APPROVED', reason: null, notes: null, reviewedAt: null },
      },
    });
    fireEvent.keyDown(window, { key: 'a' });

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('SET_SPRAY_TRAINING_REVIEW', {
        input: { versionId: 'v1', status: 'APPROVED', reason: null, notes: null },
      }),
    );
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('Wall version 2')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Unreviewed (1)', hidden: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved (1)', hidden: true })).toBeTruthy();
  });

  it('rejects with the chosen reason and notes', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));
    const dialog = await screen.findByRole('dialog');

    const rejectButton = within(dialog).getByRole('button', { name: 'Reject (R)' }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(true);

    fireEvent.mouseDown(within(dialog).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Photo quality' }));
    fireEvent.change(within(dialog).getByLabelText('Notes (optional)'), { target: { value: ' too dark ' } });

    mockRequest.mockResolvedValueOnce({
      setSprayTrainingReview: {
        versionId: 'v1',
        review: { status: 'REJECTED', reason: 'PHOTO_QUALITY', notes: 'too dark', reviewedAt: null },
      },
    });
    fireEvent.click(rejectButton);

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('SET_SPRAY_TRAINING_REVIEW', {
        input: { versionId: 'v1', status: 'REJECTED', reason: 'PHOTO_QUALITY', notes: 'too dark' },
      }),
    );
  });

  it('H hides every mark', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));
    const overlay = await screen.findByTestId('spray-hold-overlay');

    fireEvent.keyDown(window, { key: 'h' });

    await waitFor(() => expect(overlay.querySelectorAll('[data-kind]').length).toBe(0));
  });
});

describe('SprayTrainingPanel photo expiry', () => {
  it('re-reads the loaded page once the photo link has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const expiring = makeItem('v1', 1);
      expiring.photo = { ...expiring.photo!, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      mockRequest.mockResolvedValueOnce(queueResponse([expiring]));
      render(<SprayTrainingPanel />);
      await screen.findByRole('button', { name: 'Review wall version 1' });

      mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
      await vi.advanceTimersByTimeAsync(61_000);

      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
      expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', {
        status: 'UNREVIEWED',
        limit: 25,
        offset: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SprayTrainingPanel races and shortcuts', () => {
  it('does not bring back a wall decided while a refresh was in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const expiring = [makeItem('v1', 1), makeItem('v2', 2)];
      for (const entry of expiring) {
        entry.photo = { ...entry.photo!, expiresAt: new Date(Date.now() + 90_000).toISOString() };
      }
      mockRequest.mockResolvedValueOnce(queueResponse(expiring));
      render(<SprayTrainingPanel />);
      fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));
      await screen.findByTestId('spray-hold-overlay');

      // The refresh starts about 30 s in (60 s before expiry) and is held open.
      let releaseRefresh: (value: unknown) => void = () => undefined;
      mockRequest.mockImplementationOnce(() => new Promise((resolve) => (releaseRefresh = resolve)));
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));

      mockRequest.mockResolvedValueOnce({
        setSprayTrainingReview: {
          versionId: 'v1',
          review: { status: 'APPROVED', reason: null, notes: null, reviewedAt: null },
        },
      });
      fireEvent.keyDown(window, { key: 'a' });
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));

      // The stale read still lists v1.
      releaseRefresh(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Review wall version 1', hidden: true })).toBeNull(),
      );
      expect(screen.getByRole('button', { name: 'Review wall version 2', hidden: true })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a re-decided wall on its tab and updates it in place', async () => {
    const rejected = makeItem('v1', 1);
    rejected.review = { status: 'REJECTED', reason: 'BAD_HOLDS', notes: null, reviewedAt: null };
    mockRequest.mockResolvedValueOnce({
      sprayTrainingQueue: { hasMore: false, totals: { unreviewed: 0, approved: 0, rejected: 1 }, items: [] },
    });
    render(<SprayTrainingPanel />);
    await screen.findByText('Nothing here');
    mockRequest.mockResolvedValueOnce({
      sprayTrainingQueue: { hasMore: false, totals: { unreviewed: 0, approved: 0, rejected: 1 }, items: [rejected] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rejected (1)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));
    const dialog = await screen.findByRole('dialog');

    mockRequest.mockResolvedValueOnce({
      setSprayTrainingReview: {
        versionId: 'v1',
        review: { status: 'REJECTED', reason: 'BAD_HOLDS', notes: 'again', reviewedAt: null },
      },
    });
    fireEvent.change(within(dialog).getByLabelText('Notes (optional)'), { target: { value: 'again' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject (R)' }));

    await waitFor(() => expect(mockRequest).toHaveBeenLastCalledWith('SET_SPRAY_TRAINING_REVIEW', expect.anything()));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('Wall version 1')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Rejected (1)', hidden: true })).toBeTruthy();
  });

  it('ignores shortcuts typed in the notes field and while the reason menu is open', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.keyDown(within(dialog).getByLabelText('Notes (optional)'), { key: 'a' });
    expect(mockRequest).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(within(dialog).getByRole('combobox'));
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'a' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('still takes shortcuts after a legend switch has focus', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review wall version 1' }));
    const overlay = await screen.findByTestId('spray-hold-overlay');
    const dialog = screen.getByRole('dialog');

    const legendSwitch = within(dialog).getAllByRole('switch')[0];
    fireEvent.keyDown(legendSwitch, { key: 'h' });

    await waitFor(() => expect(overlay.querySelectorAll('[data-kind]').length).toBe(0));
  });
});
