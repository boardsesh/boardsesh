// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, useRef, type RefObject } from 'react';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';

// SETTLE_MS resolves from Platform.OS — pin it to iOS (550ms) for deterministic timers.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import {
  SheetPresentationProvider,
  dismissManagedSheetAndWait,
  useSheetPresentation,
  useManagedSheet,
  type SheetCoordinator,
} from '../sheet-presentation-provider';

const SETTLE_MS = 550;

let coordinator: SheetCoordinator;
function Capture() {
  coordinator = useSheetPresentation();
  return null;
}

function makeSheet() {
  return { present: vi.fn(), dismiss: vi.fn(), onFullyDismissed: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('__DEV__', false);
  render(createElement(SheetPresentationProvider, null, createElement(Capture)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SheetPresentationProvider coordinator', () => {
  it('treats a missing managed-sheet handle as already dismissed', async () => {
    await expect(dismissManagedSheetAndWait(null)).resolves.toEqual({ status: 'dismissed' });
  });

  it('presents an opened sheet and reports it presented after the settle window', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });

    coordinator.setDesiredOpen('a', true);
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(coordinator.isBusy('root')).toBe(true);
    expect(coordinator.isPresented('a')).toBe(false); // still presenting

    vi.advanceTimersByTime(SETTLE_MS);
    expect(coordinator.isPresented('a')).toBe(true);
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('waits for the existing presentation ceiling without closing or presenting the sheet again', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    const first = coordinator.waitForPresentation('a');
    const second = coordinator.waitForPresentation('a');
    const settled = vi.fn();
    void first.then(settled);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(a.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 'presented' }, { status: 'presented' }]);
    await expect(coordinator.waitForPresentation('a')).resolves.toEqual({ status: 'presented' });
    expect(a.dismiss).not.toHaveBeenCalled();
    expect(coordinator.isPresented('a')).toBe(true);
  });

  it('waits through a preceding native dismiss and the requested sheet’s presentation settle', async () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('b', true);
    const result = coordinator.waitForPresentation('b');
    const settled = vi.fn();
    void result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    expect(b.present).not.toHaveBeenCalled();
    coordinator.notifyFullyDismissed('a');
    expect(b.present).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(result).resolves.toEqual({ status: 'presented' });
    expect(b.dismiss).not.toHaveBeenCalled();
  });

  it('aborts presentation waiters immediately when the desired sheet closes', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    const result = coordinator.waitForPresentation('a');
    coordinator.setDesiredOpen('a', false);
    await expect(result).resolves.toEqual({ status: 'aborted' });
    expect(a.dismiss).not.toHaveBeenCalled(); // the present still cannot be interrupted
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.dismiss).toHaveBeenCalledTimes(1);
  });

  it('aborts a presentation wait when dismissAndWait cancels the parent request', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    const presentation = coordinator.waitForPresentation('a');
    const dismissal = coordinator.dismissAndWait('a');
    await expect(presentation).resolves.toEqual({ status: 'aborted' });
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.notifyFullyDismissed('a');
    await expect(dismissal).resolves.toEqual({ status: 'dismissed' });
  });

  it('aborts a presentation wait when native closing starts', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    const result = coordinator.waitForPresentation('a');
    coordinator.notifyClosed('a');
    await expect(result).resolves.toEqual({ status: 'aborted' });
  });

  it('aborts the losing parent before its presentation settles when a sibling supersedes it', async () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });
    coordinator.setDesiredOpen('a', true);
    const previous = coordinator.waitForPresentation('a');
    coordinator.setDesiredOpen('b', true);
    const next = coordinator.waitForPresentation('b');
    await expect(previous).resolves.toEqual({ status: 'aborted' });
    expect(a.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.notifyFullyDismissed('a');
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(next).resolves.toEqual({ status: 'presented' });
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    expect(b.dismiss).not.toHaveBeenCalled();
  });

  it('aborts a queued presentation that a newer sibling replaces before it reaches native', async () => {
    const sheets = { a: makeSheet(), b: makeSheet(), c: makeSheet() };
    for (const [id, sheet] of Object.entries(sheets)) coordinator.register({ id, group: 'root', ...sheet });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('b', true);
    const previous = coordinator.waitForPresentation('b');
    coordinator.setDesiredOpen('c', true);
    const next = coordinator.waitForPresentation('c');
    await expect(previous).resolves.toEqual({ status: 'aborted' });
    coordinator.notifyFullyDismissed('a');
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(next).resolves.toEqual({ status: 'presented' });
    expect(sheets.b.present).not.toHaveBeenCalled();
    expect(sheets.b.dismiss).not.toHaveBeenCalled();
  });

  it('aborts the prior request’s waiters when the same host receives a fresh open request', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    const previous = coordinator.waitForPresentation('a');
    coordinator.setDesiredOpen('a', true);
    const next = coordinator.waitForPresentation('a');
    await expect(previous).resolves.toEqual({ status: 'aborted' });
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(next).resolves.toEqual({ status: 'presented' });
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(a.dismiss).not.toHaveBeenCalled();
  });

  it('aborts every presentation waiter when its host unregisters before settling', async () => {
    const a = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    const first = coordinator.waitForPresentation('a');
    const second = coordinator.waitForPresentation('a');
    unregister();
    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 'aborted' }, { status: 'aborted' }]);
    expect(a.dismiss).not.toHaveBeenCalled();
    expect(coordinator.isBusy('root')).toBe(true);
  });

  it('does not open absent or closed hosts just because a caller waits for them', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    await expect(coordinator.waitForPresentation('missing')).resolves.toEqual({ status: 'aborted' });
    await expect(coordinator.waitForPresentation('a')).resolves.toEqual({ status: 'aborted' });
    expect(a.present).not.toHaveBeenCalled();
    expect(a.dismiss).not.toHaveBeenCalled();
  });

  it('keeps presentation waits independent across presenter groups', async () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'queue', ...b });
    coordinator.setDesiredOpen('a', true);
    const result = coordinator.waitForPresentation('a');
    coordinator.setDesiredOpen('b', true);
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(result).resolves.toEqual({ status: 'presented' });
    expect(a.dismiss).not.toHaveBeenCalled();
  });

  it('presents a native child only after its desired parent has fully settled', async () => {
    const parent = makeSheet();
    const child = makeSheet();
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.setDesiredOpen('parent', true);
    coordinator.setDesiredOpen('child', true);
    const childReady = coordinator.waitForPresentation('child');
    expect(child.present).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(child.present).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.present).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('parent')).toBe(true);
    expect(parent.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(childReady).resolves.toEqual({ status: 'presented' });
  });

  it('waits for a child present and dismiss before starting an imperative parent dismiss', async () => {
    const parent = makeSheet();
    const child = { ...makeSheet(), onDisplaced: vi.fn() };
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('child', true);
    const childReady = coordinator.waitForPresentation('child');
    const parentDismissed = coordinator.dismissAndWait('parent');
    await expect(childReady).resolves.toEqual({ status: 'aborted' });
    expect(child.dismiss).not.toHaveBeenCalled();
    expect(parent.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(child.dismiss).toHaveBeenCalledTimes(1);
    expect(parent.dismiss).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(child.onDisplaced).toHaveBeenCalledTimes(1);
    coordinator.notifyFullyDismissed('child');
    expect(parent.dismiss).toHaveBeenCalledTimes(1);
    coordinator.notifyFullyDismissed('parent');
    await expect(parentDismissed).resolves.toEqual({ status: 'dismissed' });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(child.present).toHaveBeenCalledTimes(1); // a cancelled child never resumes by itself
  });

  it('dismisses a presented child before its parent is displaced by a root sibling', async () => {
    const parent = { ...makeSheet(), onDisplaced: vi.fn() };
    const child = { ...makeSheet(), onDisplaced: vi.fn() };
    const replacement = makeSheet();
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'replacement', group: 'root', ...replacement });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('child', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('replacement', true);
    expect(child.dismiss).toHaveBeenCalledTimes(1);
    expect(parent.dismiss).not.toHaveBeenCalled();
    expect(replacement.present).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(child.onDisplaced).toHaveBeenCalledTimes(1);
    expect(parent.onDisplaced).not.toHaveBeenCalled();
    coordinator.notifyFullyDismissed('child');
    expect(parent.dismiss).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(parent.onDisplaced).toHaveBeenCalledTimes(1);
    coordinator.notifyFullyDismissed('parent');
    expect(replacement.present).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('replacement', false);
    coordinator.notifyFullyDismissed('replacement');
    expect(parent.present).toHaveBeenCalledTimes(1);
    expect(child.present).toHaveBeenCalledTimes(1);
    expect(child.onDisplaced).toHaveBeenCalledTimes(1);
  });

  it('leaves the parent open when its child saves or closes independently', async () => {
    const parent = makeSheet();
    const child = { ...makeSheet(), onDisplaced: vi.fn() };
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('child', true);
    vi.advanceTimersByTime(SETTLE_MS);
    const saved = coordinator.dismissAndWait('child');
    coordinator.notifyFullyDismissed('child');
    await expect(saved).resolves.toEqual({ status: 'dismissed' });
    expect(parent.dismiss).not.toHaveBeenCalled();
    expect(coordinator.isPresented('parent')).toBe(true);
    expect(child.onDisplaced).not.toHaveBeenCalled();
    coordinator.setDesiredOpen('child', true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(child.present).toHaveBeenCalledTimes(2);
  });

  it('keeps the root guarded through an unregistered parent and its child teardown', async () => {
    const parent = makeSheet();
    const child = { ...makeSheet(), onDisplaced: vi.fn() };
    const replacement = makeSheet();
    const unregisterParent = coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.register({ id: 'replacement', group: 'root', ...replacement });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('child', true);
    const pendingChild = coordinator.waitForPresentation('child');
    unregisterParent();
    coordinator.setDesiredOpen('replacement', true);
    await expect(pendingChild).resolves.toEqual({ status: 'aborted' });
    vi.advanceTimersByTime(SETTLE_MS); // child present settles; parent native teardown ceiling also expires
    expect(child.dismiss).toHaveBeenCalledTimes(1);
    expect(replacement.present).not.toHaveBeenCalled();
    expect(coordinator.isBusy('root')).toBe(true);
    coordinator.notifyFullyDismissed('child');
    expect(replacement.present).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(child.onDisplaced).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(parent.present).toHaveBeenCalledTimes(1);
    expect(child.present).toHaveBeenCalledTimes(1);
  });

  it('does not present an orphan or a child requested after an already-resolved parent wait races a close', async () => {
    const parent = makeSheet();
    const child = { ...makeSheet(), onDisplaced: vi.fn() };
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    const staleContinuation = coordinator.waitForPresentation('parent').then((result) => {
      if (result.status === 'presented') coordinator.setDesiredOpen('child', true);
    });
    coordinator.setDesiredOpen('parent', false);
    await staleContinuation;
    await expect(coordinator.waitForPresentation('child')).resolves.toEqual({ status: 'aborted' });
    expect(child.present).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(child.onDisplaced).toHaveBeenCalledTimes(1);
    const orphan = makeSheet();
    coordinator.register({ id: 'orphan', group: 'orphan', parentId: 'missing', ...orphan });
    coordinator.setDesiredOpen('orphan', true);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(orphan.present).not.toHaveBeenCalled();
    await expect(coordinator.waitForPresentation('orphan')).resolves.toEqual({ status: 'aborted' });
  });

  it('closes descendants from the deepest native presenter outward', async () => {
    const parent = makeSheet();
    const child = makeSheet();
    const grandchild = makeSheet();
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.register({ id: 'grandchild', group: 'tick', parentId: 'child', ...grandchild });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('child', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('grandchild', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('parent', false);
    expect(grandchild.dismiss).toHaveBeenCalledTimes(1);
    expect(child.dismiss).not.toHaveBeenCalled();
    expect(parent.dismiss).not.toHaveBeenCalled();
    coordinator.notifyFullyDismissed('grandchild');
    expect(child.dismiss).toHaveBeenCalledTimes(1);
    expect(parent.dismiss).not.toHaveBeenCalled();
    coordinator.notifyFullyDismissed('child');
    expect(parent.dismiss).toHaveBeenCalledTimes(1);
    coordinator.notifyFullyDismissed('parent');
    expect(coordinator.isBusy('root')).toBe(false);
    await Promise.resolve();
  });

  it('retains child ancestry through unmount teardown without duplicate close callbacks', async () => {
    const parent = makeSheet();
    const child = { ...makeSheet(), onDisplaced: vi.fn() };
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    const unregisterChild = coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('child', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('parent', false);
    await Promise.resolve();
    expect(child.onDisplaced).toHaveBeenCalledTimes(1);
    unregisterChild();
    expect(parent.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(parent.dismiss).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(child.onDisplaced).toHaveBeenCalledTimes(1);
    expect(child.dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not release a natively closed parent until its child has also settled', () => {
    const parent = makeSheet();
    const child = makeSheet();
    const replacement = makeSheet();
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.register({ id: 'child', group: 'queue', parentId: 'parent', ...child });
    coordinator.register({ id: 'replacement', group: 'root', ...replacement });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.setDesiredOpen('child', true);
    vi.advanceTimersByTime(SETTLE_MS);
    coordinator.notifyClosed('parent');
    coordinator.notifyFullyDismissed('parent');
    coordinator.setDesiredOpen('replacement', true);
    expect(child.dismiss).toHaveBeenCalledTimes(1);
    expect(replacement.present).not.toHaveBeenCalled();
    coordinator.notifyFullyDismissed('child');
    expect(replacement.present).toHaveBeenCalledTimes(1);
  });

  it('prunes unique child groups after teardown while preserving their in-flight guard', () => {
    const parent = makeSheet();
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.setDesiredOpen('parent', true);
    vi.advanceTimersByTime(SETTLE_MS);
    const deleteGroup = vi.spyOn(Map.prototype, 'delete');
    try {
      for (let cycle = 0; cycle < 25; cycle += 1) {
        const group = `queue-tick-cleanup-${cycle}`;
        const child = makeSheet();
        const unregister = coordinator.register({ id: `child-${cycle}`, group, parentId: 'parent', ...child });
        coordinator.setDesiredOpen(`child-${cycle}`, true);
        vi.advanceTimersByTime(SETTLE_MS);
        unregister();
        expect(deleteGroup).not.toHaveBeenCalledWith(group);
        expect(coordinator.isBusy(group)).toBe(true);
        vi.advanceTimersByTime(SETTLE_MS);
        expect(deleteGroup).toHaveBeenCalledWith(group);
        expect(coordinator.isBusy(group)).toBe(false);
      }
      expect(
        deleteGroup.mock.calls.filter(([key]) => typeof key === 'string' && key.startsWith('queue-tick-cleanup-')),
      ).toHaveLength(25);
      expect(parent.dismiss).not.toHaveBeenCalled();
    } finally {
      deleteGroup.mockRestore();
    }
  });

  it('serializes a sheet-over-sheet handoff: dismiss A, settle, then present B', () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS); // a presented

    // Request B while A is up — must not present B yet.
    coordinator.setDesiredOpen('b', true);
    expect(b.present).not.toHaveBeenCalled();
    // The pump immediately dismisses A (the dismiss half of the handoff).
    expect(a.dismiss).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // A dismiss settles
    expect(b.present).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);

    vi.advanceTimersByTime(SETTLE_MS); // B present settles
    expect(coordinator.isPresented('b')).toBe(true);
  });

  it('never presents two transitions at once (B waits while A is presenting)', () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    coordinator.setDesiredOpen('b', true); // while A's present is still in flight
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(b.present).not.toHaveBeenCalled();
    expect(a.dismiss).not.toHaveBeenCalled(); // can't dismiss mid-present either
  });

  it('early-resolves a dismiss via notifyFullyDismissed before the ceiling timer', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    coordinator.setDesiredOpen('a', false);
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    expect(coordinator.isBusy('root')).toBe(true);

    coordinator.notifyFullyDismissed('a'); // native settle arrives early
    expect(a.onFullyDismissed).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);
    expect(coordinator.isBusy('root')).toBe(false);

    // The ceiling timer is cleared — advancing must not double-fire.
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.onFullyDismissed).toHaveBeenCalledTimes(1);
  });

  it('dismissAndWait follows a present-in-flight through its later dismiss settle', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);

    const settled = vi.fn();
    const resultPromise = coordinator.dismissAndWait('a');
    void resultPromise.then(settled);
    expect(a.dismiss).not.toHaveBeenCalled(); // presenting cannot be interrupted

    vi.advanceTimersByTime(SETTLE_MS); // present settles, then dismiss starts
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    coordinator.notifyFullyDismissed('a');
    await expect(resultPromise).resolves.toEqual({ status: 'dismissed' });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('aborts a present-in-flight dismiss waiter when a fresh open supersedes it', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);

    const resultPromise = coordinator.dismissAndWait('a');
    coordinator.setDesiredOpen('a', true);

    await expect(resultPromise).resolves.toEqual({ status: 'aborted' });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.dismiss).not.toHaveBeenCalled();
    expect(coordinator.isPresented('a')).toBe(true);
  });

  it('dismissAndWait uses the existing platform ceiling and resolves duplicate waiters together', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    const first = coordinator.dismissAndWait('a');
    const second = coordinator.dismissAndWait('a');
    expect(a.dismiss).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS);
    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 'dismissed' }, { status: 'dismissed' }]);
  });

  it('dismissAndWait resolves aborted when the registered Host tears down before settle', async () => {
    const a = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    const resultPromise = coordinator.dismissAndWait('a');
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    unregister();

    await expect(resultPromise).resolves.toEqual({ status: 'aborted' });
    expect(coordinator.isBusy('root')).toBe(true); // teardown still keeps the group guarded
  });

  it('dismissAndWait resolves immediately when the sheet is already absent', async () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });

    await expect(coordinator.dismissAndWait('a')).resolves.toEqual({ status: 'dismissed' });
    expect(a.dismiss).not.toHaveBeenCalled();
  });

  it('warns (dev) when an iOS coordinator-driven dismiss settles via the ceiling timer', () => {
    vi.stubGlobal('__DEV__', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    coordinator.setDesiredOpen('a', false); // coordinator drives the dismiss (expectNative on iOS)
    vi.advanceTimersByTime(SETTLE_MS); // no native onDismiss arrived → ceiling wins
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('outran the ceiling');
    warn.mockRestore();
  });

  it('does not warn when an unmounted-while-presented sheet settles via the ceiling (no native signal expected)', () => {
    vi.stubGlobal('__DEV__', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    unregister(); // registration gone → notifyFullyDismissed can never match; ceiling is the only settle
    vi.advanceTimersByTime(SETTLE_MS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('opens a settle window on a user-initiated close (notifyClosed) and fires onFullyDismissed at settle', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    // User pan-down: the native sheet is already animating out on its own.
    coordinator.notifyClosed('a');
    expect(a.dismiss).not.toHaveBeenCalled(); // coordinator didn't drive it
    expect(coordinator.isBusy('root')).toBe(true);
    expect(a.onFullyDismissed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.onFullyDismissed).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);
  });

  it('warns (dev) when an iOS user-initiated close (notifyClosed) settles via the ceiling timer', () => {
    vi.stubGlobal('__DEV__', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    coordinator.notifyClosed('a'); // pan-down opens a settle window (expectNative on iOS)
    vi.advanceTimersByTime(SETTLE_MS); // native onDismiss never arrived → ceiling wins
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('outran the ceiling');
    warn.mockRestore();
  });

  it('is a no-op to close a sheet that is not presented', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', false);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.present).not.toHaveBeenCalled();
    expect(a.dismiss).not.toHaveBeenCalled();
  });

  it('coalesces a rapid open→close→open into a single settled-open with no dismiss', () => {
    const a = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });

    coordinator.setDesiredOpen('a', true); // present starts
    coordinator.setDesiredOpen('a', false); // desired flips while presenting
    coordinator.setDesiredOpen('a', true); // ...and back

    vi.advanceTimersByTime(SETTLE_MS); // present settles; pump sees want === have
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(a.dismiss).not.toHaveBeenCalled();
    expect(coordinator.isPresented('a')).toBe(true);
  });

  it('does not serialize across independent presenter groups', () => {
    const a = makeSheet();
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'drawer', ...b });

    coordinator.setDesiredOpen('a', true);
    coordinator.setDesiredOpen('b', true);
    // Different groups → both present immediately, no waiting.
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(b.present).toHaveBeenCalledTimes(1);
  });

  it('opens a settle window when a presented sheet unmounts (no coordinator dismiss), then frees the group', () => {
    const a = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(coordinator.isPresented('a')).toBe(true);

    // Parent unmounts the sheet while it's presented (e.g. a present-on-mount
    // sheet dismissed by removing it). Its native teardown is still animating, so
    // the group must stay busy — not be reported idle immediately (H1).
    unregister();
    expect(coordinator.isPresented('a')).toBe(false);
    expect(coordinator.isBusy('root')).toBe(true);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('holds a same-group present until an unmounted-while-presented sheet has settled (H1)', () => {
    const a = makeSheet();
    const b = makeSheet();
    const unregister = coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });
    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS);

    unregister(); // A unmounts while presented → settle window opens
    coordinator.setDesiredOpen('b', true);
    expect(b.present).not.toHaveBeenCalled(); // must wait out A's native teardown

    vi.advanceTimersByTime(SETTLE_MS);
    expect(b.present).toHaveBeenCalledTimes(1);
  });

  // The phantom-sheet bug: a sheet displaced by a handoff used to keep its
  // desired-open flag, so it re-presented "at random" when the displacing sheet
  // closed (tick sheet reopening after the BLE device picker went away).
  it('closes a displaced sheet: onDisplaced fires and it never re-presents after the displacer closes', async () => {
    const a = { ...makeSheet(), onDisplaced: vi.fn() };
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS); // a presented

    coordinator.setDesiredOpen('b', true); // displaces a
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // onDisplaced is delivered via microtask
    expect(a.onDisplaced).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // a's dismiss settles → b presents
    vi.advanceTimersByTime(SETTLE_MS); // b's present settles
    expect(coordinator.isPresented('b')).toBe(true);

    coordinator.setDesiredOpen('b', false); // displacer goes away
    vi.advanceTimersByTime(SETTLE_MS);

    // The displaced sheet was closed, not suspended: no resurrection.
    expect(a.present).toHaveBeenCalledTimes(1);
    expect(coordinator.isPresented('a')).toBe(false);
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('displaces a sheet whose present is still in flight when the displacer wins the group', async () => {
    const a = { ...makeSheet(), onDisplaced: vi.fn() };
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    coordinator.setDesiredOpen('b', true); // while a's present is in flight
    await Promise.resolve();
    expect(a.onDisplaced).not.toHaveBeenCalled(); // nothing until a's present settles

    vi.advanceTimersByTime(SETTLE_MS); // a's present settles → pump displaces it
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(a.onDisplaced).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // a's dismiss settles → b presents
    vi.advanceTimersByTime(SETTLE_MS); // b's present settles
    coordinator.setDesiredOpen('b', false);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(a.present).toHaveBeenCalledTimes(1); // no resurrection here either
    expect(coordinator.isBusy('root')).toBe(false);
  });

  it('does not fire onDisplaced for a handoff whose first sheet already closed itself', async () => {
    const a = { ...makeSheet(), onDisplaced: vi.fn() };
    const b = makeSheet();
    coordinator.register({ id: 'a', group: 'root', ...a });
    coordinator.register({ id: 'b', group: 'root', ...b });

    coordinator.setDesiredOpen('a', true);
    vi.advanceTimersByTime(SETTLE_MS); // a presented

    // The climb-actions pattern: the action closes its own sheet and opens the
    // next one. The parent drove the close — no displacement notification.
    coordinator.setDesiredOpen('a', false);
    coordinator.setDesiredOpen('b', true);
    await Promise.resolve();
    expect(a.onDisplaced).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SETTLE_MS); // a's dismiss settles
    expect(b.present).toHaveBeenCalledTimes(1);
  });
});

