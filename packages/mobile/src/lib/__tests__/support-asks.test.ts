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
  isSupportCardDay,
  planSupportCard,
  readSupportCardRecord,
  supportCardMonth,
  useSupportAsksAllowed,
  useSupportCard,
  type SupportCardInput,
  type UseSupportCardInput,
} from '../support-asks';

const MARCH = 2;
const input = (overrides: Partial<SupportCardInput> = {}): SupportCardInput => ({
  asksAllowed: true,
  today: new Date(2027, MARCH, 3),
  sessionActive: false,
  boardConnected: false,
  record: { closedMonth: null },
  ...overrides,
});

beforeEach(() => {
  mockStorage.clear();
  resetAllSettings();
  links.allowed = true;
});

describe('isSupportCardDay', () => {
  it.each([
    ['1 Mar, just after midnight', new Date(2027, MARCH, 1, 0, 1), true],
    ['7 Mar, late evening', new Date(2027, MARCH, 7, 23, 59), true],
    ['8 Mar, just after midnight', new Date(2027, MARCH, 8, 0, 0), false],
    ['31 Mar', new Date(2027, MARCH, 31, 12, 0), false],
    ['28 Feb', new Date(2027, 1, 28), false],
    ['1 Dec', new Date(2026, 11, 1), true],
    ['29 Dec', new Date(2026, 11, 29), false],
  ])('%s', (_label, date, expected) => {
    expect(isSupportCardDay(date)).toBe(expected);
  });
});

describe('supportCardMonth', () => {
  it('pads the month to two digits', () => {
    expect(supportCardMonth(new Date(2027, MARCH, 3))).toBe('2027-03');
  });

  it('reads the phone calendar, so late on the 31st is still that month', () => {
    expect(supportCardMonth(new Date(2026, 11, 31, 23, 59))).toBe('2026-12');
  });
});

describe('planSupportCard', () => {
  it('shows on day 1 and day 7 of a month that is not December', () => {
    expect(planSupportCard(input({ today: new Date(2027, MARCH, 1) }))).toEqual({ visible: true });
    expect(planSupportCard(input({ today: new Date(2027, MARCH, 7) }))).toEqual({ visible: true });
  });

  it('stays hidden from day 8 on', () => {
    expect(planSupportCard(input({ today: new Date(2027, MARCH, 8) }))).toEqual({ visible: false });
    expect(planSupportCard(input({ today: new Date(2027, MARCH, 31) }))).toEqual({ visible: false });
  });

  it('stays hidden where support asks are not allowed (store rules or the switch)', () => {
    expect(planSupportCard(input({ asksAllowed: false }))).toEqual({ visible: false });
  });

  it('never shows during a session', () => {
    expect(planSupportCard(input({ sessionActive: true }))).toEqual({ visible: false });
  });

  it('never shows with a board connected', () => {
    expect(planSupportCard(input({ boardConnected: true }))).toEqual({ visible: false });
  });

  it('stays hidden for the rest of the month it was closed in', () => {
    expect(planSupportCard(input({ record: { closedMonth: '2027-03' } }))).toEqual({ visible: false });
  });

  it('comes back on the 1st after a close last month', () => {
    const plan = planSupportCard(input({ today: new Date(2027, MARCH, 1), record: { closedMonth: '2027-02' } }));
    expect(plan).toEqual({ visible: true });
  });

  it('comes back in the same month a year later', () => {
    const plan = planSupportCard(input({ today: new Date(2028, MARCH, 2), record: { closedMonth: '2027-03' } }));
    expect(plan).toEqual({ visible: true });
  });
});

describe('readSupportCardRecord', () => {
  it.each([
    ['nothing stored', null],
    ['a string', '2027-03'],
    ['an empty object', {}],
    ['a month with no padding', { closedMonth: '2027-3' }],
    ['month 13', { closedMonth: '2027-13' }],
    ['a number', { closedMonth: 202703 }],
    ['the old campaign shape', { campaign: 'dec-2026', viewDays: [1, 2], closed: true }],
  ])('reads %s as empty', (_label, stored) => {
    expect(readSupportCardRecord(stored)).toEqual({ closedMonth: null });
  });

  it('keeps a valid record', () => {
    expect(readSupportCardRecord({ closedMonth: '2027-03' })).toEqual({ closedMonth: '2027-03' });
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
    today: new Date(2027, MARCH, 1),
    sessionActive: false,
    boardConnected: false,
    ...overrides,
  });

  it('shows on every visit in the window without writing anything', () => {
    const first = renderHook(() => useSupportCard(hookInput({ today: new Date(2027, MARCH, 1) })));
    expect(first.result.current.visible).toBe(true);
    first.unmount();

    for (const day of [2, 3, 4, 5, 6, 7]) {
      const visit = renderHook(() => useSupportCard(hookInput({ today: new Date(2027, MARCH, day) })));
      expect(visit.result.current.visible).toBe(true);
      visit.unmount();
    }
    expect(getSetting('supportCardV1')).toBeNull();
  });

  it('a close stores this month and hides the card, across a relaunch', () => {
    const { result } = renderHook(() => useSupportCard(hookInput({ today: new Date(2027, MARCH, 2) })));
    act(() => result.current.close());
    expect(result.current.visible).toBe(false);
    expect(getSetting('supportCardV1')).toEqual({ closedMonth: '2027-03' });

    const relaunched = renderHook(() => useSupportCard(hookInput({ today: new Date(2027, MARCH, 6) })));
    expect(relaunched.result.current.visible).toBe(false);
  });

  it('comes back on the 1st of the next month after a close', () => {
    setSetting('supportCardV1', { closedMonth: '2027-02' });
    const { result } = renderHook(() => useSupportCard(hookInput({ today: new Date(2027, MARCH, 1) })));
    expect(result.current.visible).toBe(true);
  });

  it('rolls over from day 7 to day 8 without a remount', () => {
    const { result, rerender } = renderHook((props: UseSupportCardInput) => useSupportCard(props), {
      initialProps: hookInput({ today: new Date(2027, MARCH, 7) }),
    });
    expect(result.current.visible).toBe(true);

    rerender(hookInput({ today: new Date(2027, MARCH, 8) }));
    expect(result.current.visible).toBe(false);
  });

  it('a close left open past midnight into a new month counts for the new month', () => {
    const { result, rerender } = renderHook((props: UseSupportCardInput) => useSupportCard(props), {
      initialProps: hookInput({ today: new Date(2027, MARCH, 31, 23, 59) }),
    });
    rerender(hookInput({ today: new Date(2027, 3, 1, 0, 1) }));
    expect(result.current.visible).toBe(true);
    act(() => result.current.close());
    expect(getSetting('supportCardV1')).toEqual({ closedMonth: '2027-04' });
  });
});
