import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SprayTrainingQueueItemData, SprayTrainingReviewStatus } from '@boardsesh/graphql/operations';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SprayTrainingPanel from '../spray-training-panel';
import { isShortcutBlockedTarget } from '../spray-training-review-dialog';

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
  GET_SPRAY_TRAINING_TOTALS: 'GET_SPRAY_TRAINING_TOTALS',
  SET_SPRAY_TRAINING_REVIEW: 'SET_SPRAY_TRAINING_REVIEW',
}));

const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
const PHOTO_ALT = 'Spray wall photo with marked holds';
const NO_PHOTO = 'This photo is no longer available.';
const FIRST_PAGE = { status: 'UNREVIEWED', limit: 25, offset: 0 };

function makeItem(versionId: string, versionNumber: number): SprayTrainingQueueItemData {
  return {
    versionId,
    versionNumber,
    visibility: 'PRIVATE',
    photo: {
      url: `https://photos.example/${versionId}.jpg`,
      thumbUrl: `https://photos.example/${versionId}-thumb.jpg`,
      expiresAt: FAR_FUTURE,
    },
    photoWidth: 800,
    photoHeight: 600,
    holds: [
      { id: 1, cx: 100, cy: 100, r: 10, outline: null, source: 'MANUAL', autoReview: null },
      { id: 2, cx: 200, cy: 200, r: 10, outline: [1, 0, 0, 1, -1, 0], source: 'AUTO', autoReview: 'ACCEPTED' },
    ],
    unmappableHoldCount: 0,
    candidates: [
      { index: 0, cx: 300, cy: 300, r: 10, outline: null, fate: 'DELETED' },
      { index: 1, cx: 400, cy: 400, r: 10, outline: null, fate: 'NOT_SHOWN' },
    ],
    detectionModelVersion: 'v1',
    stats: { holdCount: 4, acceptedHoldCount: 2, editedHoldCount: 1, deletedCandidateCount: 1 },
    review: { status: 'UNREVIEWED', reason: null, notes: null },
  };
}

function queueResponse(
  items: SprayTrainingQueueItemData[],
  { hasMore = false, unreviewed = items.length }: { hasMore?: boolean; unreviewed?: number } = {},
) {
  return { sprayTrainingQueue: { hasMore, totals: { unreviewed, approved: 0, rejected: 0 }, items } };
}

function reviewResponse(versionId: string, status: SprayTrainingReviewStatus) {
  return { setSprayTrainingReview: { versionId, review: { status, reason: null, notes: null } } };
}

/** What graphql-request throws when the backend answers with an `extensions.code`. */
function graphqlFailure(code: string) {
  return Object.assign(new Error(code), { response: { errors: [{ message: code, extensions: { code } }] } });
}

function reviewCalls() {
  return mockRequest.mock.calls.filter(([operation]) => operation === 'SET_SPRAY_TRAINING_REVIEW');
}

function approveButton(dialog: HTMLElement) {
  return within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Approve (A)' });
}

function rejectButton(dialog: HTMLElement) {
  return within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Reject (R)' });
}

/** The browser finishing the download of the wall photo now in the dialog. */
function finishPhotoLoad(dialog: HTMLElement) {
  fireEvent.load(within(dialog).getByAltText(PHOTO_ALT));
}

/** Opens a wall without its photo: jsdom never loads an image by itself. */
async function openWallUnloaded(versionNumber: number) {
  fireEvent.click(await screen.findByRole('button', { name: `Review wall version ${versionNumber}` }));
  return screen.findByRole('dialog');
}

/** Opens a wall the way a reviewer meets it once the photo is on screen. */
async function openWall(versionNumber: number) {
  const dialog = await openWallUnloaded(versionNumber);
  finishPhotoLoad(dialog);
  return dialog;
}

