// Persistent quick filters shared by Climbs and playlists.
// Board angle belongs to the toolbar in both appearances.
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CapsuleRow } from '../filter-capsules/CapsuleRow';
import { buildClimbCapsules } from './climb-capsules';
import type { FilterChipRowProps } from './FilterChipRow.types';

export const FilterChipRow = memo(function FilterChipRow(props: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const capsules = useMemo(() => buildClimbCapsules(props, t), [props, t]);
  return <CapsuleRow capsules={capsules} dense={props.dense} />;
});
