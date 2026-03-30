import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  getGradeDisplayFormat,
  setGradeDisplayFormat,
  type GradeDisplayFormat,
} from '@/app/lib/user-preferences-db';
import { formatGrade, getSoftGradeColorByFormat } from '@/app/lib/grade-colors';

export function useGradeFormat() {
  const [gradeFormat, setGradeFormatState] = useState<GradeDisplayFormat>('v-grade');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getGradeDisplayFormat().then((value) => {
      setGradeFormatState(value);
      setLoaded(true);
    });
  }, []);

  const setGradeFormat = useCallback(async (format: GradeDisplayFormat) => {
    await setGradeDisplayFormat(format);
    setGradeFormatState(format);
  }, []);

  const formatGradeWithPreference = useCallback(
    (difficulty: string | null | undefined): string | null => {
      return formatGrade(difficulty, gradeFormat);
    },
    [gradeFormat],
  );

  const getGradeColor = useCallback(
    (difficulty: string | null | undefined, darkMode?: boolean): string | undefined => {
      return getSoftGradeColorByFormat(difficulty, gradeFormat, darkMode);
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