// The bridge consumers actually use. The selfDismissRef gate here is what tells a
// user pan-down apart from a coordinator-driven dismiss — a misclassification is
// exactly what would double-dismiss / present-over-dismiss and freeze the app.
type SheetApiMock = Record<
  'present' | 'dismiss' | 'snapToIndex' | 'snapToPosition' | 'expand' | 'collapse' | 'close' | 'forceClose',
  ReturnType<typeof vi.fn>
>;

function makeSheetApi(): SheetApiMock {
  return {
    present: vi.fn(),
    dismiss: vi.fn(),
    snapToIndex: vi.fn(),
    snapToPosition: vi.fn(),
    expand: vi.fn(),
    collapse: vi.fn(),
    close: vi.fn(),
    forceClose: vi.fn(),
  };
}

let managed: ReturnType<typeof useManagedSheet> | null = null;
let sheetApi: SheetApiMock;

function ManagedHarness({
  open,
  onClose,
  parentId,
  group,
}: {
  open?: boolean;
  onClose?: () => void;
  parentId?: string;
  group?: string;
}) {
  const sheetRef = useRef(sheetApi as unknown as BottomSheetMethods);
  managed = useManagedSheet({
    open,
    sheetRef: sheetRef as RefObject<BottomSheetMethods | null>,
    onClose,
    parentId,
    group,
  });
  return null;
}

