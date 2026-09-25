import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vite-plus/test';

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

import PageError, { __resetSessionAutoResetCountForTesting } from '../error';

function makeNotFoundError(message: string): Error {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

function makeWebkitNotFoundError(stack: string): DOMException {
  const error = new DOMException('The object can not be found here.', 'NotFoundError');
  Object.defineProperty(error, 'stack', { value: stack });
  return error;
}

afterEach(() => {
  cleanup();
  captureException.mockClear();
  vi.useRealTimers();
  __resetSessionAutoResetCountForTesting();
});

describe('PageError visible fallback', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('renders English retry copy on root path', () => {
    const { container } = render(<PageError error={new Error('boom')} reset={() => {}} />);
    expect(container.textContent).toContain('Something broke');
    expect(container.textContent).toContain('Try again');
  });

  it('renders Spanish copy on /es', () => {
    window.history.pushState({}, '', '/es/foo');
    const { container } = render(<PageError error={new Error('boom')} reset={() => {}} />);
    expect(container.textContent).toContain('Algo se rompió');
    expect(container.textContent).toContain('Reintentar');
  });

  it('renders French copy on /fr', () => {
    window.history.pushState({}, '', '/fr/foo');
    const { container } = render(<PageError error={new Error('boom')} reset={() => {}} />);
    expect(container.textContent).toContain('Ça a cassé');
    expect(container.textContent).toContain('Réessayer');
  });

  it('reports non-translator errors to Sentry without auto-reset', () => {
    const error = new Error('upstream failure');
    const reset = vi.fn();
    render(<PageError error={error} reset={reset} />);
    expect(captureException).toHaveBeenCalledWith(error);
    expect(reset).not.toHaveBeenCalled();
  });
});

describe('PageError translator-DOM auto-recovery', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
    vi.useFakeTimers();
  });

  it('auto-resets once on NotFoundError + removeChild', () => {
    const error = makeNotFoundError(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    );
    const reset = vi.fn();
    render(<PageError error={error} reset={reset} />);
    expect(captureException).toHaveBeenCalledWith(error, { tags: { autoRecovered: 'translator-dom' } });
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('auto-resets once on NotFoundError + insertBefore', () => {
    const error = makeNotFoundError(
      "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
    );
    const reset = vi.fn();
    render(<PageError error={error} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('auto-resets a WebKit DOM commit error when the raw stack names insertBefore', () => {
    const error = makeWebkitNotFoundError(
      'insertBefore@[native code]\nsr@https://boardsesh.com/_next/static/chunks/app.js:1:123',
    );
    const reset = vi.fn();
    render(<PageError error={error} reset={reset} />);
    expect(captureException).toHaveBeenCalledWith(error, { tags: { autoRecovered: 'translator-dom' } });
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('keeps an unrelated WebKit NotFoundError visible even with code 8', () => {
    const error = makeWebkitNotFoundError(
      'get@[native code]\nreadFromIndexedDB@https://boardsesh.com/_next/static/chunks/app.js:1:123',
    );
    const reset = vi.fn();
    const { container } = render(<PageError error={error} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Something broke');
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it('keeps a WebKit NotFoundError with no stack visible', () => {
    const error = makeWebkitNotFoundError('');
    const reset = vi.fn();
    render(<PageError error={error} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).not.toHaveBeenCalled();
  });

  it('does not recover another DOMException even when its stack names insertBefore', () => {
    const error = new DOMException('The object can not be found here.', 'InvalidStateError');
    Object.defineProperty(error, 'stack', { value: 'insertBefore@[native code]' });
    const reset = vi.fn();
    render(<PageError error={error} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).not.toHaveBeenCalled();
  });

  it('does not auto-reset a generic NotFoundError', () => {
    const error = makeNotFoundError('something else entirely');
    const reset = vi.fn();
    render(<PageError error={error} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it('shows the visible fallback when the translator error survives the first auto-reset', () => {
    const firstError = makeNotFoundError(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    );
    const reset = vi.fn();
    const { rerender, container } = render(<PageError error={firstError} reset={reset} />);

    // First render renders null while the auto-reset is in flight.
    expect(container.textContent ?? '').not.toContain('Something broke');

    act(() => {
      vi.runAllTimers();
    });
    expect(reset).toHaveBeenCalledTimes(1);

    // The translator is still mutating the DOM, so the same NotFoundError fires
    // again. The boundary should now surface the visible fallback instead of
    // leaving the user staring at a blank page.
    const secondError = makeNotFoundError(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    );
    rerender(<PageError error={secondError} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });

    expect(reset).toHaveBeenCalledTimes(1); // no second auto-reset
    expect(container.textContent).toContain('Something broke');
    expect(container.textContent).toContain('Try again');
    expect(captureException).toHaveBeenCalledWith(secondError);
  });

  it('shows the visible fallback when a WebKit error survives its first auto-reset', () => {
    const stack = 'insertBefore@[native code]\nsr@https://boardsesh.com/app.js:1:123';
    const firstError = makeWebkitNotFoundError(stack);
    const reset = vi.fn();
    const { rerender, container } = render(<PageError error={firstError} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).toHaveBeenCalledTimes(1);

    const secondError = makeWebkitNotFoundError(stack);
    rerender(<PageError error={secondError} reset={reset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Something broke');
    expect(captureException).toHaveBeenCalledWith(secondError);
  });

  it('does not double-capture the same error when reset identity changes', () => {
    const error = makeNotFoundError(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    );
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    const { rerender } = render(<PageError error={error} reset={firstReset} />);
    // Re-render with a NEW reset reference but the SAME error before the
    // scheduled reset fires. The previous effect's cleanup cancels the
    // setTimeout; the new effect must not re-capture or re-tag the error.
    rerender(<PageError error={error} reset={secondReset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, { tags: { autoRecovered: 'translator-dom' } });
  });

  it('does not auto-reset across navigations once the session budget is exhausted', () => {
    const firstError = makeNotFoundError(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    );
    const firstReset = vi.fn();
    const { unmount } = render(<PageError error={firstError} reset={firstReset} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(firstReset).toHaveBeenCalledTimes(1);

    // Simulate the user navigating to another page: previous boundary unmounts,
    // a new one mounts with a fresh error. The module-level counter must keep
    // the budget bounded — otherwise every navigation grants a new silent
    // recovery and the user never sees the fallback.
    unmount();

    const secondError = makeNotFoundError(
      "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
    );
    const secondReset = vi.fn();
    const { container } = render(<PageError error={secondError} reset={secondReset} />);
    act(() => {
      vi.runAllTimers();
    });

    expect(secondReset).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Something broke');
  });
});
