// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// The real settings store over an in-memory MMKV: one record, read the way a
// relaunch would read it back.
const mockStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => mockStorage.set(key, value),
    remove: (key: string) => mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  }),
}));
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../analytics', () => ({ track: trackMock }));

import { resetAllSettings } from '../../settings/hooks';
import {
  LOCATION_ASK_SNOOZE_MS,
  isLocationAskSnoozed,
  readLocationAskSnoozed,
  shouldOfferLocationAsk,
  snoozeLocationAsk,
  trackLocationAskAnswered,
  trackLocationAskShown,
  useLocationAskSnoozed,
} from '../location-ask';

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  resetAllSettings();
  trackMock.mockClear();
  vi.useRealTimers();
});

describe('isLocationAskSnoozed', () => {
  it('is 14 days', () => {
    expect(LOCATION_ASK_SNOOZE_MS).toBe(14 * DAY);
  });

  it.each([
    ['never snoozed', null, false],
    ['a bad record', 'soon', false],
    ['not a number', Number.NaN, false],
    ['a day in', NOW + 13 * DAY, true],
    ['the last millisecond', NOW + 1, true],
    ['the moment it runs out', NOW, false],
    ['a day past', NOW - DAY, false],
    // The clock went backwards since: never a snooze longer than 14 days.
    ['further out than one snooze reaches', NOW + 15 * DAY, false],
  ])('%s', (_label, snoozedUntil, expected) => {
    expect(isLocationAskSnoozed(snoozedUntil, NOW)).toBe(expected);
  });
});

describe('shouldOfferLocationAsk', () => {
  it.each([
    ['ask', false, true],
    ['blocked', false, true],
    ['ask', true, false],
    ['blocked', true, false],
    ['granted', false, false],
    ['unknown', false, false],
  ] as const)('%s, snoozed %s → %s', (permission, snoozed, expected) => {
    expect(shouldOfferLocationAsk(permission, snoozed)).toBe(expected);
  });
});

describe('the shared snooze', () => {
  it('holds for 14 days from "Not now", then lapses', () => {
    snoozeLocationAsk(NOW);
    expect(readLocationAskSnoozed(NOW)).toBe(true);
    expect(readLocationAskSnoozed(NOW + 14 * DAY - 1)).toBe(true);
    expect(readLocationAskSnoozed(NOW + 14 * DAY)).toBe(false);
  });

  // A "Not now" on the gym map hides the picker's card, already on screen.
  it('quiets every mounted surface at once', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const picker = renderHook(() => useLocationAskSnoozed());
    const gymMap = renderHook(() => useLocationAskSnoozed());
    expect(picker.result.current).toBe(false);
    expect(gymMap.result.current).toBe(false);

    act(() => snoozeLocationAsk());

    expect(picker.result.current).toBe(true);
    expect(gymMap.result.current).toBe(true);
  });

  it('asks again once it runs out', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    snoozeLocationAsk();
    vi.setSystemTime(NOW + 14 * DAY + 1);
    const { result } = renderHook(() => useLocationAskSnoozed());
    expect(result.current).toBe(false);
  });
});

describe('events', () => {
  it('names the surface and the permission it asked about', () => {
    trackLocationAskShown('gym_finder', 'blocked');
    expect(trackMock).toHaveBeenCalledWith('Location Ask Shown', { surface: 'gym_finder', permission: 'blocked' });
  });

  it('names the answer and the permission it left', () => {
    trackLocationAskAnswered('board_picker', 'allow', 'granted');
    expect(trackMock).toHaveBeenCalledWith('Location Ask Answered', {
      surface: 'board_picker',
      answer: 'allow',
      permission: 'granted',
    });
  });
});
