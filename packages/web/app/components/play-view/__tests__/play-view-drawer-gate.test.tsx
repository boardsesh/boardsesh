// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { render, act, fireEvent, cleanup } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Simplified gate pattern that mirrors PlayViewDrawer's behavior.
//
// The real PlayViewDrawer wraps PlayViewDrawerInner and only mounts it when
// the drawer is open or still closing (keeping it alive for the exit animation).
// This prevents useQueueData() subscriptions from firing when the drawer is
// fully closed.
//
// We test the pattern in isolation so we don't need the full dependency tree.
// ---------------------------------------------------------------------------

// Simulate a context that would cause re-renders (like QueueDataContext)
const TestContext = createContext<{ value: number }>({ value: 0 });

// Mutable tracking objects -- reset in beforeEach
const innerRenderCount = { current: 0 };
const innerMounted = { current: false };

/** Inner component that subscribes to context -- mirrors PlayViewDrawerInner */
const Inner = () => {
  const { value } = useContext(TestContext);
  innerRenderCount.current++;

  useEffect(() => {
    innerMounted.current = true;
    return () => {
      innerMounted.current = false;
    };
  }, []);

  return <div data-testid="inner">Value: {value}</div>;
};

/** Gate wrapper -- mirrors the PlayViewDrawer gate logic */
const GatedComponent = ({
  isOpen,
  onTransitionEnd,
}: {
  isOpen: boolean;
  onTransitionEnd?: (open: boolean) => void;
}) => {
  const [keepMounted, setKeepMounted] = useState(false);
  const showContent = isOpen || keepMounted;

  useEffect(() => {
    if (isOpen) setKeepMounted(true);
  }, [isOpen]);

  const handleTransitionEnd = useCallback(
    (open: boolean) => {
      if (!open) setKeepMounted(false);
      onTransitionEnd?.(open);
    },
    [onTransitionEnd],
  );

  return (
    <div data-testid="gate">
      {showContent ? <Inner /> : null}
      {/* Expose handleTransitionEnd for testing via a button click */}
      <button data-testid="trigger-close-transition" onClick={() => handleTransitionEnd(false)} />
    </div>
  );
};

/**
 * Controllable test harness. We drive state changes through a ref-based
 * controller to avoid the rerender/remount ambiguity that can occur with
 * RTL's rerender() when the wrapper tree changes.
 */
interface ControllerHandle {
  setIsOpen: (v: boolean) => void;
  setContextValue: (v: number) => void;
}

const controllerRef: { current: ControllerHandle | null } = { current: null };

const TestHarness = ({
  initialIsOpen,
  initialContextValue,
  onTransitionEnd,
}: {
  initialIsOpen: boolean;
  initialContextValue: number;
  onTransitionEnd?: (open: boolean) => void;
}) => {
  const [isOpen, setIsOpen] = useState(initialIsOpen);
  const [contextValue, setContextValue] = useState(initialContextValue);

  controllerRef.current = { setIsOpen, setContextValue };

  return (
    <TestContext.Provider value={{ value: contextValue }}>
      <GatedComponent isOpen={isOpen} onTransitionEnd={onTransitionEnd} />
    </TestContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlayViewDrawer gate pattern', () => {
  beforeEach(() => {
    innerRenderCount.current = 0;
    innerMounted.current = false;
    controllerRef.current = null;
  });

  afterEach(() => {
    cleanup();
  });

  // -----------------------------------------------------------------------
  // 1. Inner component is NOT mounted when the drawer starts closed
  // -----------------------------------------------------------------------
  it('does not mount the inner component when the drawer is closed', () => {
    const { queryByTestId } = render(
      <TestHarness initialIsOpen={false} initialContextValue={0} />,
    );

    expect(queryByTestId('inner')).toBeNull();
    expect(innerMounted.current).toBe(false);
    expect(innerRenderCount.current).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 2. Inner component mounts when the drawer opens
  // -----------------------------------------------------------------------
  it('mounts the inner component when the drawer opens', () => {
    const { queryByTestId } = render(
      <TestHarness initialIsOpen={false} initialContextValue={0} />,
    );

    // Initially not rendered
    expect(queryByTestId('inner')).toBeNull();

    // Open the drawer
    act(() => {
      controllerRef.current!.setIsOpen(true);
    });

    expect(queryByTestId('inner')).not.toBeNull();
    expect(innerMounted.current).toBe(true);
    expect(innerRenderCount.current).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 3. Inner component stays mounted during close animation, then unmounts
  // -----------------------------------------------------------------------
  it('unmounts the inner component after the close animation completes', () => {
    const onTransitionEnd = vi.fn();

    const { queryByTestId, getByTestId } = render(
      <TestHarness initialIsOpen={true} initialContextValue={0} onTransitionEnd={onTransitionEnd} />,
    );

    // Inner is mounted while open
    expect(queryByTestId('inner')).not.toBeNull();
    expect(innerMounted.current).toBe(true);

    // Close the drawer (isOpen -> false), but transition hasn't ended yet
    act(() => {
      controllerRef.current!.setIsOpen(false);
    });

    // keepMounted keeps it alive during the close animation
    expect(queryByTestId('inner')).not.toBeNull();
    expect(innerMounted.current).toBe(true);

    // Simulate the transition end event
    act(() => {
      fireEvent.click(getByTestId('trigger-close-transition'));
    });

    // Now it should be unmounted
    expect(queryByTestId('inner')).toBeNull();
    expect(innerMounted.current).toBe(false);
    expect(onTransitionEnd).toHaveBeenCalledWith(false);
  });

  // -----------------------------------------------------------------------
  // 4. Context changes do NOT re-render the inner component after unmount
  // -----------------------------------------------------------------------
  it('does not re-render the inner component when closed and context changes', () => {
    const { queryByTestId, getByTestId } = render(
      <TestHarness initialIsOpen={true} initialContextValue={0} />,
    );

    // Open and mounted
    expect(queryByTestId('inner')).not.toBeNull();

    // Close the drawer
    act(() => {
      controllerRef.current!.setIsOpen(false);
    });

    // Complete the close animation
    act(() => {
      fireEvent.click(getByTestId('trigger-close-transition'));
    });

    // Inner is now fully unmounted
    expect(queryByTestId('inner')).toBeNull();
    expect(innerMounted.current).toBe(false);

    const renderCountAfterUnmount = innerRenderCount.current;

    // Change the context value -- this would trigger re-renders if Inner were still mounted
    act(() => {
      controllerRef.current!.setContextValue(42);
    });

    act(() => {
      controllerRef.current!.setContextValue(99);
    });

    // Render count should NOT have increased since unmount
    expect(innerRenderCount.current).toBe(renderCountAfterUnmount);
    expect(innerMounted.current).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. Re-opening after close works correctly
  // -----------------------------------------------------------------------
  it('re-mounts the inner component when the drawer re-opens after a full close', () => {
    const { queryByTestId, getByTestId } = render(
      <TestHarness initialIsOpen={true} initialContextValue={0} />,
    );

    expect(innerMounted.current).toBe(true);

    // Close + complete transition
    act(() => {
      controllerRef.current!.setIsOpen(false);
    });
    act(() => {
      fireEvent.click(getByTestId('trigger-close-transition'));
    });

    expect(queryByTestId('inner')).toBeNull();
    expect(innerMounted.current).toBe(false);

    // Re-open
    act(() => {
      controllerRef.current!.setIsOpen(true);
    });

    expect(queryByTestId('inner')).not.toBeNull();
    expect(innerMounted.current).toBe(true);
  });
});
