import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';
import { GlobalErrorTrap } from '../global-error-trap';
import { SnackbarProvider } from '../snackbar-provider';

const captureExceptionMock = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'stackOverflowTrap.message' ? 'Something looped on this page. We logged it — try reloading.' : key,
    i18n: { language: 'en-US' },
  }),
}));

function dispatchErrorEvent(error: unknown, overrides: Partial<ErrorEventInit> = {}) {
  const event = new ErrorEvent('error', {
    error,
    message: error instanceof Error ? error.message : String(error),
    filename: 'https://www.boardsesh.com/_next/static/chunks/app.js',
    lineno: 38,
    colno: 1,
    ...overrides,
  });
  window.dispatchEvent(event);
}

describe('GlobalErrorTrap', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
  });

  afterEach(() => {
    // Unmount via React so the GlobalErrorTrap `useEffect` cleanup runs and
    // removes its window `error` listener between tests (a raw innerHTML reset
    // would leak listeners across cases).
    cleanup();
  });

  it('captures RangeError stack overflow with extra context', () => {
    render(
      <SnackbarProvider>
        <GlobalErrorTrap />
      </SnackbarProvider>,
    );

    const err = new RangeError('Maximum call stack size exceeded.');
    act(() => {
      dispatchErrorEvent(err);
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedErr, captureContext] = captureExceptionMock.mock.calls[0] as [
      unknown,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(capturedErr).toBe(err);
    expect(captureContext.tags).toEqual({ kind: 'stack-overflow-trap' });
    expect(captureContext.extra.lineno).toBe(38);
    expect(captureContext.extra.filename).toBe('https://www.boardsesh.com/_next/static/chunks/app.js');
  });

  it('shows a snackbar when a stack overflow is captured', () => {
    const { baseElement } = render(
      <SnackbarProvider>
        <GlobalErrorTrap />
      </SnackbarProvider>,
    );

    act(() => {
      dispatchErrorEvent(new RangeError('Maximum call stack size exceeded.'));
    });

    expect(baseElement.textContent).toContain('Something looped');
  });

  it('ignores unrelated errors', () => {
    render(
      <SnackbarProvider>
        <GlobalErrorTrap />
      </SnackbarProvider>,
    );

    act(() => {
      dispatchErrorEvent(new TypeError('Cannot read property foo of undefined'));
      dispatchErrorEvent(new RangeError('Invalid array length'));
      dispatchErrorEvent('not even an error');
    });

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('removes its window listener on unmount', () => {
    const { unmount } = render(
      <SnackbarProvider>
        <GlobalErrorTrap />
      </SnackbarProvider>,
    );

    unmount();

    act(() => {
      dispatchErrorEvent(new RangeError('Maximum call stack size exceeded.'));
    });

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
