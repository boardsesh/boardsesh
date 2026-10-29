/**
 * The two places the app asks for support, past the Acknowledgements link: a
 * "Support Boardsesh" row at the top of Account, and a closable card at the top
 * of Home in the first week of each month.
 *
 * Both sit behind the same two gates:
 *
 * - `useDonationLinksAllowed()` — the store rules (US iPhones and the Expo
 *   browser app only; never Android, never screenshot mode). See
 *   donation-links.ts.
 * - The climber's own "Show support asks" switch in Settings › General, on by
 *   default. Off hides the row and the card.
 *
 * The card has more rules of its own, the same ones the boardsesh.com homepage
 * banner follows. It never shows in the Expo browser app (HomeSupportCard
 * checks that), and the rest live in `planSupportCard` so a test can walk every
 * one:
 *
 * - Days 1 to 7 of every month, on the phone's own calendar.
 * - Every Home visit in that window, until the climber closes it.
 * - The close, or a tap on either Give button, hides it for the rest of that
 *   calendar month; it comes back on the 1st of the next. The app cannot see
 *   whether someone gave (payment happens on the web), so a tap counts like a
 *   close.
 * - Never while a climber is in a session or has a board connected (Home is
 *   where a climber lands between climbs, and the card must not sit between
 *   them and the wall).
 */
import { useCallback, useState } from 'react';
import { getSetting, setSetting, useSetting } from '../settings/hooks';
import { useDonationLinksAllowed } from './donation-links';

/** Both gates the Account row and the Home card share. */
export function useSupportAsksAllowed(): boolean {
  const linksAllowed = useDonationLinksAllowed();
  const [shown] = useSetting('supportAsksShown');
  return linksAllowed && shown;
}

/** The last day of each month the card may show on. */
export const SUPPORT_CARD_LAST_DAY = 7;

/** What the phone remembers about the Home card (`supportCardV1`). */
export type SupportCardRecord = {
  /**
   * The calendar month (`YYYY-MM`, the phone's own calendar) the climber last
   * closed the card or tapped one of its buttons in. The card stays hidden for
   * the rest of that month. `null` when it was never closed.
   */
  closedMonth: string | null;
};

const EMPTY_RECORD: SupportCardRecord = { closedMonth: null };
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A stored record, or an empty one for anything else (missing, malformed). */
export function readSupportCardRecord(stored: unknown): SupportCardRecord {
  if (typeof stored !== 'object' || stored === null) return EMPTY_RECORD;
  const { closedMonth } = stored as Partial<SupportCardRecord>;
  if (typeof closedMonth !== 'string' || !MONTH_KEY.test(closedMonth)) return EMPTY_RECORD;
  return { closedMonth };
}

/** `today`'s calendar month as `YYYY-MM`, on the phone's own calendar. */
export function supportCardMonth(today: Date): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
}

/** Whether the card may show on `today`: days 1 to 7 of any month, on the phone's own calendar. */
export function isSupportCardDay(today: Date): boolean {
  return today.getDate() <= SUPPORT_CARD_LAST_DAY;
}

export type SupportCardInput = {
  asksAllowed: boolean;
  today: Date;
  sessionActive: boolean;
  boardConnected: boolean;
  record: SupportCardRecord;
};

export type SupportCardPlan = { visible: boolean };

/** Whether the Home card shows now. */
export function planSupportCard(input: SupportCardInput): SupportCardPlan {
  if (!input.asksAllowed || input.sessionActive || input.boardConnected) return { visible: false };
  if (!isSupportCardDay(input.today)) return { visible: false };
  if (input.record.closedMonth === supportCardMonth(input.today)) return { visible: false };
  return { visible: true };
}

export type UseSupportCardInput = Omit<SupportCardInput, 'record'>;

/**
 * The Home card's state, read once from the settings store on mount and written
 * back on a close. Not `useSetting`: an object-valued key gets a new identity on
 * every settings write anywhere in the app, and Home would re-render for each
 * one.
 */
export function useSupportCard(input: UseSupportCardInput): {
  visible: boolean;
  /** Hides the card for the rest of this month: the climber tapped a button or the close. */
  close: () => void;
} {
  const [record, setRecord] = useState(() => readSupportCardRecord(getSetting('supportCardV1')));
  const plan = planSupportCard({ ...input, record });
  const month = supportCardMonth(input.today);

  const close = useCallback(() => {
    if (record.closedMonth === month) return;
    const next: SupportCardRecord = { closedMonth: month };
    setSetting('supportCardV1', next);
    setRecord(next);
  }, [record, month]);

  return { visible: plan.visible, close };
}
