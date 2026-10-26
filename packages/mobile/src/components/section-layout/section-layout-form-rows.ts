// The native Settings form's rows for a show-hide-and-order list (Settings ›
// Home, Settings › Climbs & grades › Quick filters). Pure: the page hands in its
// rows and handlers, and this lays them out as `MoreForm` rows. The form has no
// reorderable row of its own, so the rows that move draw one of two ways:
//
// - `hosted` (iOS, browser): one React Native row, `SectionLayoutFormList`, the
//   sheet's switch-and-arrows rows inside a full-bleed `custom` row.
// - `native` (Android): a native switch per row in the saved order, each with
//   native move up / move down buttons. The Compose form draws no hosted React
//   Native row on a real phone (QA on a Pixel 8 Pro, #6546).

import type { ReactNode } from 'react';
import type { MoreRow, MoreToggleRow } from '../MoreForm.types';
import type { SectionMoveDirection } from '../../lib/section-layout';
import type { PlacedSectionLayoutRow, SectionLayoutRowModel } from './SectionLayoutList';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** How the rows that move draw; `useMovableFormRows` picks the kind for the platform. */
export type MovableFormRows<Id extends string> =
  | { kind: 'hosted'; content: ReactNode; height: number }
  | {
      kind: 'native';
      rows: readonly PlacedSectionLayoutRow<Id>[];
      onMove: (row: PlacedSectionLayoutRow<Id>, direction: SectionMoveDirection) => void;
    };

type FormRowOptions = {
  /** Greys the switches and arrows out, such as while the saved order still loads. */
  disabled?: boolean;
  /** Put before each row's id to make its key, for a page with two lists that share ids. */
  keyPrefix?: string;
};

/** A row that keeps its place: a native switch. */
export function sectionLayoutToggleRow<Id extends string>(
  row: SectionLayoutRowModel<Id>,
  onChange: (rowId: Id, visible: boolean) => void,
  { disabled, keyPrefix = '' }: FormRowOptions = {},
): MoreToggleRow {
  return {
    kind: 'toggle',
    key: `${keyPrefix}${row.id}`,
    label: row.label,
    subtitle: row.description,
    value: row.visible,
    ...(disabled ? { disabled: true } : null),
    onValueChange: (visible: boolean) => onChange(row.id, visible),
  };
}

/** The rows that move, as the form draws them: one hosted row, or native switches with ↑/↓ buttons. */
export function movableFormRows<Id extends string>(
  t: Translate,
  movable: MovableFormRows<Id>,
  onChange: (rowId: Id, visible: boolean) => void,
  { key, disabled, keyPrefix }: FormRowOptions & { key: string },
): MoreRow[] {
  if (movable.kind === 'hosted') {
    return [{ kind: 'custom', key, content: movable.content, height: movable.height, fullBleed: true }];
  }
  return movable.rows.map((row) => ({
    ...sectionLayoutToggleRow(row, onChange, { disabled, keyPrefix }),
    // Disabled at the ends of the group.
    actions: [
      {
        key: 'moveUp',
        icon: 'moveUp',
        accessibilityLabel: t('mobile.settings.sectionLayout.moveUp', { section: row.label }),
        disabled: disabled || !row.canMoveUp,
        onPress: () => movable.onMove(row, -1),
      },
      {
        key: 'moveDown',
        icon: 'moveDown',
        accessibilityLabel: t('mobile.settings.sectionLayout.moveDown', { section: row.label }),
        disabled: disabled || !row.canMoveDown,
        onPress: () => movable.onMove(row, 1),
      },
    ],
  }));
}
