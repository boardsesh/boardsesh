// Remembers the grade a setter last published at, per board.
//
// A spray wall's grade is required to publish (#5443), and a wall's climbs
// cluster hard: somebody setting a session of problems on their garage wall is
// picking the same two or three grades all evening. Starting the picker at
// nothing every time makes them scroll the whole ladder for each climb; starting
// it at their last pick makes the common case one tap or none.
//
// Deliberately a SEED, not a value. It pre-selects the rail on a fresh climb and
// nothing else — a restored draft, a fork and an edit all carry their own grade
// and must win over it, or reopening a V4 draft would silently re-grade it.
//
// Per board name because the scales differ (and a Kilter setter's habits say
// nothing about their spray wall), and via the AsyncStorage preference store
// because it is an ordinary UI preference: losing it costs one scroll.

import { useCallback, useEffect, useState } from 'react';
import { getPreference, setPreference } from '../../lib/preference-store';

const KEY_PREFIX = 'boardsesh_create_climb_last_grade:';

export function lastUsedGradeKey(boardName: string): string {
  return `${KEY_PREFIX}${boardName}`;
}

export type LastUsedGrade = {
  /**
   * The remembered difficulty id, or `null` while the read is in flight or
   * nothing has been published on this board yet.
   */
  lastDifficultyId: number | null;
  /** Record a difficulty id as the board's most recent pick. Fire-and-forget. */
  rememberDifficultyId: (difficultyId: number | null | undefined) => void;
};

export function useLastUsedGrade(boardName: string): LastUsedGrade {
  const [lastDifficultyId, setLastDifficultyId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPreference<number>(lastUsedGradeKey(boardName))
      .then((stored) => {
        if (cancelled) return;
        setLastDifficultyId(typeof stored === 'number' ? stored : null);
      })
      .catch(() => {
        // A preference nobody can read is a preference nobody had. The picker
        // opens unset, which is the same state a first-time setter sees.
      });
    return () => {
      cancelled = true;
    };
  }, [boardName]);

  const rememberDifficultyId = useCallback(
    (difficultyId: number | null | undefined) => {
      if (typeof difficultyId !== 'number') return;
      setLastDifficultyId(difficultyId);
      void setPreference(lastUsedGradeKey(boardName), difficultyId).catch(() => {
        // Same: the next climb starts where this one did in memory, and the
        // habit is re-learned on the next launch.
      });
    },
    [boardName],
  );

  return { lastDifficultyId, rememberDifficultyId };
}