/** Picks a reject reason with the mouse and waits for the menu to shut. */
async function pickReasonWithMouse(dialog: HTMLElement, reasonLabel: string) {
  const reasonPicker = within(dialog).getByRole('combobox');
  fireEvent.mouseDown(reasonPicker);
  fireEvent.click(await screen.findByRole('option', { name: reasonLabel }));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  return reasonPicker;
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
    expect(mockRequest).toHaveBeenCalledWith('GET_SPRAY_TRAINING_QUEUE', FIRST_PAGE);
  });

  it('asks for the next page at the loaded offset', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)], { hasMore: true }));
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

    await openWall(1);

    const overlay = await screen.findByTestId('spray-hold-overlay');
    expect(overlay.getAttribute('viewBox')).toBe('0 0 800 600');
    const kinds = Array.from(overlay.querySelectorAll('[data-kind]')).map((node) => node.getAttribute('data-kind'));
    expect(kinds).toEqual(['manual', 'accepted', 'deleted']);
    // The ring hold is a polygon scaled by its radius; the plain one is a circle.
    expect(overlay.querySelector('polygon')?.getAttribute('points')).toBe('210,200 200,210 190,200');
    expect(overlay.querySelectorAll('circle').length).toBe(2);
  });

  it('tells the reviewer who can see the wall', async () => {
    const linkOnly = makeItem('v2', 2);
    linkOnly.visibility = 'UNLISTED';
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), linkOnly]));
    render(<SprayTrainingPanel />);

    const dialog = await openWall(1);
    expect(within(dialog).getByText('Visibility: private')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(within(dialog).getByText('Visibility: link only')).toBeTruthy());
  });

  it('approves with A, advances to the next wall and moves the totals', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    await openWall(1);

    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
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

  it('sends the trimmed notes with an approval', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);

    fireEvent.change(within(dialog).getByLabelText('Notes (optional)'), { target: { value: '  clean labels \n' } });
    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    fireEvent.click(approveButton(dialog));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('SET_SPRAY_TRAINING_REVIEW', {
        input: { versionId: 'v1', status: 'APPROVED', reason: null, notes: 'clean labels' },
      }),
    );
  });

  it('rejects with the chosen reason and notes', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);

    expect(rejectButton(dialog).disabled).toBe(true);

    await pickReasonWithMouse(dialog, 'Photo quality');
    fireEvent.change(within(dialog).getByLabelText('Notes (optional)'), { target: { value: ' too dark ' } });

    mockRequest.mockResolvedValueOnce({
      setSprayTrainingReview: {
        versionId: 'v1',
        review: { status: 'REJECTED', reason: 'PHOTO_QUALITY', notes: 'too dark' },
      },
    });
    fireEvent.click(rejectButton(dialog));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('SET_SPRAY_TRAINING_REVIEW', {
        input: { versionId: 'v1', status: 'REJECTED', reason: 'PHOTO_QUALITY', notes: 'too dark' },
      }),
    );
  });

  it('H hides every mark', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    await openWall(1);
    const overlay = await screen.findByTestId('spray-hold-overlay');

    fireEvent.keyDown(window, { key: 'h' });

    await waitFor(() => expect(overlay.querySelectorAll('[data-kind]').length).toBe(0));
  });
});

