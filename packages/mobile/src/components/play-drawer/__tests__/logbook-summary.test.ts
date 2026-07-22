import { describe, expect, it } from 'vitest';
import type { LogbookEntry } from '@boardsesh/profile-stats';
import { deriveOtherAngleActivity } from '../logbook-summary';

function entry(angle: number, status: 'send' | 'flash' | 'attempt', climbedAt = '2026-01-01T00:00:00Z'): LogbookEntry {
  return { angle, status, tries: 1, climbed_at: climbedAt, difficulty: null };
}

describe('deriveOtherAngleActivity', () => {
  it('excludes the current angle from both lists', () => {
    const activity = deriveOtherAngleActivity([entry(40, 'send'), entry(40, 'attempt')], 40);
    expect(activity).toEqual({ sentAngles: [], triedAngles: [] });
  });

  it('splits sent angles from tried-only angles', () => {
    const activity = deriveOtherAngleActivity([entry(25, 'send'), entry(55, 'attempt'), entry(30, 'flash')], 40);
    expect(activity.sentAngles).toEqual([25, 30]);
    expect(activity.triedAngles).toEqual([55]);
  });

  it('counts an angle with any send as sent, even alongside attempts', () => {
    const activity = deriveOtherAngleActivity([entry(25, 'attempt'), entry(25, 'send')], 40);
    expect(activity.sentAngles).toEqual([25]);
    expect(activity.triedAngles).toEqual([]);
  });

  it('returns angles ascending', () => {
    const activity = deriveOtherAngleActivity([entry(55, 'send'), entry(25, 'send'), entry(45, 'attempt')], 40);
    expect(activity.sentAngles).toEqual([25, 55]);
    expect(activity.triedAngles).toEqual([45]);
  });

  it('surfaces cross-angle activity even when the current angle is untried', () => {
    const activity = deriveOtherAngleActivity([entry(25, 'send'), entry(30, 'attempt')], 40);
    expect(activity.sentAngles).toEqual([25]);
    expect(activity.triedAngles).toEqual([30]);
  });

  it('is empty when there are no entries', () => {
    expect(deriveOtherAngleActivity([], 40)).toEqual({ sentAngles: [], triedAngles: [] });
  });
});
