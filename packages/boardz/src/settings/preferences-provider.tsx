import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { GradeDisplayFormat } from '../grades/grades';
import type { BoardBackdrop } from '../ui/theme';
import { readJson, writeJson } from '../storage/json-storage';

const STORAGE_KEY = 'boardz.preferences';

export type Preferences = {
  gradeFormat: GradeDisplayFormat;
  /** The grade the last workout was set at (difficulty id), so the next one starts there. */
  workoutGrade: number | null;
  /** What MoonBoard and Woods holds are drawn on. */
  boardBackdrop: BoardBackdrop;
};

// Font grades by default: MoonBoard problems are set and graded in Font.
const DEFAULT_PREFERENCES: Preferences = { gradeFormat: 'font', workoutGrade: null, boardBackdrop: 'charcoal' };

// Stored preferences are merged over the defaults, so a field added in a later
// build doesn't throw away the ones already saved.
function isStoredPreferences(value: unknown): value is Partial<Preferences> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.gradeFormat === undefined ||
      candidate.gradeFormat === 'font' ||
      candidate.gradeFormat === 'v-grade' ||
      candidate.gradeFormat === 'both') &&
    (candidate.workoutGrade === undefined ||
      candidate.workoutGrade === null ||
      typeof candidate.workoutGrade === 'number') &&
    (candidate.boardBackdrop === undefined ||
      candidate.boardBackdrop === 'charcoal' ||
      candidate.boardBackdrop === 'white' ||
      candidate.boardBackdrop === 'yellow')
  );
}

type PreferencesContextValue = Preferences & {
  update: (changes: Partial<Preferences>) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    let cancelled = false;
    void readJson(STORAGE_KEY, isStoredPreferences).then((stored) => {
      if (!cancelled && stored) setPreferences({ ...DEFAULT_PREFERENCES, ...stored });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const value: PreferencesContextValue = {
    ...preferences,
    update: (changes) => {
      const next = { ...preferences, ...changes };
      setPreferences(next);
      writeJson(STORAGE_KEY, next);
    },
  };

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used inside PreferencesProvider');
  return context;
}
