// The climbs list's persistent filter row (the GitHub-PR-view idiom): Filters · N,
// Recent and the user's pinned chips, under the climbs title. Mounted by the
// caller; never on search focus.
//
// A climbs adapter over the shared quick-filter row: buildClimbCapsules
// (climb-capsules.ts) turns these props into capsule descriptors and CapsuleRow
// (filter-capsules/) draws them natively per platform: SwiftUI glass on iOS,
// Compose FilterChips on Android, Paper chips on the web.
//
// Android and the web lead with an Angle capsule: it re-grades the whole list,
// so it sits with the other list refinements rather than in the app bar. It
// reads the active board, owns its own selector sheet and is absent on
// fixed-angle boards. iOS keeps its toolbar angle island instead.

import { memo, useMemo } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CapsuleRow } from '../filter-capsules/CapsuleRow';
import { useMaterialAngleControl } from '../chrome/use-material-angle-control';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { buildClimbCapsules, type ClimbAngleCapsule } from './climb-capsules';
import type { FilterChipRowProps } from './FilterChipRow.types';

function ClimbCapsuleRow(props: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const capsules = useMemo(() => buildClimbCapsules(props, t, null), [props, t]);
  return <CapsuleRow capsules={capsules} />;
}

function ClimbCapsuleRowWithAngle(props: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const {
    activeBoard,
    canAdjust: canAdjustAngle,
    visible: angleSheetVisible,
    open: openAngle,
    close: closeAngle,
    change: changeAngle,
  } = useMaterialAngleControl();
  const angleLabel = canAdjustAngle && activeBoard ? `${activeBoard.angle}°` : null;
  const angle = useMemo<ClimbAngleCapsule | null>(
    () =>
      angleLabel == null
        ? null
        : { label: angleLabel, accessibilityLabel: t('angleSelector.selectAngle'), onPress: openAngle },
    [angleLabel, openAngle, t],
  );
  const capsules = useMemo(() => buildClimbCapsules(props, t, angle), [props, t, angle]);
  return (
    <>
      <CapsuleRow capsules={capsules} />
      {canAdjustAngle && activeBoard ? (
        <AngleSelectorSheet
          visible={angleSheetVisible}
          onClose={closeAngle}
          boardName={activeBoard.boardType}
          layoutId={activeBoard.layoutId}
          currentAngle={activeBoard.angle}
          onAngleChange={changeAngle}
        />
      ) : null}
    </>
  );
}

// Fixed per platform at module load, so neither component ever switches hooks.
export const FilterChipRow = memo(Platform.OS === 'ios' ? ClimbCapsuleRow : ClimbCapsuleRowWithAngle);
