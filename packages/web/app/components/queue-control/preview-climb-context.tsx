'use client';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { Climb } from '@/app/lib/types';

type PreviewClimbContextValue = {
  previewClimb: Climb | null;
  setPreviewClimb: (climb: Climb | null) => void;
};

const NOOP_VALUE: PreviewClimbContextValue = {
  previewClimb: null,
  setPreviewClimb: () => {},
};

const PreviewClimbContext = createContext<PreviewClimbContextValue>(NOOP_VALUE);

export function PreviewClimbProvider({ children }: { children: React.ReactNode }) {
  const [previewClimb, setPreviewClimbState] = useState<Climb | null>(null);

  const setPreviewClimb = useCallback((climb: Climb | null) => {
    setPreviewClimbState(climb);
  }, []);

  const value = useMemo<PreviewClimbContextValue>(
    () => ({ previewClimb, setPreviewClimb }),
    [previewClimb, setPreviewClimb],
  );

  return <PreviewClimbContext.Provider value={value}>{children}</PreviewClimbContext.Provider>;
}

export function usePreviewClimb(): PreviewClimbContextValue {
  return useContext(PreviewClimbContext);
}
