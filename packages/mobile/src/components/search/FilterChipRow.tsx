// The climbs list's persistent filter row (the GitHub-PR-view idiom): Filters · N,
// Recent and the user's pinned chips, under the climbs title. Mounted by the
// caller; never on search focus.
//
// A climbs adapter over the shared quick-filter row: buildClimbCapsules
// (climb-capsules.ts) turns these props into capsule descriptors and CapsuleRow
// (filter-capsules/) draws them natively per platform: SwiftUI glass on iOS,
// Compose FilterChips on Android, Paper chips on the web.
//
// The Material variant (Android and the web by default) leads with an Angle
// capsule: it re-grades the whole list, so it sits with the other list
// refinements rather than in the app bar. It reads the active board, opens the
// shared BoardAnglePicker and is absent on fixed-angle boards. Liquid Glass keeps
// its toolbar angle button instead. Keyed on the variant, not the platform, so
// the angle shows exactly once in either look. A playlist's row passes
// `showAngle={false}`: no list but Climbs carries an angle control.

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createVariantComponent } from '../../theme/variants';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { canAdjustBoardAngle } from '../../lib/boards/can-adjust-board-angle';
import { CapsuleRow } from '../filter-capsules/CapsuleRow';
import { BoardAnglePicker } from '../chrome/BoardAnglePicker';
import { buildClimbCapsules, type ClimbAngleCapsule } from './climb-capsules';
import type { FilterChipRowProps } from './FilterChipRow.types';

function ClimbCapsuleRow(props: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const capsules = useMemo(() => buildClimbCapsules(props, t, null), [props, t]);
  return <CapsuleRow capsules={capsules} />;
}

function AngleCapsuleRow({ rowProps, openAngle }: { rowProps: FilterChipRowProps; openAngle: () => void }) {
  const { t } = useTranslation('climbs');
  const { t: tSession } = useTranslation('session');
  const { data: activeBoard } = useActiveBoard();
  const angleValue = canAdjustBoardAngle(activeBoard) ? activeBoard.angle : null;
  const angle = useMemo<ClimbAngleCapsule | null>(
    () =>
      angleValue == null
        ? null
        : {
            label: `${angleValue}°`,
            accessibilityLabel: tSession('mobile.angleSelector.buttonAria', { angle: angleValue }),
            onPress: openAngle,
          },
    [angleValue, openAngle, tSession],
  );
  const capsules = useMemo(() => buildClimbCapsules(rowProps, t, angle), [rowProps, t, angle]);
  return <CapsuleRow capsules={capsules} />;
}

// The row is the picker's trigger. BoardAnglePicker draws its sheet beside the
// row, and drops a picker left open across a board or angle change. A row that
// asks for no Angle capsule (a playlist's, `showAngle={false}`) is the plain row.
function ClimbCapsuleRowWithAngle(props: FilterChipRowProps) {
  if (props.showAngle === false) return <ClimbCapsuleRow {...props} />;
  return (
    <BoardAnglePicker>{(openAngle) => <AngleCapsuleRow rowProps={props} openAngle={openAngle} />}</BoardAnglePicker>
  );
}

// A variant change swaps the component type, so React remounts instead of
// switching hooks inside one component.
export const FilterChipRow = memo(
  createVariantComponent('FilterChipRow', { liquidGlass: ClimbCapsuleRow, material: ClimbCapsuleRowWithAngle }),
);
