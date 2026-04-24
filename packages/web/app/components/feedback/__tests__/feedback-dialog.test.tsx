import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

// The dialog pulls in a React Query hook, a snackbar provider, and an
// IndexedDB-backed db module. Stub them out so these tests focus on the
// onSubmitted chaining contract and don't depend on a full app shell.
vi.mock('@/app/hooks/use-submit-app-feedback', () => ({
  useSubmitAppFeedback: vi.fn(),
}));
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));
vi.mock('@/app/lib/feedback-prompt-db', () => ({
  setFeedbackStatus: vi.fn().mockResolvedValue(undefined),
}));

import { FeedbackDialog } from '../feedback-dialog';
import { useSubmitAppFeedback } from '@/app/hooks/use-submit-app-feedback';
import { setFeedbackStatus } from '@/app/lib/feedback-prompt-db';

type MutateAsync = (payload: unknown) => Promise<boolean>;

const mockedUseSubmitAppFeedback = vi.mocked(useSubmitAppFeedback);
const mockedSetFeedbackStatus = vi.mocked(setFeedbackStatus);

function pickStars(n: number) {
  fireEvent.click(screen.getByRole('option', { name: `${n} star${n > 1 ? 's' : ''}` }));
}

function setupMutate(behavior: 'success' | 'error' | 'noop') {
  const mutateAsync: MutateAsync = vi.fn(() => {
    if (behavior === 'success') return Promise.resolve(true);
    if (behavior === 'error') return Promise.reject(new Error('simulated failure'));
    return new Promise<boolean>(() => undefined); // hangs forever — for cancel/close tests
  });
  mockedUseSubmitAppFeedback.mockReturnValue({ mutateAsync } as never);
  return mutateAsync;
}

// After firing the mutation we need to flush the microtask queue so the
// `.then` / `.catch` chain runs before assertions. Two resolves covers the
// one await inside the handler plus any trailing microtasks scheduled by
// React Query.
async function flushSubmission() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('FeedbackDialog — onSubmitted chaining', () => {
  beforeEach(() => {
    mockedUseSubmitAppFeedback.mockReset();
    mockedSetFeedbackStatus.mockClear();
  });

  it('fires onSubmitted with the submitted values AFTER the mutation succeeds', async () => {
    setupMutate('success');
    const onSubmitted = vi.fn();
    render(<FeedbackDialog open onClose={vi.fn()} source="drawer-feedback" onSubmitted={onSubmitted} />);
    pickStars(5);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });
    await flushSubmission();
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledWith({ rating: 5, comment: null });
  });

  it('calls onClose on successful submission — guarantees no stacking when a caller chains another dialog in onSubmitted', async () => {
    setupMutate('success');
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} source="drawer-feedback" onSubmitted={vi.fn()} />);
    pickStars(5);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });
    await flushSubmission();
    expect(onClose).toHaveBeenCalled();
  });

  it('marks the auto-banner status as "submitted" when the user rates via the drawer', async () => {
    setupMutate('success');
    render(<FeedbackDialog open onClose={vi.fn()} source="drawer-feedback" onSubmitted={vi.fn()} />);
    pickStars(4);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });
    await flushSubmission();
    expect(mockedSetFeedbackStatus).toHaveBeenCalledWith('submitted');
  });

  it("does NOT mark the auto-banner status on a bug submission — bugs aren't a rating", async () => {
    setupMutate('success');
    render(<FeedbackDialog open onClose={vi.fn()} source="drawer-bug" mode="bug" onSubmitted={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/what were you doing/i), {
      target: { value: 'crashed when submitting' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send bug report/i }));
    });
    await flushSubmission();
    expect(mockedSetFeedbackStatus).not.toHaveBeenCalled();
  });

  it('uses "Rate Boardsesh" as the default title when no title is passed', () => {
    setupMutate('noop');
    render(<FeedbackDialog open onClose={vi.fn()} source="drawer-feedback" />);
    expect(screen.getByText('Rate Boardsesh')).toBeTruthy();
  });

  it('does NOT fire onSubmitted when the mutation errors', async () => {
    setupMutate('error');
    const onSubmitted = vi.fn();
    render(<FeedbackDialog open onClose={vi.fn()} source="drawer-feedback" onSubmitted={onSubmitted} />);
    pickStars(5);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });
    await flushSubmission();
    // The user sees the "Couldn't send" snackbar — asking them to publicly
    // review the app on top of that failure would be user-hostile.
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('does NOT fire onSubmitted when the user cancels', async () => {
    setupMutate('noop');
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} source="drawer-feedback" onSubmitted={onSubmitted} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('does NOT fire onSubmitted when the user hits the Close (X) icon', async () => {
    setupMutate('noop');
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} source="drawer-feedback" onSubmitted={onSubmitted} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /close/i }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('fires onSubmitted with rating=null for a successful bug submission', async () => {
    const mutateAsync = setupMutate('success');
    const onSubmitted = vi.fn();
    render(<FeedbackDialog open onClose={vi.fn()} source="drawer-bug" mode="bug" onSubmitted={onSubmitted} />);
    fireEvent.change(screen.getByPlaceholderText(/what were you doing/i), {
      target: { value: 'crashed when submitting' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send bug report/i }));
    });
    await flushSubmission();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledWith({ rating: null, comment: 'crashed when submitting' });
  });
});
