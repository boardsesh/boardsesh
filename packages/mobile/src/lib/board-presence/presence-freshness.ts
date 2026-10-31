import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { nowMs } from '../clock';

// How long board presence's "this climb is on the wall" is trusted without a
// live link (#7000, QA #147, Marco's call): one hour. Aurora and MoonBoard
// boxes keep their LEDs on after a phone disconnects, so a climb lit a minute
// ago is very likely still up; one lit hours ago may not be (the box powered
// off, someone else lit it from the manufacturer's app). Past the hour the
// player says Connect board instead, and the Climbs header's wall capsule hides
// (#7095). With a live link (this phone's or a crewmate's) the link says what
// is lit, so freshness doesn't matter.
//
// One rule, read by the player's board control model (`resolveWallControl`),
// `resolveWallLit`, the header back chip and the wall capsule, so none of them
// disagree.

export const PRESENCE_FRESH_MS = 60 * 60 * 1000;

/** The wall's climb was lit less than an hour ago. `null` or an unreadable stamp is never fresh. */
export function isPresenceFresh(sentAt: string | null, now: number): boolean {
  if (sentAt === null) return false;
  const litAt = Date.parse(sentAt);
  if (!Number.isFinite(litAt)) return false;
  return now - litAt < PRESENCE_FRESH_MS;
}

/** Whether to believe presence's wall climb: a live link, or presence under an hour old. */
export function isWallPresenceTrusted({ linked, presenceFresh }: { linked: boolean; presenceFresh: boolean }): boolean {
  return linked || presenceFresh;
}

/**
 * The Climbs header's wall capsule (#7095): the wall's climb while it is
 * trusted, `null` past the hour with no live link, so the capsule hides rather
 * than name a climb the box may no longer show.
 */
export function trustedWallCapsuleClimb(
  wallClimb: BoardPresenceClimb | null,
  trust: { linked: boolean; presenceFresh: boolean },
): BoardPresenceClimb | null {
  if (wallClimb === null) return null;
  return isWallPresenceTrusted(trust) ? wallClimb : null;
}

/**
 * `isPresenceFresh` for a component: it re-renders once, at the moment the
 * hour runs out, so an open player or a mounted capsule changes on time with
 * no polling.
 */
export function usePresenceFresh(sentAt: string | null): boolean {
  // Suspension can defer a timer, so foregrounding reads the clock and re-arms
  // the remaining deadline as well as refreshing the rendered trust decision.
  const [clockRevision, setClockRevision] = useState(0);
  const fresh = isPresenceFresh(sentAt, nowMs());
  useEffect(() => {
    if (sentAt === null || !Number.isFinite(Date.parse(sentAt))) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setClockRevision((revision) => revision + 1);
    });
    return () => subscription.remove();
  }, [sentAt]);
  useEffect(() => {
    if (!fresh || sentAt === null) return undefined;
    const expiresIn = Date.parse(sentAt) + PRESENCE_FRESH_MS - nowMs();
    const timer = setTimeout(() => setClockRevision((revision) => revision + 1), Math.max(0, expiresIn) + 1);
    return () => clearTimeout(timer);
  }, [sentAt, fresh, clockRevision]);
  return fresh;
}