describe('useManagedSheet bridge', () => {
  beforeEach(() => {
    managed = null;
    sheetApi = makeSheetApi();
  });

  it('presents on open (snapToIndex 0) and dismisses via the coordinator handle', () => {
    render(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true })));
    expect(sheetApi.snapToIndex).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(SETTLE_MS);
    act(() => {
      managed?.handle.dismiss();
    });
    expect(sheetApi.dismiss).toHaveBeenCalledTimes(1);
  });

  it('forwards dismissAndWait through the managed handle', async () => {
    render(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true })));
    vi.advanceTimersByTime(SETTLE_MS);

    if (!managed) throw new Error('managed sheet did not mount');
    const resultPromise = managed.handle.dismissAndWait();
    expect(sheetApi.dismiss).toHaveBeenCalledTimes(1);
    act(() => managed?.onFullyDismissed());

    await expect(resultPromise).resolves.toEqual({ status: 'dismissed' });
  });

  it('exposes a stable waitForPresentation callback outside the imperative handle', async () => {
    const { rerender } = render(
      createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true })),
    );
    if (!managed) throw new Error('managed sheet did not mount');
    const waitForPresentation = managed.waitForPresentation;
    const sheetId = managed.sheetId;
    expect(typeof sheetId).toBe('string');
    const settled = vi.fn();
    const result = waitForPresentation();
    void result.then(settled);
    act(() => managed?.onChange(0));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled(); // a detent callback is not native animation completion
    rerender(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true })));
    expect(managed.waitForPresentation).toBe(waitForPresentation);
    expect(managed.sheetId).toBe(sheetId);
    expect(managed.handle).not.toHaveProperty('waitForPresentation');
    vi.advanceTimersByTime(SETTLE_MS);
    await expect(result).resolves.toEqual({ status: 'presented' });
    expect(sheetApi.dismiss).not.toHaveBeenCalled();
  });

  it('registers a managed native child under its explicit parent id', async () => {
    function Harness({ open }: { open: boolean }) {
      return createElement(
        SheetPresentationProvider,
        null,
        createElement(Capture),
        createElement(ManagedHarness, { open, parentId: 'parent', group: 'queue-tick' }),
      );
    }
    const { rerender } = render(createElement(Harness, { open: false }));
    const parent = makeSheet();
    coordinator.register({ id: 'parent', group: 'root', ...parent });
    coordinator.setDesiredOpen('parent', true);
    rerender(createElement(Harness, { open: true }));
    expect(sheetApi.snapToIndex).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(sheetApi.snapToIndex).toHaveBeenCalledTimes(1);
    expect(parent.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    if (!managed) throw new Error('managed child did not mount');
    const ready = managed.waitForPresentation();
    await expect(ready).resolves.toEqual({ status: 'presented' });
  });

  it('a user pan-down (onChange(-1)) fires onClose', () => {
    const onClose = vi.fn();
    render(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true, onClose })));
    vi.advanceTimersByTime(SETTLE_MS);
    act(() => {
      managed?.onChange(-1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a coordinator-driven dismiss does NOT fire onClose (selfDismissRef gate)', () => {
    const onClose = vi.fn();
    render(createElement(SheetPresentationProvider, null, createElement(ManagedHarness, { open: true, onClose })));
    vi.advanceTimersByTime(SETTLE_MS);
    act(() => {
      managed?.handle.dismiss(); // sets selfDismissRef + drives the native dismiss
    });
    act(() => {
      managed?.onChange(-1); // the synchronous native callback that dismiss() triggers
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a displacement fires onClose exactly once so the controlled parent clears its open state', async () => {
    const onCloseA = vi.fn();
    let managedA: ReturnType<typeof useManagedSheet> | null = null;
    let managedB: ReturnType<typeof useManagedSheet> | null = null;
    const sheetApiA = makeSheetApi();
    const sheetApiB = makeSheetApi();

    function SheetA({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApiA as unknown as BottomSheetMethods);
      managedA = useManagedSheet({
        open,
        sheetRef: sheetRef as RefObject<BottomSheetMethods | null>,
        onClose: onCloseA,
      });
      return null;
    }
    function SheetB({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApiB as unknown as BottomSheetMethods);
      managedB = useManagedSheet({ open, sheetRef: sheetRef as RefObject<BottomSheetMethods | null> });
      return null;
    }
    function Harness({ openB }: { openB: boolean }) {
      return createElement(
        SheetPresentationProvider,
        null,
        createElement(SheetA, { open: true }),
        createElement(SheetB, { open: openB }),
      );
    }

    const { rerender } = render(createElement(Harness, { openB: false }));
    vi.advanceTimersByTime(SETTLE_MS); // A presented

    rerender(createElement(Harness, { openB: true })); // B displaces A
    await act(async () => {}); // flush the onDisplaced microtask
    // The parent is told A is closed (this is what clears e.g. isTickBarActive)...
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(sheetApiA.dismiss).toHaveBeenCalledTimes(1);

    // ...and the native close callback the dismiss triggers is still classified
    // as coordinator-driven, so onClose does not fire a second time.
    act(() => {
      managedA?.onChange(-1);
    });
    expect(onCloseA).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SETTLE_MS); // A dismiss settles
    expect(sheetApiB.snapToIndex).toHaveBeenCalledWith(0); // B presents
    vi.advanceTimersByTime(SETTLE_MS); // B present settles

    // B closes → A must NOT come back.
    act(() => {
      managedB?.handle.dismiss();
    });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(sheetApiA.snapToIndex).toHaveBeenCalledTimes(1); // only the original present
  });

  // The BLE picker while it searches for the saved board (#5658): displaced, it
  // must not read as the climber closing it, and it re-presents when its parent
  // asks for it again.
  it('fires onDisplaced instead of onClose when a sheet supplies it, and re-presents when reopened', async () => {
    const onCloseA = vi.fn();
    const onDisplacedA = vi.fn();
    const sheetApiA = makeSheetApi();
    const sheetApiB = makeSheetApi();

    function SheetA({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApiA as unknown as BottomSheetMethods);
      useManagedSheet({
        open,
        sheetRef: sheetRef as RefObject<BottomSheetMethods | null>,
        onClose: onCloseA,
        onDisplaced: onDisplacedA,
      });
      return null;
    }
    function SheetB({ open }: { open: boolean }) {
      const sheetRef = useRef(sheetApiB as unknown as BottomSheetMethods);
      useManagedSheet({ open, sheetRef: sheetRef as RefObject<BottomSheetMethods | null> });
      return null;
    }
    function Harness({ openA, openB }: { openA: boolean; openB: boolean }) {
      return createElement(
        SheetPresentationProvider,
        null,
        createElement(SheetA, { open: openA }),
        createElement(SheetB, { open: openB }),
      );
    }

    const { rerender } = render(createElement(Harness, { openA: true, openB: false }));
    vi.advanceTimersByTime(SETTLE_MS); // A presented

    rerender(createElement(Harness, { openA: true, openB: true })); // B displaces A
    await act(async () => {});
    expect(onDisplacedA).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();

    // The parent hides A in response (the picker keeps searching out of sight).
    rerender(createElement(Harness, { openA: false, openB: true }));
    vi.advanceTimersByTime(SETTLE_MS); // A dismiss settles
    vi.advanceTimersByTime(SETTLE_MS); // B present settles
    expect(sheetApiB.snapToIndex).toHaveBeenCalledWith(0);

    // The parent asks for A again (the picker's list starts): it comes back.
    rerender(createElement(Harness, { openA: true, openB: true }));
    vi.advanceTimersByTime(SETTLE_MS); // B displaced, dismiss settles
    expect(sheetApiA.snapToIndex).toHaveBeenCalledTimes(2);
    expect(onCloseA).not.toHaveBeenCalled();
  });
});