describe('SprayTrainingPanel photo on screen', () => {
  it('holds Approve, Reject and their shortcuts until the photo has loaded, on every wall', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWallUnloaded(1);

    expect(within(dialog).getByRole('progressbar', { name: 'Loading the photo' })).toBeTruthy();
    expect(screen.queryByTestId('spray-hold-overlay')).toBeNull();
    expect(approveButton(dialog).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'a' });
    // R with no reason would open the picker: not while the photo is loading.
    fireEvent.keyDown(window, { key: 'r' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(reviewCalls()).toHaveLength(0);

    const firstPhoto = within(dialog).getByAltText(PHOTO_ALT);
    finishPhotoLoad(dialog);
    expect(approveButton(dialog).disabled).toBe(false);
    expect(within(dialog).queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('spray-hold-overlay')).toBeTruthy();

    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(within(dialog).getByText('Wall version 2')).toBeTruthy());

    // The next wall is a new image element with nothing painted yet, so the
    // first wall's photo cannot sit under the second wall's marks.
    const secondPhoto = within(dialog).getByAltText(PHOTO_ALT);
    expect(secondPhoto).not.toBe(firstPhoto);
    expect(secondPhoto.getAttribute('src')).toBe('https://photos.example/v2.jpg');
    expect(screen.queryByTestId('spray-hold-overlay')).toBeNull();
    // The save has finished, so only the unloaded photo keeps Approve off.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approved (1)', hidden: true })).toBeTruthy());
    expect(approveButton(dialog).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'a' });
    expect(reviewCalls()).toHaveLength(1);

    finishPhotoLoad(dialog);
    mockRequest.mockResolvedValueOnce(reviewResponse('v2', 'APPROVED'));
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(reviewCalls()).toHaveLength(2));
    expect(reviewCalls()[1][1]).toEqual({
      input: { versionId: 'v2', status: 'APPROVED', reason: null, notes: null },
    });
  });

  it('waits for the photo again on a wall the reviewer comes back to', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);
    const firstVisit = within(dialog).getByAltText(PHOTO_ALT);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(within(dialog).getByText('Wall version 2')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(within(dialog).getByText('Wall version 1')).toBeTruthy());

    // A fresh element for the same wall: its earlier load does not count.
    expect(within(dialog).getByAltText(PHOTO_ALT)).not.toBe(firstVisit);
    expect(approveButton(dialog).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'a' });
    expect(reviewCalls()).toHaveLength(0);

    finishPhotoLoad(dialog);
    expect(approveButton(dialog).disabled).toBe(false);
  });

  it('keeps the photo on screen while a re-signed link for the same wall loads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const expiring = makeItem('v1', 1);
      expiring.photo = { ...expiring.photo!, expiresAt: new Date(Date.now() + 90_000).toISOString() };
      mockRequest.mockResolvedValueOnce(queueResponse([expiring]));
      render(<SprayTrainingPanel />);
      const dialog = await openWall(1);
      const photo = within(dialog).getByAltText(PHOTO_ALT);

      const resigned = makeItem('v1', 1);
      resigned.photo = { ...resigned.photo!, url: 'https://photos.example/v1-resigned.jpg' };
      mockRequest.mockResolvedValueOnce(queueResponse([resigned]));
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(photo.getAttribute('src')).toBe('https://photos.example/v1-resigned.jpg'));

      // Same element, so the browser keeps painting the old bytes until the new ones arrive.
      expect(within(dialog).getByAltText(PHOTO_ALT)).toBe(photo);
      expect(approveButton(dialog).disabled).toBe(false);
      expect(screen.getByTestId('spray-hold-overlay')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Reject off while the photo is loading even with a reason chosen', async () => {
    const withReason = makeItem('v1', 1);
    withReason.review = { status: 'UNREVIEWED', reason: 'BAD_HOLDS', notes: null };
    mockRequest.mockResolvedValueOnce(queueResponse([withReason]));
    render(<SprayTrainingPanel />);
    const dialog = await openWallUnloaded(1);

    expect(rejectButton(dialog).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'r' });
    expect(reviewCalls()).toHaveLength(0);

    finishPhotoLoad(dialog);
    expect(rejectButton(dialog).disabled).toBe(false);
  });

  it('does not decide on a held key', async () => {
    const withReason = makeItem('v1', 1);
    // A saved reason, so a repeated R would reject at once if it got through.
    withReason.review = { status: 'UNREVIEWED', reason: 'BAD_HOLDS', notes: null };
    mockRequest.mockResolvedValueOnce(queueResponse([withReason, makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    await openWall(1);

    fireEvent.keyDown(window, { key: 'a', repeat: true });
    fireEvent.keyDown(window, { key: 'A', repeat: true });
    fireEvent.keyDown(window, { key: 'r', repeat: true });
    fireEvent.keyDown(window, { key: 'R', repeat: true });
    expect(reviewCalls()).toHaveLength(0);

    // The same key, pressed once, still decides.
    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(reviewCalls()).toHaveLength(1));
  });

  it.each([
    ['the photo link is missing', (wall: SprayTrainingQueueItemData) => void (wall.photo = null)],
    ['the photo has no size', (wall: SprayTrainingQueueItemData) => void (wall.photoWidth = null)],
  ])('cannot approve when %s, but can still reject', async (_label, breakPhoto) => {
    const unseen = makeItem('v1', 1);
    breakPhoto(unseen);
    mockRequest.mockResolvedValueOnce(queueResponse([unseen]));
    render(<SprayTrainingPanel />);
    const dialog = await openWallUnloaded(1);

    expect(within(dialog).getByText(NO_PHOTO)).toBeTruthy();
    expect(approveButton(dialog).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'a' });
    expect(reviewCalls()).toHaveLength(0);

    await pickReasonWithMouse(dialog, 'Photo quality');
    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'REJECTED'));
    fireEvent.click(rejectButton(dialog));

    await waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(reviewCalls()[0][1]).toEqual({
      input: { versionId: 'v1', status: 'REJECTED', reason: 'PHOTO_QUALITY', notes: null },
    });
  });

  it('treats a photo that fails to download as unavailable, and tries again on the next visit', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWallUnloaded(1);

    fireEvent.error(within(dialog).getByAltText(PHOTO_ALT));

    expect(within(dialog).getByText(NO_PHOTO)).toBeTruthy();
    expect(within(dialog).queryByRole('progressbar')).toBeNull();
    expect(approveButton(dialog).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'a' });
    expect(reviewCalls()).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(within(dialog).getByText('Wall version 2')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(within(dialog).getByText('Wall version 1')).toBeTruthy());

    expect(within(dialog).queryByText(NO_PHOTO)).toBeNull();
    finishPhotoLoad(dialog);
    expect(approveButton(dialog).disabled).toBe(false);
  });
});

