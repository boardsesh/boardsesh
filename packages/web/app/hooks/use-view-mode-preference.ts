'use client';

import { useState, useEffect, useCallback } from 'react';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { track } from '@vercel/analytics';

export type ViewMode = 'list' | 'grid';
export const VIEW_MODE_PREFERENCE_KEY = 'climbListViewMode';

let cachedViewMode: ViewMode = 'list';
let prefLoaded = false;

// Eagerly load on module import (client-side only)
if (typeof window !== 'undefined') {
  getPreference<ViewMode>(VIEW_MODE_PREFERENCE_KEY).then((stored) => {
    if (stored === 'grid' || stored === 'list') {
      cachedViewMode = stored;
    }
    prefLoaded = true;
  });
}

/**
 * Hook that returns the user's preferred view mode for climb lists.
 * Uses a module-level cache so the value is available synchronously
 * after the first IndexedDB read completes.
 */
export function useViewModePreference(): ViewMode {
  const [mode, setMode] = useState<ViewMode>(cachedViewMode);

  useEffect(() => {
    if (prefLoaded) {
      if (cachedViewMode !== mode) setMode(cachedViewMode);
      return;
    }
    getPreference<ViewMode>(VIEW_MODE_PREFERENCE_KEY).then((stored) => {
      if (stored === 'grid' || stored === 'list') {
        cachedViewMode = stored;
        setMode(stored);
      }
      prefLoaded = true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return mode;
}

/**
 * Update the cached view mode preference and persist to IndexedDB.
 * Also fires an analytics event.
 */
export function useUpdateViewModePreference(): (mode: ViewMode) => void {
  return useCallback((mode: ViewMode) => {
    cachedViewMode = mode;
    setPreference(VIEW_MODE_PREFERENCE_KEY, mode).catch(() => {});
    track('View Mode Changed', { mode });
  }, []);
}
