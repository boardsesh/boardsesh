// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// The real settings store over an in-memory MMKV, so the hook's writes are the
// ones a relaunch would read back.
const mockStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => mockStorage.set(key, value),
    remove: (key: string) => mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  }),
}));
const links = vi.hoisted(() => ({ allowed: true }));
vi.mock('../donation-links', () => ({ useDonationLinksAllowed: () => links.allowed }));

import { getSetting, resetAllSettings, setSetting } from '../../settings/hooks';
import {
  SUPPORT_CARD_CAMPAIGN,
  planSupportCard,
  readSupportCardRecord,
  supportCardDay,
  useSupportAsksAllowed,
  useSupportCard,
  withSupportCardView,
  type SupportCardInput,
  type SupportCardRecord,
  type UseSupportCardInput,
} from '../support-asks';

const DEC = 11;
const record = (overrides: Partial<SupportCardRecord> = {}): SupportCardRecord => ({
  campaign: SUPPORT_CARD_CAMPAIGN,
  viewDays: [],
  closed: false,
  ...overrides,
});
const input = (overrides: Partial<SupportCardInput> = {}): SupportCardInput => ({
  asksAllowed: true,
  today: new Date(2026, DEC, 2),
  sessionActive: false,
  boardConnected: false,
  record: record(),
  ...overrides,
});

beforeEach(() => {
  mockStorage.clear();
  resetAllSettings();
  links.allowed = true;
});

describe('supportCardDay', () => {
  it.each([
    ['30 Nov 2026', new Date(2026, 10, 30, 23, 59), null],
    ['1 Dec 2026, just after midnight', new Date(2026, DEC, 1, 0, 1), 1],
    ['7 Dec 2026, late evening', new Date(2026, DEC, 7, 23, 59), 7],
    ['8 Dec 2026', new Date(2026, DEC, 8, 0, 0), null],
    ['28 Dec 2026', new Date(2026, DEC, 28, 23, 59), null],
    ['29 Dec 2026', new Date(2026, DEC, 29, 0, 0), 29],
    ['31 Dec 2026, late evening', new Date(2026, DEC, 31, 23, 59), 31],
    ['1 Jan 2027', new Date(2027, 0, 1, 0, 0), null],
    ['3 Dec 2025, a year early', new Date(2025, DEC, 3), null],
    ['3 Dec 2027, a year late', new Date(2027, DEC, 3), null],
  ])('%s', (_label, date, expected) => {
    expect(supportCardDay(date)).toBe(expected);
  });
});

describe('planSupportCard', () => {
  it('shows on a window day and counts the first showing', () => {
    expect(planSupportCard(input())).toEqual({ visible: true, day: 2, countView: true });
  });

  it('stays hidden where support asks are not allowed (store rules or the switch)', () => {
    expect(planSupportCard(input({ asksAllowed: false }))).toEqual({ visible: false });
  });

  it('stays hidden outside the December windows', () => {
    expect(planSupportCard(input({ today: new Date(2026, DEC, 15) }))).toEqual({ visible: false });
  });

  it('never shows during a session', () => {
    expect(planSupportCard(input({ sessionActive: true }))).toEqual({ visible: false });
  });

  it('never shows with a board connected', () => {
    expect(planSupportCard(input({ boardConnected: true }))).toEqual({ visible: false });
  });

  it('stays gone after a tap or a close', () => {
    expect(planSupportCard(input({ record: record({ closed: true }) }))).toEqual({ visible: false });
  });

  it('shows again on a day already counted without counting it twice', () => {
    expect(planSupportCard(input({ record: record({ viewDays: [2] }) }))).toEqual({
      visible: true,
      day: 2,
      countView: false,
    });
  });

  it('allows a second day', () => {
    const plan = planSupportCard(input({ today: new Date(2026, DEC, 30), record: record({ viewDays: [2] }) }));
    expect(plan).toEqual({ visible: true, day: 30, countView: true });
  });

  it('stops after two days on screen, across both windows', () => {
    const plan = planSupportCard(input({ today: new Date(2026, DEC, 29), record: record({ viewDays: [1, 6] }) }));
    expect(plan).toEqual({ visible: false });
  });
});

