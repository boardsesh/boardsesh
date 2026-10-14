import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { MoreFormModel, MoreRow } from '../components/MoreForm.types';
import { track } from './analytics';

/**
 * Wrap every toggle, select and segmented row in a Settings page model so a
 * change reports `Setting Changed { page, key, value }`.
 *
 * Most settings rows fire no event of their own, which left the Settings root
 * ordered by guesswork for theme, grades, Bluetooth and language. Wrapping the
 * MODEL (not each handler) keeps one event shape for every page and means a row
 * added later is counted without anyone remembering to.
 *
 * `value` is the boolean or the option key — never a label or free text — so the
 * event carries no personal data. Consent gating happens in `track`.
 *
 * `skipKeys` leaves a row unwrapped: a row whose change can still be cancelled
 * after the tap (a confirm dialog) fires the event itself once it really lands,
 * so a cancelled change is never counted.
 */
export function withSettingTracking(
  model: MoreFormModel,
  page: string,
  { skipKeys }: { skipKeys?: ReadonlySet<string> } = {},
): MoreFormModel {
  return {
    ...model,
    sections: model.sections.map((section) => ({
      ...section,
      rows: section.rows.map((row) => (skipKeys?.has(row.key) ? row : trackRow(row, page))),
    })),
  };
}

/** Report one settings change by hand — for the `skipKeys` rows above. */
export function trackSettingChanged(page: string, key: string, value: boolean | string): void {
  track(SHARED_EVENTS.SettingChanged, { page, key, value });
}

function trackRow(row: MoreRow, page: string): MoreRow {
  switch (row.kind) {
    case 'toggle': {
      const { onValueChange } = row;
      return {
        ...row,
        onValueChange: (next: boolean) => {
          trackSettingChanged(page, row.key, next);
          onValueChange(next);
        },
      };
    }
    case 'select':
    case 'segmented': {
      const { onSelect } = row;
      return {
        ...row,
        onSelect: (optionKey: string) => {
          if (optionKey !== row.selectedKey) {
            trackSettingChanged(page, row.key, optionKey);
          }
          onSelect(optionKey);
        },
      };
    }
    default:
      return row;
  }
}
