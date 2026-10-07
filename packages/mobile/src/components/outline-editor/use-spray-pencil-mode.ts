// The spray editor's Pencil mode as React state: whether a Pencil has been seen,
// whether "Pencil only" is on, and the rail toggle that overrides it. The rules
// live in `pencil-session.ts`; this hook only reads storage and the session.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from '../../lib/preference-store';
import {
  markPencilSeen,
  parsePencilOnlyOverride,
  pencilSeenThisSession,
  pencilToggleAvailable,
  resolvePencilOnly,
  SPRAY_PENCIL_ONLY_KEY,
  subscribePencilSession,
} from './pencil-session';

export type SprayPencilMode = {
  /** An Apple Pencil has touched or hovered over the wall this session (iPad layout only). */
  pencilSeen: boolean;
  /** Fingers pick and pan; only the Pencil changes the wall. Always false on the phone layout. */
  pencilOnly: boolean;
  /** The rail shows its Pencil only toggle. */
  toggleAvailable: boolean;
  /** Flip Pencil only, and remember the choice on this device. */
  togglePencilOnly: () => void;
  /** Report a Pencil touch or hover. True the first time this session, so the caller can say so once. */
  notePencil: () => boolean;
};

export function useSprayPencilMode(tablet: boolean): SprayPencilMode {
  const seen = useSyncExternalStore(subscribePencilSession, pencilSeenThisSession, pencilSeenThisSession);
  const [override, setOverride] = useState<boolean | null>(null);
  // A choice made before the read lands must not be overwritten by it.
  const [chosen, setChosen] = useState(false);

  useEffect(() => {
    if (!tablet || chosen) return;
    let cancelled = false;
    void getPreference<boolean>(SPRAY_PENCIL_ONLY_KEY)
      .then((stored) => {
        if (!cancelled) setOverride(parsePencilOnlyOverride(stored));
      })
      .catch(() => {
        // Unreadable reads as never chosen: Pencil only follows the Pencil.
      });
    return () => {
      cancelled = true;
    };
  }, [tablet, chosen]);

  const pencilOnly = resolvePencilOnly({ tablet, pencilSeen: seen, override });
  const toggleAvailable = pencilToggleAvailable({ tablet, pencilSeen: seen, override });

  const togglePencilOnly = useCallback(() => {
    const next = !pencilOnly;
    setChosen(true);
    setOverride(next);
    void setPreference(SPRAY_PENCIL_ONLY_KEY, next).catch(() => {
      // Kept for this session; the next launch follows the Pencil again.
    });
  }, [pencilOnly]);

  const notePencil = useCallback(() => (tablet ? markPencilSeen() : false), [tablet]);

  const pencilSeen = tablet && seen;
  return useMemo(
    () => ({ pencilSeen, pencilOnly, toggleAvailable, togglePencilOnly, notePencil }),
    [pencilSeen, pencilOnly, toggleAvailable, togglePencilOnly, notePencil],
  );
}
