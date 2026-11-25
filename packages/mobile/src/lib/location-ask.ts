/**
 * The one rule for asking a climber for location again.
 *
 * Location is never needed: search works without it. But a climber who said
 * no, or was never asked, gets a clear second ask, the "See gyms near you"
 * card (`LocationAskCard`), without being nagged:
 *
 * - Nothing asks on open. Every screen reads the permission with
 *   `requestIfAllowed`; the system prompt only ever follows a tap on Allow.
 * - "Not now" on any surface snoozes the card on EVERY surface for 14 days.
 *   One record (`locationAskSnoozedUntil` in the settings store) is shared by
 *   the board picker and the gym map, so a no in one place is a no in both.
 * - The card never shows while location is allowed.
 */
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getSetting, setSetting, useSetting } from '../settings/hooks';
import { track } from './analytics';
import type { LocationPermission } from './use-device-location';

/** How long "Not now" quiets the card, everywhere. */
export const LOCATION_ASK_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** Where the card is: the board picker or the gym map. Also the events' `surface`. */
export type LocationAskSurface = 'board_picker' | 'gym_finder';

/** How the climber answered the card. */
export type LocationAskAnswer = 'allow' | 'open_settings' | 'not_now';

/**
 * Whether a "Not now" still holds at `now`. A stored time further out than
 * one snooze can reach means the phone's clock went backwards since; that
 * reads as expired, so a clock change can never silence the ask for longer
 * than 14 days. Anything that is not a finite number (never snoozed, a bad
 * record) is not a snooze.
 */
export function isLocationAskSnoozed(snoozedUntil: unknown, now: number): boolean {
  if (typeof snoozedUntil !== 'number' || !Number.isFinite(snoozedUntil)) return false;
  return now < snoozedUntil && snoozedUntil - now <= LOCATION_ASK_SNOOZE_MS;
}

/** Whether the card has anything to offer: location off, and no snooze holding. */
export function shouldOfferLocationAsk(permission: LocationPermission, snoozed: boolean): boolean {
  return (permission === 'ask' || permission === 'blocked') && !snoozed;
}

/** "Not now": quiet the card on every surface until 14 days from `now`. */
export function snoozeLocationAsk(now: number = Date.now()): void {
  setSetting('locationAskSnoozedUntil', now + LOCATION_ASK_SNOOZE_MS);
}

/** The snooze as it stands now, read without subscribing. */
export function readLocationAskSnoozed(now: number = Date.now()): boolean {
  return isLocationAskSnoozed(getSetting('locationAskSnoozedUntil'), now);
}

/**
 * The snooze, live: a "Not now" on one mounted surface hides the card on
 * every other one at once. Expiry is read at render, so a snooze that runs
 * out while a screen is open shows on its next render.
 */
export function useLocationAskSnoozed(): boolean {
  const [snoozedUntil] = useSetting('locationAskSnoozedUntil');
  return isLocationAskSnoozed(snoozedUntil, Date.now());
}

export function trackLocationAskShown(surface: LocationAskSurface, permission: 'ask' | 'blocked'): void {
  track(SHARED_EVENTS.LocationAskShown, { surface, permission });
}

export function trackLocationAskAnswered(
  surface: LocationAskSurface,
  answer: LocationAskAnswer,
  permission: LocationPermission,
): void {
  track(SHARED_EVENTS.LocationAskAnswered, { surface, answer, permission });
}