describe('readSupportCardRecord', () => {
  it('starts fresh with nothing stored', () => {
    expect(readSupportCardRecord(null)).toEqual(record());
  });

  it('starts fresh for another campaign, so an old close never carries over', () => {
    expect(readSupportCardRecord({ campaign: 'dec-2025', viewDays: [1, 2], closed: true })).toEqual(record());
  });

  it('starts fresh on a malformed record', () => {
    expect(readSupportCardRecord({ campaign: SUPPORT_CARD_CAMPAIGN, viewDays: ['1'], closed: false })).toEqual(
      record(),
    );
  });

  it('keeps a valid record for this campaign', () => {
    const stored = record({ viewDays: [3], closed: true });
    expect(readSupportCardRecord(stored)).toEqual(stored);
  });
});

describe('withSupportCardView', () => {
  it('returns the same record for a day already counted', () => {
    const counted = record({ viewDays: [4] });
    expect(withSupportCardView(counted, 4)).toBe(counted);
  });
});

describe('useSupportAsksAllowed', () => {
  it('is on by default where links are allowed', () => {
    const { result } = renderHook(() => useSupportAsksAllowed());
    expect(result.current).toBe(true);
  });

  it('is off where links are not allowed, whatever the switch says', () => {
    links.allowed = false;
    const { result } = renderHook(() => useSupportAsksAllowed());
    expect(result.current).toBe(false);
  });

  it('follows the Show support asks switch', () => {
    const { result } = renderHook(() => useSupportAsksAllowed());
    act(() => setSetting('supportAsksShown', false));
    expect(result.current).toBe(false);
  });
});

describe('useSupportCard', () => {
  const hookInput = (overrides: Partial<UseSupportCardInput> = {}): UseSupportCardInput => ({
    asksAllowed: true,
    today: new Date(2026, DEC, 1),
    sessionActive: false,
    boardConnected: false,
    focused: true,
    ...overrides,
  });

  it('counts a view once per day, and persists it', () => {
    const { rerender } = renderHook((props: UseSupportCardInput) => useSupportCard(props), {
      initialProps: hookInput(),
    });
    rerender(hookInput());
    expect(getSetting('supportCardV1')).toEqual(record({ viewDays: [1] }));
  });

  it('does not count a day while Home is not on screen', () => {
    const { result } = renderHook(() => useSupportCard(hookInput({ focused: false })));
    expect(result.current.visible).toBe(true);
    expect(getSetting('supportCardV1')).toBeNull();
  });

  it('does not count a day it is hidden for a session', () => {
    renderHook(() => useSupportCard(hookInput({ sessionActive: true })));
    expect(getSetting('supportCardV1')).toBeNull();
  });

  it('is gone on the third day after two days on screen', () => {
    const first = renderHook(() => useSupportCard(hookInput({ today: new Date(2026, DEC, 1) })));
    first.unmount();
    const second = renderHook(() => useSupportCard(hookInput({ today: new Date(2026, DEC, 5) })));
    expect(second.result.current.visible).toBe(true);
    second.unmount();

    const third = renderHook(() => useSupportCard(hookInput({ today: new Date(2026, DEC, 30) })));
    expect(third.result.current.visible).toBe(false);
    expect(getSetting('supportCardV1')).toEqual(record({ viewDays: [1, 5] }));
  });

  it('rolls over to a new day without a remount', () => {
    const { result, rerender } = renderHook((props: UseSupportCardInput) => useSupportCard(props), {
      initialProps: hookInput({ today: new Date(2026, DEC, 7) }),
    });
    expect(result.current.visible).toBe(true);

    rerender(hookInput({ today: new Date(2026, DEC, 8) }));
    expect(result.current.visible).toBe(false);
  });

  it('hides for good on close, across a relaunch', () => {
    const { result } = renderHook(() => useSupportCard(hookInput()));
    act(() => result.current.close());
    expect(result.current.visible).toBe(false);

    const relaunched = renderHook(() => useSupportCard(hookInput({ today: new Date(2026, DEC, 30) })));
    expect(relaunched.result.current.visible).toBe(false);
  });
});
