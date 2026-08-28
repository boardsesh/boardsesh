import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import ErrorBoundary from '../error-boundary';

// Suppress React error boundary console noise in tests
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The clock is frozen on purpose. `shouldAdvanceTime: true` ticks the fake
  // clock from real wall time, and Vitest fakes requestAnimationFrame, so the
  // boundary's pending recovery frame fires between statements and silently
  // spends one of its three retries. On a loaded CI shard that left the budget
  // exhausted while the child was still throwing, the boundary gave up, and
  // the test could never see "recovered". See #4470.
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AlwaysThrow = () => {
  throw new Error('persistent error');
};

const Conditional = ({ throwNow }: { throwNow: boolean }) => {
  if (throwNow) throw new Error('transient');
  return <div>recovered</div>;
};

/** Fire exactly one pending recovery frame, and nothing else. */
const nextFrame = async () => {
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
};

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('renders fallback on error', () => {
    render(
      <ErrorBoundary fallback={<div>oops</div>}>
        <AlwaysThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('oops')).toBeTruthy();
  });

  it('renders nothing when error and no fallback', () => {
    const { container } = render(
      <ErrorBoundary>
        <AlwaysThrow />
      </ErrorBoundary>,
    );
    expect(container.innerHTML).toBe('');
  });

  describe('recoverable mode', () => {
    /** A recoverable boundary whose child throws only while `throwNow` is set. */
    const recoverableTree = (throwNow: boolean) => (
      <ErrorBoundary recoverable fallback={<div>gave up</div>}>
        <Conditional throwNow={throwNow} />
      </ErrorBoundary>
    );

    it('auto-resets after a transient error', async () => {
      const { rerender } = render(
        <ErrorBoundary recoverable>
          <Conditional throwNow />
        </ErrorBoundary>,
      );

      // Error caught, fallback rendered (null)
      expect(screen.queryByText('recovered')).toBeNull();

      // Fix the error, then flush the recovery frame the boundary scheduled.
      rerender(
        <ErrorBoundary recoverable>
          <Conditional throwNow={false} />
        </ErrorBoundary>,
      );
      await nextFrame();

      expect(screen.getByText('recovered')).toBeTruthy();
    });

    it('stops retrying after max attempts', async () => {
      render(
        <ErrorBoundary recoverable fallback={<div>gave up</div>}>
          <AlwaysThrow />
        </ErrorBoundary>,
      );

      // Flush multiple rAF cycles (more than the 3 retry limit)
      for (let i = 0; i < 5; i++) {
        await nextFrame();
      }

      // Should have given up and show the fallback permanently
      expect(screen.getByText('gave up')).toBeTruthy();
    });

    it('exhausts the budget after three recoveries', async () => {
      const { rerender } = render(recoverableTree(true));

      // Three successful recoveries spend the whole budget.
      for (let round = 0; round < 3; round++) {
        rerender(recoverableTree(false));
        await nextFrame();
        expect(screen.getByText('recovered')).toBeTruthy();
        rerender(recoverableTree(true));
      }

      // Fourth error, budget spent, no quiet period: stuck on the fallback.
      rerender(recoverableTree(false));
      await nextFrame();
      expect(screen.queryByText('recovered')).toBeNull();
      expect(screen.getByText('gave up')).toBeTruthy();
    });

    it('resets retry budget after quiet period', async () => {
      const { rerender } = render(recoverableTree(true));

      // Spend the full budget on three recoveries, ending error-free.
      for (let round = 0; round < 3; round++) {
        rerender(recoverableTree(false));
        await nextFrame();
        expect(screen.getByText('recovered')).toBeTruthy();
        if (round < 2) rerender(recoverableTree(true));
      }

      // 30 s error-free puts the budget back to zero.
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      // A brand new error still recovers. Without the reset this would stay on
      // the fallback, as 'exhausts the budget after three recoveries' shows.
      rerender(recoverableTree(true));
      expect(screen.getByText('gave up')).toBeTruthy();
      rerender(recoverableTree(false));
      await nextFrame();
      expect(screen.getByText('recovered')).toBeTruthy();
    });

    it('does not auto-reset when recoverable is false', async () => {
      render(
        <ErrorBoundary fallback={<div>stuck</div>}>
          <AlwaysThrow />
        </ErrorBoundary>,
      );

      expect(screen.getByText('stuck')).toBeTruthy();

      // Flush rAF
      await nextFrame();

      // Still stuck on fallback
      expect(screen.getByText('stuck')).toBeTruthy();
    });
  });
});
