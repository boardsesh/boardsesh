/**
 * The two places the app asks for support, past the Acknowledgements link: a
 * "Support Boardsesh" row at the top of Account, and a closable card at the top
 * of Home on a few days in December.
 *
 * Both sit behind the same two gates:
 *
 * - `useDonationLinksAllowed()` — the store rules (US iPhones and the Expo
 *   browser app only; never Android, never screenshot mode). See
 *   donation-links.ts.
 * - The climber's own "Show support asks" switch in Settings › General, on by
 *   default. Off hides the row and the card.
 *
 * The card has more rules of its own, all in `planSupportCard` so a test can
 * walk every one: the December windows, at most two days on screen, gone for
 * good after a tap or a close, and never while a climber is in a session or has
 * a board connected (Home is where a climber lands between climbs, and the card
 * must not sit between them and the wall).
 */
import { useCallback, useEffect, useState } from 'react';
import { getSetting, setSetting, useSetting } from '../settings/hooks';
import { useDonationLinksAllowed } from './donation-links';

/** Both gates the Account row and the Home card share. */
export function useSupportAsksAllowed(): boolean {
  const linksAllowed = useDonationLinksAllowed();
  const [shown] = useSetting('supportAsksShown');
  return linksAllowed && shown;
}

/**
 * The campaign this record counts for. A later campaign gets a new id, so the
 * views and the close from this one never carry over into it.
 */
export const SUPPORT_CARD_CAMPAIGN = 'dec-2026';

/** Days the card may be on screen across the whole campaign. */
export const SUPPORT_CARD_MAX_VIEW_DAYS = 2;

/** What the phone remembers about the Home card (`supportCardV1`). */
export type SupportCardRecord = {
  campaign: string;
  /**
   * The days of December the card was on screen. Inside one campaign the day of
   * the month is the whole date, so nothing longer needs storing.
   */
  viewDays: number[];
  /** Tapped or closed. Either one hides the card for the rest of the campaign. */
  closed: boolean;
};

const EMPTY_RECORD: SupportCardRecord = { campaign: SUPPORT_CARD_CAMPAIGN, viewDays: [], closed: false };

/** A stored record for this campaign, or a fresh one for anything else (missing, older, malformed). */
export function readSupportCardRecord(stored: unknown): SupportCardRecord {
  if (typeof stored !== 'object' || stored === null) return EMPTY_RECORD;
  const { campaign, viewDays, closed } = stored as Partial<SupportCardRecord>;
  if (campaign !== SUPPORT_CARD_CAMPAIGN) return EMPTY_RECORD;
  if (!Array.isArray(viewDays) || !viewDays.every((day) => Number.isInteger(day))) return EMPTY_RECORD;
  return { campaign, viewDays, closed: closed === true };
}

/**
 * The December 2026 days the card may show, read on the phone's own calendar:
 * 1–7 Dec (the start of the month's push) and 29–31 Dec (the last call).
 * Returns the day of the month, or null outside both windows.
 */
export function supportCardDay(today: Date): number | null {
  if (today.getFullYear() !== 2026 || today.getMonth() !== 11) return null;
  const day = today.getDate();
  return day <= 7 || day >= 29 ? day : null;
}

export type SupportCardInput = {
  asksAllowed: boolean;
  today: Date;
  sessionActive: boolean;
  boardConnected: boolean;
  record: SupportCardRecord;
};

export type SupportCardPlan =
  | { visible: false }
  /** `countView` is true on the first showing of a day, which is when it is counted. */
  | { visible: true; day: number; countView: boolean };

/** Whether the Home card shows now, and whether showing it uses up one of its days. */
export function planSupportCard(input: SupportCardInput): SupportCardPlan {
  if (!input.asksAllowed || input.sessionActive || input.boardConnected || input.record.closed) {
    return { visible: false };
  }
  const day = supportCardDay(input.today);
  if (day === null) return { visible: false };
  // A day already counted shows again for free: leaving Home and coming back on
  // the same day is the same view.
  if (input.record.viewDays.includes(day)) return { visible: true, day, countView: false };
  if (input.record.viewDays.length >= SUPPORT_CARD_MAX_VIEW_DAYS) return { visible: false };
  return { visible: true, day, countView: true };
}

/** A copy of `record` with `day` counted, or `record` itself when it already is. */
export function withSupportCardView(record: SupportCardRecord, day: number): SupportCardRecord {
  if (record.viewDays.includes(day)) return record;
  return { ...record, viewDays: [...record.viewDays, day] };
}

export type UseSupportCardInput = Omit<SupportCardInput, 'record'> & {
  /**
   * Home is the screen on top. NativeTabs mounts every tab at launch, so without
   * this a launch on Climbs would spend one of the card's two days unseen.
   */
  focused: boolean;
};

/**
 * The Home card's state, read once from the settings store on mount and written
 * back on every change. Not `useSetting`: an object-valued key gets a new
 * identity on every settings write anywhere in the app, and Home would re-render
 * for each one.
 */
export function useSupportCard({ focused, ...input }: UseSupportCardInput): {
  visible: boolean;
  /** Hides the card for good: the climber tapped a button or the close. */
  close: () => void;
} {
  const [record, setRecord] = useState(() => readSupportCardRecord(getSetting('supportCardV1')));
  const plan = planSupportCard({ ...input, record });
  const countDay = focused && plan.visible && plan.countView ? plan.day : null;

  useEffect(() => {
    if (countDay === null) return;
    const next = withSupportCardView(record, countDay);
    if (next === record) return;
    setSetting('supportCardV1', next);
    setRecord(next);
  }, [countDay, record]);

  const close = useCallback(() => {
    if (record.closed) return;
    const next = { ...record, closed: true };
    setSetting('supportCardV1', next);
    setRecord(next);
  }, [record]);

  return { visible: plan.visible, close };
}
