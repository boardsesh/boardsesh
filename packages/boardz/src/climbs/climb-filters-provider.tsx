import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { readJson, writeJson } from '../storage/json-storage';
import { CLIMB_SORTS, DEFAULT_CLIMB_FILTERS, type ClimbFilters } from './climb-filters';

const STORAGE_KEY = 'boardz.climbFilters';

function isClimbFilters(value: unknown): value is ClimbFilters {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const isGrade = (grade: unknown) => grade === null || typeof grade === 'number';
  return (
    typeof candidate.sort === 'string' &&
    (CLIMB_SORTS as readonly string[]).includes(candidate.sort) &&
    isGrade(candidate.minGrade) &&
    isGrade(candidate.maxGrade) &&
    typeof candidate.benchmarksOnly === 'boolean' &&
    typeof candidate.hideSent === 'boolean' &&
    (candidate.minStars === null || typeof candidate.minStars === 'number') &&
    (candidate.shuffleSeed === null || typeof candidate.shuffleSeed === 'string')
  );
}

type ClimbFiltersContextValue = {
  filters: ClimbFilters;
  setFilters: (filters: ClimbFilters) => void;
  /** The name search in the Session tab's search bar. Not remembered between launches. */
  query: string;
  setQuery: (query: string) => void;
};

const ClimbFiltersContext = createContext<ClimbFiltersContextValue | null>(null);

export function ClimbFiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFiltersState] = useState<ClimbFilters>(DEFAULT_CLIMB_FILTERS);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void readJson(STORAGE_KEY, isClimbFilters).then((stored) => {
      if (!cancelled && stored) setFiltersState(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const value: ClimbFiltersContextValue = {
    filters,
    setFilters: (next) => {
      setFiltersState(next);
      writeJson(STORAGE_KEY, next);
    },
    query,
    setQuery,
  };

  return <ClimbFiltersContext.Provider value={value}>{children}</ClimbFiltersContext.Provider>;
}

export function useClimbFilters(): ClimbFiltersContextValue {
  const context = useContext(ClimbFiltersContext);
  if (!context) throw new Error('useClimbFilters must be used inside ClimbFiltersProvider');
  return context;
}
