import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { defaultGradeDisplayFormatForLocale } from '@boardsesh/play-view';
import { getGradeDisplayFormat, setGradeDisplayFormat } from '@/app/lib/user-preferences-db';
import { type GradeDisplayFormat, formatGrade, getSoftGradeColorByFormat } from '@/app/lib/grade-colors';

/** Custom event name used to sync grade format across mounted components. */
const GRADE_FORMAT_CHANGE_EVENT = 'boardsesh:gradeFormatChange';

export function useGradeFormat() {
  const { i18n } = useTranslation();
  // The climber's explicit pick; null until they make one. Without a pick,
  // Spanish, French, German and Italian pages show Font grades and every other locale shows V.
  const [chosenFormat, setGradeFormatState] = useState<GradeDisplayFormat | null>(null);
  const gradeFormat = chosenFormat ?? defaultGradeDisplayFormatForLocale(i18n?.language);
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
        // Fall back to the locale default so Skeletons don't stay forever.
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

  // `boardName` picks the board's own V scale: MoonBoard reads "6a+/V3" as V3,
  // every other board as V3+.
  const formatGradeWithPreference = useCallback(
    (difficulty: string | null | undefined, boardName?: string | null): string | null => {
      return formatGrade(difficulty, gradeFormat, boardName);
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
