import { useCallback, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { nowDate } from '../lib/clock';

// "Today" at day granularity, for anything that reads the calendar day rather
// than the instant: the Logbook's rolling date windows ("Last 7 days", "This
// month"), its To-date ceiling and its "Today" / "Yesterday" dividers. One
// shared store, so every reader rolls over together and only when the day
// actually changes: the snapshot is a new Date once per calendar day, which
// keeps a query key or a memo built on it stable all day.
//
// It re-reads the clock when a reader's screen regains focus, when the app
// comes back to the foreground (an app left open overnight wakes up on the new
// day), and at the next local midnight while anyone is reading. Screenshot
// mode's frozen clock (lib/clock.ts) still holds, so a capture never rolls over.

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

let today: Date | null = null;
const listeners = new Set<() => void>();
let appStateSubscription: { remove: () => void } | null = null;
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
// A little past midnight, so a timer that fires a hair early still lands on the new day.
const MIDNIGHT_SLACK_MS = 1000;

function getToday(): Date {
  if (!today) today = startOfLocalDay(nowDate());
  return today;
}

/** Re-reads the clock; notifies readers only when the calendar day has changed. */
export function refreshToday(): void {
  const next = startOfLocalDay(nowDate());
  if (today && next.getTime() === today.getTime()) return;
  today = next;
  for (const listener of listeners) listener();
}

function handleAppStateChange(status: AppStateStatus): void {
  if (status === 'active') refreshToday();
}

/** One timer to the next local midnight while readers are mounted; it re-arms itself. */
function scheduleMidnightRefresh(): void {
  if (midnightTimer) clearTimeout(midnightTimer);
  const now = nowDate();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  midnightTimer = setTimeout(
    () => {
      midnightTimer = null;
      refreshToday();
      if (listeners.size > 0) scheduleMidnightRefresh();
    },
    nextMidnight.getTime() - now.getTime() + MIDNIGHT_SLACK_MS,
  );
}

function stopMidnightRefresh(): void {
  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = null;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (!appStateSubscription) appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
  if (!midnightTimer) scheduleMidnightRefresh();
  // A reader mounting after midnight must not inherit yesterday from the module.
  refreshToday();
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      appStateSubscription?.remove();
      appStateSubscription = null;
      stopMidnightRefresh();
    }
  };
}

/**
 * Local midnight of today. The same Date object all day; a new one when the day
 * changes, read at midnight, on focus, on foreground and when a reader subscribes.
 */
export function useToday(): Date {
  const value = useSyncExternalStore(subscribe, getToday, getToday);
  useFocusEffect(
    useCallback(() => {
      refreshToday();
    }, []),
  );
  return value;
}

/** Test-only: forget the cached day and every listener. */
export function resetTodayForTests(): void {
  today = null;
  listeners.clear();
  appStateSubscription?.remove();
  appStateSubscription = null;
  stopMidnightRefresh();
}