describe('SprayTrainingPanel photo links', () => {
  it('re-reads the loaded page a minute before the earliest photo link expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const expiring = makeItem('v1', 1);
      expiring.photo = { ...expiring.photo!, expiresAt: new Date(Date.now() + 90_000).toISOString() };
      mockRequest.mockResolvedValueOnce(queueResponse([expiring]));
      render(<SprayTrainingPanel />);
      await screen.findByRole('button', { name: 'Review wall version 1' });

      // 90 s of life less the 60 s lead puts the re-read at 30 s: not yet at 25 s.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(mockRequest).toHaveBeenCalledTimes(1);

      const resigned = makeItem('v1', 1);
      resigned.photo = { ...resigned.photo!, thumbUrl: 'https://photos.example/v1-thumb-resigned.jpg' };
      mockRequest.mockResolvedValueOnce(queueResponse([resigned]));
      await vi.advanceTimersByTimeAsync(10_000);

      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
      expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', FIRST_PAGE);
      // The card swaps to the freshly signed link while the old one still works.
      await waitFor(() =>
        expect(document.querySelector('img[src="https://photos.example/v1-thumb-resigned.jpg"]')).not.toBeNull(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SprayTrainingPanel drained page', () => {
  it('reads the next page when every loaded wall is decided and keeps the dialog on the first new wall', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)], { hasMore: true, unreviewed: 2 }));
    render(<SprayTrainingPanel />);
    await openWall(1);

    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    let releaseNextPage: (page: unknown) => void = () => undefined;
    mockRequest.mockImplementationOnce(() => new Promise((resolve) => (releaseNextPage = resolve)));
    fireEvent.keyDown(window, { key: 'a' });

    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));
    expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', FIRST_PAGE);
    // A wall is still waiting, so the queue is not empty and the dialog holds its place.
    expect(screen.queryByText('Nothing here')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByText('Loading more walls')).toBeTruthy();

    releaseNextPage(queueResponse([makeItem('v2', 2)]));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('Wall version 2')).toBeTruthy());
    expect(screen.queryByText('Nothing here')).toBeNull();
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('says the tab is empty once the last wall of the last page is decided', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    await openWall(1);

    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    fireEvent.keyDown(window, { key: 'a' });

    expect(await screen.findByText('Nothing here')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('closes the dialog on the retry prompt when the next page fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)], { hasMore: true, unreviewed: 2 }));
    render(<SprayTrainingPanel />);
    await openWall(1);

    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    mockRequest.mockRejectedValueOnce(new Error('offline'));
    fireEvent.keyDown(window, { key: 'a' });

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Nothing here')).toBeNull();
    // One failed read, not a retry loop.
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });
});

