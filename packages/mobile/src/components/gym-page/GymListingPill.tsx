// Who runs a gym, as a pill: "Run by the gym", "Added by a climber" or "Not
// claimed yet" (docs/product/gym-board-governance.md, decision 4). For lists of
// gyms, where every viewer sees the same three words; the gym's own page swaps
// in "You run this gym" and friends for its staff.

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { GymListingState } from '@boardsesh/shared-schema';
import { StatusPill } from '../StatusPill';

function useListingLabel(listingState: GymListingState): string {
  const { t } = useTranslation('boards');
  switch (listingState) {
    case 'RUN_BY_GYM':
      return t('runBy.pillRunByGym');
    case 'CLIMBER_LISTED':
      return t('runBy.pillClimberListed');
    case 'UNCLAIMED':
      return t('runBy.pillUnclaimed');
  }
}

export const GymListingPill = memo(function GymListingPill({
  listingState,
  testID,
}: {
  listingState: GymListingState;
  testID?: string;
}) {
  const label = useListingLabel(listingState);
  return <StatusPill label={label} tone={listingState === 'RUN_BY_GYM' ? 'positive' : 'neutral'} testID={testID} />;
});
