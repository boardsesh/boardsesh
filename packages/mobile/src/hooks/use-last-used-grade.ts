import { useCallback, useEffect, useState } from 'react';
import { getLastUsedGradeId, setLastUsedGradeId } from '../lib/last-grade-store';

/**
 * Reads the last grade the climber filtered by from secure storage on mount and
 * exposes a `rememberGrade` callback that persists subsequent picks. The grade
 * rail uses `lastUsedGrade` to open centred on a familiar grade when no range is
 * currently selected. Port of web's `useLastUsedGrade`.
 */
export function useLastUsedGrade() {
  const [lastUsedGrade, setLastUsedGradeState] = useState<number | undefined>(undefined);

  useEffect(() => {
    void getLastUsedGradeId().then((value) => {
      if (value !== undefined) setLastUsedGradeState(value);
    });
  }, []);

  const rememberGrade = useCallback((difficultyId: number | undefined) => {
    if (difficultyId === undefined) return;
    setLastUsedGradeState(difficultyId);
    void setLastUsedGradeId(difficultyId);
  }, []);

  return { lastUsedGrade, rememberGrade };
}