describe('SprayTrainingPanel after a failed "Load more"', () => {
  /** Loads one page, then fails the next one, leaving the Retry prompt up. */
  async function failLoadMore(firstPage: SprayTrainingQueueItemData[], unreviewed: number) {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRequest.mockResolvedValueOnce(queueResponse(firstPage, { hasMore: true, unreviewed }));
    render(<SprayTrainingPanel />);

    mockRequest.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('button', { name: 'Retry' });
    expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', {
      status: 'UNREVIEWED',
      limit: 25,
      offset: firstPage.length,
    });
  }

  it('retries from the walls still loaded, so a verdict given since the failure skips nothing', async () => {
    // The Unreviewed tab as the server holds it, in order.
    let unreviewedOnServer = [makeItem('v1', 1), makeItem('v2', 2), makeItem('v3', 3), makeItem('v4', 4)];
    await failLoadMore(unreviewedOnServer.slice(0, 2), 4);

    const dialog = await openWall(1);
    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(within(dialog).getByText('Wall version 2')).toBeTruthy());
    // The approved wall has left the tab on the server too, so every later wall moved up one.
    unreviewedOnServer = unreviewedOnServer.slice(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The server answers the offset it is asked for from the list as it stands now.
    mockRequest.mockImplementationOnce((_operation: string, variables: { offset: number }) =>
      Promise.resolve(queueResponse(unreviewedOnServer.slice(variables.offset), { unreviewed: 3 })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', {
        status: 'UNREVIEWED',
        limit: 25,
        offset: 1,
      }),
    );
    await screen.findByRole('button', { name: 'Review wall version 4' });
    const cardNames = screen
      .getAllByRole('button', { name: /^Review wall version/ })
      .map((card) => card.getAttribute('aria-label'));
    expect(cardNames).toEqual(['Review wall version 2', 'Review wall version 3', 'Review wall version 4']);
  });

  it('reads on from the top when the last loaded wall is decided while the error still shows', async () => {
    await failLoadMore([makeItem('v1', 1)], 2);

    await openWall(1);
    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v2', 2)]));
    fireEvent.keyDown(window, { key: 'a' });

    // The page that failed lay past a wall that is gone now: the read starts over, unprompted.
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(4));
    expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', FIRST_PAGE);
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('Wall version 2')).toBeTruthy());
    expect(screen.queryByText('Nothing here')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry', hidden: true })).toBeNull();
  });

  it('leaves a failed read of the top of the list to Retry, which starts from the first wall', async () => {
    await failLoadMore([makeItem('v1', 1)], 2);

    await openWall(1);
    mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
    mockRequest.mockRejectedValueOnce(new Error('still offline'));
    fireEvent.keyDown(window, { key: 'a' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // One unprompted read, not a loop, and no claim that the tab is empty.
    expect(mockRequest).toHaveBeenCalledTimes(4);
    expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', FIRST_PAGE);
    expect(screen.queryByText('Nothing here')).toBeNull();

    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v2', 2)]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Review wall version 2' })).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledTimes(5);
    expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_QUEUE', FIRST_PAGE);
  });
});

