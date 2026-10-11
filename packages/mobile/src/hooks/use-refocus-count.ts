import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * How many times this screen has come BACK into focus: 0 until the climber
 * leaves it and returns, then one more on every return. Its first focus does
 * not count.
 *
 * For something that stays on the screen while the climber is away and should
 * catch up when they are back (the climbs list's grade row re-centres on the
 * selection). Pass the count on as a key and react when it changes.
 */
export function useRefocusCount(): number {
  const [refocusCount, setRefocusCount] = useState(0);
  const hasFocusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedRef.current) {
        hasFocusedRef.current = true;
        return;
      }
      setRefocusCount((count) => count + 1);
    }, []),
  );
  return refocusCount;
}
