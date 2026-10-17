// The climb list's persistent filtering row. Board angle lives in the toolbar
// options menu on every platform, leaving these capsules focused on filters.

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CapsuleRow } from '../filter-capsules/CapsuleRow';
import { buildClimbCapsules } from './climb-capsules';
import type { FilterChipRowProps } from './FilterChipRow.types';

function ClimbCapsuleRow(props: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const capsules = useMemo(() => buildClimbCapsules(props, t), [props, t]);
  return <CapsuleRow capsules={capsules} />;
}

export const FilterChipRow = memo(ClimbCapsuleRow);
