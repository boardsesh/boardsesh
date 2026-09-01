// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOtaBranchSurfingState,
  resetOtaBranchSurfingStateForTests,
  setOtaBranchSurfingState,
  subscribeOtaBranchSurfingState,
  useOtaBranchSurfingState,
} from '../ota-branch-surfing-state';

beforeEach(() => {
  resetOtaBranchSurfingStateForTests();
});

describe('ota-branch-surfing-state', () => {
  it('starts as "cannot surf, not settled yet"', () => {
    // The safe default: nothing prompts until the root layout says otherwise.
    expect(getOtaBranchSurfingState()).toEqual({ surfingBuild: false, ready: false });
  });

  it('publishes what the root layout resolved', () => {
    setOtaBranchSurfingState({ surfingBuild: true, ready: false });
    expect(getOtaBranchSurfingState()).toEqual({ surfingBuild: true, ready: false });

    setOtaBranchSurfingState({ surfingBuild: true, ready: true });
    expect(getOtaBranchSurfingState()).toEqual({ surfingBuild: true, ready: true });
  });

  it('hands back a reference-stable snapshot between writes', () => {
    // useSyncExternalStore compares snapshots by identity: a fresh object per
    // call reads as "changed on every commit" and loops render →
    // forceStoreRerender until React's update-depth guard fires.
    setOtaBranchSurfingState({ surfingBuild: true, ready: true });
    expect(getOtaBranchSurfingState()).toBe(getOtaBranchSurfingState());
  });

  it('notifies subscribers on a real change and stops on unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOtaBranchSurfingState(listener);

    setOtaBranchSurfingState({ surfingBuild: true, ready: false });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setOtaBranchSurfingState({ surfingBuild: true, ready: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stays silent when nothing actually changed', () => {
    setOtaBranchSurfingState({ surfingBuild: true, ready: true });
    const listener = vi.fn();
    subscribeOtaBranchSurfingState(listener);

    setOtaBranchSurfingState({ surfingBuild: true, ready: true });
    expect(listener).not.toHaveBeenCalled();
  });
});

function SurfingStateProbe() {
  const { surfingBuild, ready } = useOtaBranchSurfingState();
  return <span data-testid="probe">{`${String(surfingBuild)}/${String(ready)}`}</span>;
}

describe('useOtaBranchSurfingState', () => {
  it('re-renders consumers when the root layout publishes', () => {
    render(<SurfingStateProbe />);
    expect(screen.getByTestId('probe').textContent).toBe('false/false');

    act(() => setOtaBranchSurfingState({ surfingBuild: true, ready: false }));
    expect(screen.getByTestId('probe').textContent).toBe('true/false');

    act(() => setOtaBranchSurfingState({ surfingBuild: true, ready: true }));
    expect(screen.getByTestId('probe').textContent).toBe('true/true');
  });

  it('reads a value published before the consumer mounted', () => {
    // The gate mounts inside the provider tree, well after the root layout's
    // effect has run — a store that only pushed changes would leave it blind.
    setOtaBranchSurfingState({ surfingBuild: true, ready: true });
    render(<SurfingStateProbe />);
    expect(screen.getByTestId('probe').textContent).toBe('true/true');
  });
});
