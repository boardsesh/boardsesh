'use client';

import { useSyncExternalStore } from 'react';
import { compatibilityBoardSelected } from '@boardsesh/analytics';
import { boardTypeLabel } from '@boardsesh/board-constants/board-type-labels';
import { isBoardTypeVisible, QUANTUM_BOARD_FLAG } from '@boardsesh/board-config/visibility';
import { readPosthogFeatureFlags, subscribePosthogFeatureFlags } from '@/app/lib/analytics';
import { WebsiteJourneyChip } from './website-journey-chip';

const getSnapshot = () => isBoardTypeVisible('quantum', readPosthogFeatureFlags([QUANTUM_BOARD_FLAG]));
const getServerSnapshot = () => false;

/** Keep the shared homepage HTML independent of a visitor's rollout assignment. */
export function QuantumCompatibilityChip() {
  const visible = useSyncExternalStore(subscribePosthogFeatureFlags, getSnapshot, getServerSnapshot);
  if (!visible) return null;
  return (
    <WebsiteJourneyChip
      href="/boards#quantum"
      label={boardTypeLabel('quantum')}
      event={compatibilityBoardSelected('quantum', 'home-chip')}
    />
  );
}
