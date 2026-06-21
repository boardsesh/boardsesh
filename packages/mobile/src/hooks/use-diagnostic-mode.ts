import { useEffect, useState } from 'react';
import {
  getDiagnosticMode,
  getDiagnosticState,
  initializeDiagnostics,
  isDiagnosticLoggingEnabled,
  subscribeDiagnosticState,
  type DiagnosticMode,
} from '../lib/diagnostic-logger';

export function useDiagnosticMode(): DiagnosticMode {
  const [mode, setMode] = useState<DiagnosticMode>(() => getDiagnosticMode());

  useEffect(() => {
    if (!isDiagnosticLoggingEnabled) return undefined;
    initializeDiagnostics();
    return subscribeDiagnosticState((state) => {
      setMode(state.mode);
    });
  }, []);

  return isDiagnosticLoggingEnabled ? mode : 'normal';
}

export function useDiagnosticState() {
  const [state, setState] = useState(() => getDiagnosticState());

  useEffect(() => {
    if (!isDiagnosticLoggingEnabled) return undefined;
    initializeDiagnostics();
    return subscribeDiagnosticState(setState);
  }, []);

  return state;
}
