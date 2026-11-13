import { afterEach, describe, expect, it } from 'vitest';
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
