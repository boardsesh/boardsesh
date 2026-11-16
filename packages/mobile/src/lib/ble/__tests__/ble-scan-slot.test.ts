import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimBleScan, currentBleScanOwner, noteBleScanStarted, releaseBleScan } from '../ble-scan-slot';
afterEach(() => {
  const owner = currentBleScanOwner();
  if (owner) releaseBleScan(owner);
});
describe('shared BLE scan ownership', () => {
  it('refuses a second claimant and only releases the current scan', () => {
    const timer = Symbol('timer');
    const wall = Symbol('wall');
    expect(claimBleScan(timer)).toBe(true);
    expect(claimBleScan(wall)).toBe(false);
    expect(releaseBleScan(wall)).toBe(false);
    expect(currentBleScanOwner()).toBe(timer);
    expect(releaseBleScan(timer)).toBe(true);
    expect(claimBleScan(wall)).toBe(true);
  });
  it('late cleanup from a completed timer connect cannot stop a newer scan', () => {
    const timer = Symbol('timer');
    const wall = Symbol('wall');
    claimBleScan(timer);
    expect(releaseBleScan(timer)).toBe(true);
    claimBleScan(wall);
    expect(releaseBleScan(timer)).toBe(false);
    expect(currentBleScanOwner()).toBe(wall);
  });
  it('foreground board picker replacement owns cleanup even when an old timeout fires', () => {
    const wall = Symbol('wall');
    const picker = Symbol('picker');
    claimBleScan(wall);
    noteBleScanStarted(picker);
    expect(releaseBleScan(wall)).toBe(false);
    expect(currentBleScanOwner()).toBe(picker);
  });
});

// The board picker's in-range slot scans without being asked, so its claim
// gives way to every other scan instead of making it fail as busy.
describe('a pre-emptible scan claim', () => {
  it('hands the slot to a plain claim, telling the old owner while the new one already holds it', () => {
    const picker = Symbol('picker');
    const restTimer = Symbol('rest-timer');
    const ownerWhenTold: Array<symbol | null> = [];
    const onPreempted = vi.fn(() => ownerWhenTold.push(currentBleScanOwner()));
    expect(claimBleScan(picker, { preemptible: true, onPreempted })).toBe(true);

    expect(claimBleScan(restTimer)).toBe(true);

    expect(onPreempted).toHaveBeenCalledOnce();
    expect(ownerWhenTold).toEqual([restTimer]);
    expect(currentBleScanOwner()).toBe(restTimer);
    // The picker's own late cleanup cannot stop the rest timer's scan.
    expect(releaseBleScan(picker)).toBe(false);
    expect(currentBleScanOwner()).toBe(restTimer);
  });

  it('hands the slot to a scan that takes it unconditionally (the sheet, an Android connect)', () => {
    const onPreempted = vi.fn();
    claimBleScan(Symbol('picker'), { preemptible: true, onPreempted });
    const connect = Symbol('connect');
    noteBleScanStarted(connect);
    expect(onPreempted).toHaveBeenCalledOnce();
    expect(currentBleScanOwner()).toBe(connect);
  });

  it('never takes a slot someone holds, and two pre-emptible scans never take it from each other', () => {
    const restTimer = Symbol('rest-timer');
    claimBleScan(restTimer);
    expect(claimBleScan(Symbol('picker'), { preemptible: true, onPreempted: vi.fn() })).toBe(false);
    expect(currentBleScanOwner()).toBe(restTimer);
    releaseBleScan(restTimer);

    const firstPicker = Symbol('first-picker');
    const firstPreempted = vi.fn();
    claimBleScan(firstPicker, { preemptible: true, onPreempted: firstPreempted });
    expect(claimBleScan(Symbol('second-picker'), { preemptible: true, onPreempted: vi.fn() })).toBe(false);
    expect(firstPreempted).not.toHaveBeenCalled();
    expect(currentBleScanOwner()).toBe(firstPicker);
  });

  it('tells nobody once the pre-emptible scan let go, or when it claims again itself', () => {
    const picker = Symbol('picker');
    const onPreempted = vi.fn();
    claimBleScan(picker, { preemptible: true, onPreempted });
    expect(claimBleScan(picker, { preemptible: true, onPreempted })).toBe(true);
    releaseBleScan(picker);
    claimBleScan(Symbol('wled'));
    expect(onPreempted).not.toHaveBeenCalled();
  });

  it('still hands over when the old owner throws', () => {
    claimBleScan(Symbol('picker'), {
      preemptible: true,
      onPreempted: () => {
        throw new Error('cleanup failed');
      },
    });
    const recon = Symbol('recon');
    expect(claimBleScan(recon)).toBe(true);
    expect(currentBleScanOwner()).toBe(recon);
  });

  it('is plain again once a plain claim holds it: the next claimant is refused', () => {
    claimBleScan(Symbol('picker'), { preemptible: true, onPreempted: vi.fn() });
    claimBleScan(Symbol('rest-timer'));
    expect(claimBleScan(Symbol('wled'))).toBe(false);
  });
});
