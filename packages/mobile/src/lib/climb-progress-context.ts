import { createContext, useContext } from 'react';
import type { ClimbProgressStore } from './climb-progress-store';
export const ClimbProgressContext = createContext<ClimbProgressStore | null>(null);
export const useClimbProgressStore = () => useContext(ClimbProgressContext);
