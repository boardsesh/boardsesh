import { createContext, useContext } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

/** Display coverage only; it never makes a climb eligible for a Flash. */
export type ClimbListTickDisplay = {
  entriesByClimbAngle: ReadonlyMap<string, LogbookEntry[]>;
  coveredClimbUuids: ReadonlySet<string>;
};

export const ClimbListTickDisplayContext = createContext<ClimbListTickDisplay | null>(null);

export function useClimbListTickDisplay(): ClimbListTickDisplay | null {
  return useContext(ClimbListTickDisplayContext);
}