describe('SprayTrainingPanel refused verdicts', () => {
  it('takes a wall that left the training set off the screen and says why', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);

    mockRequest.mockRejectedValueOnce(graphqlFailure('SPRAY_TRAINING_NOT_ELIGIBLE'));
    mockRequest.mockResolvedValueOnce({
      sprayTrainingQueue: { totals: { unreviewed: 1, approved: 0, rejected: 0 } },
    });
    fireEvent.keyDown(window, { key: 'a' });

    expect(await screen.findByText('Not saved. This wall is no longer available as training data.')).toBeTruthy();
    expect(screen.queryByText("Couldn't save the review")).toBeNull();
    // Gone from the grid, and the dialog has moved on like after any verdict.
    expect(screen.queryByRole('button', { name: 'Review wall version 1', hidden: true })).toBeNull();
    expect(within(dialog).getByText('Wall version 2')).toBeTruthy();
    expect(within(dialog).getByAltText(PHOTO_ALT).getAttribute('src')).toBe('https://photos.example/v2.jpg');
    // The counts come from the server: nothing was approved, one wall is left.
    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith('GET_SPRAY_TRAINING_TOTALS', { status: 'UNREVIEWED' }),
    );
    expect(await screen.findByRole('button', { name: 'Unreviewed (1)', hidden: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved (0)', hidden: true })).toBeTruthy();
  });

  it('counts the wall out itself when the server totals cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    await openWall(1);

    mockRequest.mockRejectedValueOnce(graphqlFailure('SPRAY_TRAINING_NOT_ELIGIBLE'));
    mockRequest.mockRejectedValueOnce(new Error('offline'));
    fireEvent.keyDown(window, { key: 'a' });

    expect(await screen.findByRole('button', { name: 'Unreviewed (1)', hidden: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved (0)', hidden: true })).toBeTruthy();
  });

  it('keeps the wall in place when the save fails for any other reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1), makeItem('v2', 2)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);

    mockRequest.mockRejectedValueOnce(graphqlFailure('INTERNAL_SERVER_ERROR'));
    fireEvent.keyDown(window, { key: 'a' });

    expect(await screen.findByText("Couldn't save the review")).toBeTruthy();
    expect(within(dialog).getByText('Wall version 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unreviewed (2)', hidden: true })).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledTimes(2);
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
      await openWall(1);

      // The refresh starts about 30 s in (60 s before expiry) and is held open.
      let releaseRefresh: (value: unknown) => void = () => undefined;
      mockRequest.mockImplementationOnce(() => new Promise((resolve) => (releaseRefresh = resolve)));
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));

      mockRequest.mockResolvedValueOnce(reviewResponse('v1', 'APPROVED'));
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
    rejected.review = { status: 'REJECTED', reason: 'BAD_HOLDS', notes: null };
    mockRequest.mockResolvedValueOnce({
      sprayTrainingQueue: { hasMore: false, totals: { unreviewed: 0, approved: 0, rejected: 1 }, items: [] },
    });
    render(<SprayTrainingPanel />);
    await screen.findByText('Nothing here');
    mockRequest.mockResolvedValueOnce({
      sprayTrainingQueue: { hasMore: false, totals: { unreviewed: 0, approved: 0, rejected: 1 }, items: [rejected] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rejected (1)' }));
    const dialog = await openWall(1);

    mockRequest.mockResolvedValueOnce({
      setSprayTrainingReview: {
        versionId: 'v1',
        review: { status: 'REJECTED', reason: 'BAD_HOLDS', notes: 'again' },
      },
    });
    fireEvent.change(within(dialog).getByLabelText('Notes (optional)'), { target: { value: 'again' } });
    fireEvent.click(rejectButton(dialog));

    await waitFor(() => expect(mockRequest).toHaveBeenLastCalledWith('SET_SPRAY_TRAINING_REVIEW', expect.anything()));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('Wall version 1')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Rejected (1)', hidden: true })).toBeTruthy();
  });

  it('ignores shortcuts typed in the notes field and while the reason menu is open', async () => {
    const withReason = makeItem('v1', 1);
    // A saved reason, so R would reject at once if the key got through.
    withReason.review = { status: 'UNREVIEWED', reason: 'BAD_HOLDS', notes: null };
    mockRequest.mockResolvedValueOnce(queueResponse([withReason]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);

    const notesField = within(dialog).getByLabelText('Notes (optional)');
    fireEvent.keyDown(notesField, { key: 'a' });
    fireEvent.keyDown(notesField, { key: 'r' });
    expect(reviewCalls()).toHaveLength(0);

    fireEvent.mouseDown(within(dialog).getByRole('combobox'));
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'a' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'r' });
    expect(reviewCalls()).toHaveLength(0);
  });

  it.each([
    ['r', { versionId: 'v1', status: 'REJECTED', reason: 'PHOTO_QUALITY', notes: null }],
    ['a', { versionId: 'v1', status: 'APPROVED', reason: null, notes: null }],
  ] as const)('takes %s from the closed reason picker after a mouse pick', async (key, input) => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);

    // MUI leaves focus on the picker's trigger, so that is where the next key lands.
    const reasonPicker = await pickReasonWithMouse(dialog, 'Photo quality');
    mockRequest.mockResolvedValueOnce(reviewResponse('v1', input.status));
    fireEvent.keyDown(reasonPicker, { key });

    await waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(reviewCalls()[0][1]).toEqual({ input });
  });

  it('leaves Cmd, Ctrl and Alt combinations to the browser', async () => {
    const withReason = makeItem('v1', 1);
    // A saved reason, so Cmd+R would reject at once if it were read as R.
    withReason.review = { status: 'UNREVIEWED', reason: 'BAD_HOLDS', notes: null };
    mockRequest.mockResolvedValueOnce(queueResponse([withReason]));
    render(<SprayTrainingPanel />);
    await openWall(1);

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const reload = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true, ...modifier });
      const selectAll = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, ...modifier });
      fireEvent(window, reload);
      fireEvent(window, selectAll);
      // Cmd+R still has to reload the page.
      expect(reload.defaultPrevented).toBe(false);
      expect(selectAll.defaultPrevented).toBe(false);
    }
    expect(reviewCalls()).toHaveLength(0);
  });

  it('still takes shortcuts after a legend switch has focus', async () => {
    mockRequest.mockResolvedValueOnce(queueResponse([makeItem('v1', 1)]));
    render(<SprayTrainingPanel />);
    const dialog = await openWall(1);
    const overlay = await screen.findByTestId('spray-hold-overlay');

    const legendSwitch = within(dialog).getAllByRole('switch')[0];
    fireEvent.keyDown(legendSwitch, { key: 'h' });

    await waitFor(() => expect(overlay.querySelectorAll('[data-kind]').length).toBe(0));
  });
});

