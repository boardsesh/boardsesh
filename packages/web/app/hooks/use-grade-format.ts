import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getGradeDisplayFormat, setGradeDisplayFormat } from '@/app/lib/user-preferences-db';
import { type GradeDisplayFormat, formatGrade, getSoftGradeColorByFormat } from '@/app/lib/grade-colors';

/** Custom event name used to sync grade format across mounted components. */
const GRADE_FORMAT_CHANGE_EVENT = 'boardsesh:gradeFormatChange';

export function useGradeFormat() {
  const [gradeFormat, setGradeFormatState] = useState<GradeDisplayFormat>('v-grade');
  const [loaded, setLoaded] = useState(false);
  // Track whether this instance originated the current change so the event
  // listener can skip the redundant setState.
  const isLocalChangeRef = useRef(false);

  useEffect(() => {
    getGradeDisplayFormat()
      .then((value) => {
        setGradeFormatState(value);
      })
      .catch(() => {
        // IndexedDB unavailable (private browsing, quota exceeded, etc.)
        // Fall back to default v-grade so Skeletons don't stay forever.
      })
      .finally(() => {
        setLoaded(true);
      });
  }, []);

  // Listen for changes from other components that call setGradeFormat
  useEffect(() => {
    const handler = (e: Event) => {
      if (isLocalChangeRef.current) {
        isLocalChangeRef.current = false;
        return;
      }
      const format = (e as CustomEvent<GradeDisplayFormat>).detail;
      setGradeFormatState(format);
    };
    window.addEventListener(GRADE_FORMAT_CHANGE_EVENT, handler);
    return () => window.removeEventListener(GRADE_FORMAT_CHANGE_EVENT, handler);
  }, []);

  const setGradeFormat = useCallback(async (format: GradeDisplayFormat) => {
    await setGradeDisplayFormat(format);
    setGradeFormatState(format);
    // Notify other mounted instances of the hook
    isLocalChangeRef.current = true;
    window.dispatchEvent(new CustomEvent(GRADE_FORMAT_CHANGE_EVENT, { detail: format }));
  }, []);

  const formatGradeWithPreference = useCallback(
    (difficulty: string | null | undefined): string | null => {
      return formatGrade(difficulty, gradeFormat);
    },
    [gradeFormat],
  );

  // `true`: www renders one scheme. The shared softenColor() keeps its
  // darkMode parameter — mobile still renders light.
  const getGradeColor = useCallback(
    (difficulty: string | null | undefined): string | undefined => {
      return getSoftGradeColorByFormat(difficulty, gradeFormat, true);
    },
    [gradeFormat],
  );

  return useMemo(
    () => ({
      gradeFormat,
      setGradeFormat,
      loaded,
      formatGrade: formatGradeWithPreference,
      getGradeColor,
    }),
    [gradeFormat, setGradeFormat, loaded, formatGradeWithPreference, getGradeColor],
  );
}
