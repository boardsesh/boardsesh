'use client';

import { useEffect, useState } from 'react';
import { openDB, type IDBPDatabase } from 'idb';
import type { HoldState } from '@boardsesh/shared-schema';

/**
 * User-configurable hex colour overrides for LED roles. Only HAND/FOOT/FINISH
 * are user-customisable; STARTING stays the canonical green so first-look
 * climbing convention isn't broken.
 *
 * Values are stored as `#rrggbb` strings (lowercase, with leading `#`). A
 * missing key falls back to the board's canonical role colour at packet
 * build time — so an unset override is functionally equivalent to "default".
 */
export type LedColorOverrides = Partial<Record<Extract<HoldState, 'HAND' | 'FOOT' | 'FINISH'>, string>>;

export const CUSTOMISABLE_LED_ROLES = ['HAND', 'FOOT', 'FINISH'] as const;
export type CustomisableLedRole = (typeof CUSTOMISABLE_LED_ROLES)[number];

const DB_NAME = 'boardsesh-led-colors';
const STORE_NAME = 'overrides';
const RECORD_KEY = 'current';

let dbPromise: Promise<IDBPDatabase | null> | null = null;

function getDb(): Promise<IDBPDatabase | null> | null {
  // jsdom-based test environments expose `window` but lack `indexedDB`, so a
  // bare `typeof window` check would still let `openDB` blow up. The narrower
  // guard keeps SSR + tests + private-mode browsers all on the no-op path.
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
      terminated() {
        dbPromise = null;
      },
    }).catch(() => {
      dbPromise = null;
      return null;
    });
  }
  return dbPromise;
}

export async function getLedColorOverrides(): Promise<LedColorOverrides> {
  const dbReq = getDb();
  if (!dbReq) return {};
  try {
    const db = await dbReq;
    if (!db) return {};
    const value = await db.get(STORE_NAME, RECORD_KEY);
    return (value as LedColorOverrides | undefined) ?? {};
  } catch (error) {
    console.error('Failed to read LED color overrides:', error);
    return {};
  }
}

export async function setLedColorOverrides(overrides: LedColorOverrides): Promise<void> {
  const dbReq = getDb();
  if (!dbReq) return;
  try {
    const db = await dbReq;
    if (!db) return;
    await db.put(STORE_NAME, overrides, RECORD_KEY);
    notify(overrides);
  } catch (error) {
    console.error('Failed to write LED color overrides:', error);
  }
}

// In-process pub-sub so multiple components in the same tab stay in sync
// without each having to round-trip through IndexedDB on every change.
const listeners = new Set<(overrides: LedColorOverrides) => void>();

function notify(overrides: LedColorOverrides) {
  for (const listener of listeners) listener(overrides);
}

/**
 * Subscribe to LED colour-override changes. Returns the current value plus a
 * setter that persists to IndexedDB and notifies all live subscribers.
 */
export function useLedColorOverrides(): [LedColorOverrides, (next: LedColorOverrides) => void] {
  const [overrides, setOverrides] = useState<LedColorOverrides>({});

  useEffect(() => {
    let cancelled = false;
    getLedColorOverrides()
      .then((value) => {
        if (!cancelled) setOverrides(value);
      })
      .catch(() => {
        // getLedColorOverrides already logs — swallow here so React doesn't
        // surface an unhandled rejection in environments without IndexedDB.
      });
    const listener = (value: LedColorOverrides) => setOverrides(value);
    listeners.add(listener);
    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  const update = (next: LedColorOverrides) => {
    setOverrides(next);
    void setLedColorOverrides(next);
  };

  return [overrides, update];
}