describe('isShortcutBlockedTarget', () => {
  function element(markup: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = markup;
    return host.firstElementChild as HTMLElement;
  }

  it.each([
    ['a multi-line text field', '<textarea></textarea>'],
    ['a text input', '<input type="text" />'],
    ['a search input', '<input type="search" />'],
    ['a native select', '<select></select>'],
    ['an open menu', '<ul role="listbox"></ul>'],
  ])('blocks %s', (_label, markup) => {
    expect(isShortcutBlockedTarget(element(markup))).toBe(true);
  });

  it('blocks an option inside an open menu', () => {
    const menu = element('<ul role="listbox"><li role="option"><span>Photo quality</span></li></ul>');
    expect(isShortcutBlockedTarget(menu.querySelector('span'))).toBe(true);
  });

  it.each([
    ['the closed reason picker', '<div role="combobox" tabindex="0"></div>'],
    ['a switch', '<input type="checkbox" role="switch" />'],
    ['a button', '<button type="button"></button>'],
  ])('lets shortcuts through from %s', (_label, markup) => {
    expect(isShortcutBlockedTarget(element(markup))).toBe(false);
  });

  it('lets shortcuts through when no element has the key', () => {
    expect(isShortcutBlockedTarget(window)).toBe(false);
    expect(isShortcutBlockedTarget(null)).toBe(false);
  });
});
