'use client';

import { useMemo } from 'react';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { isBoardTypeVisible } from '@boardsesh/board-config/visibility';
import { useFeatureFlags } from '@/app/components/providers/feature-flags-provider';

export function useVisibleBoardTypes() {
  const flags = useFeatureFlags();
  return useMemo(
    () => SUPPORTED_BOARDS.filter((board) => board !== 'spray' && isBoardTypeVisible(board, flags)),
    [flags],
  );
}
