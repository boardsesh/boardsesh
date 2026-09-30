import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

/**
 * The climbs the climb screen can step through: the browse list the climber
 * tapped into, or a workout's plan. Opening a climb hands over the whole list,
 * so "next" follows what they were looking at.
 */
type ClimbSequenceContextValue = {
  climbs: Climb[];
  setClimbs: (climbs: Climb[]) => void;
};

const ClimbSequenceContext = createContext<ClimbSequenceContextValue | null>(null);

export function ClimbSequenceProvider({ children }: { children: ReactNode }) {
  const [climbs, setClimbs] = useState<Climb[]>([]);
  return <ClimbSequenceContext.Provider value={{ climbs, setClimbs }}>{children}</ClimbSequenceContext.Provider>;
}

export function useClimbSequence(): ClimbSequenceContextValue {
  const context = useContext(ClimbSequenceContext);
  if (!context) throw new Error('useClimbSequence must be used inside ClimbSequenceProvider');
  return context;
}
