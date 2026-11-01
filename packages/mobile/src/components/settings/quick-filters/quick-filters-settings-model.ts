// Settings › Climbs & grades › Quick filters: which filters sit as chips above a
// list, and in what order. One group per pin store: Climbs (the Climbs tab) and
// Playlists (every playlist, smart playlist and setter page). Pure: the screen
// hands in the stores' pins and handlers, and this lays them out the Settings ›
// Home way. Pinned filters come first, in the climber's order, with a switch and
// ↑/↓ arrows; then the rest in catalog order with a switch only. Switching one
// on pins it last; switching one off unpins it.

import type { MoreFormModel, MoreSection } from '../../MoreForm.types';
import type { SectionLayoutRowModel } from '../../section-layout/SectionLayoutList';
import {
  movableFormRows,
  sectionLayoutToggleRow,
  type MovableFormRows,
} from '../../section-layout/section-layout-form-rows';
import type { SettingsTranslate } from '../root/settings-pages';

/** The two pin stores the page edits, also the prefix of every row key it builds. */
export type QuickFilterSurface = 'climbs' | 'playlists';

/**
 * One store's rows: pinned kinds in the saved order (movable, switched on), then
 * the catalog's other kinds in catalog order (switched off, no arrows). Kinds
 * outside the catalog and repeats drop out.
 */
export function quickFilterRows<K extends string>(
  catalog: readonly K[],
  pinned: readonly K[],
  labelOf: (kind: K) => string,
): SectionLayoutRowModel<K>[] {
  const pinnedKinds = [...new Set(pinned.filter((kind) => catalog.includes(kind)))];
  return [
    ...pinnedKinds.map((kind) => ({ id: kind, label: labelOf(kind), visible: true, movable: true })),
    ...catalog
      .filter((kind) => !pinnedKinds.includes(kind))
      .map((kind) => ({ id: kind, label: labelOf(kind), visible: false, movable: false })),
  ];
}

/** Whether `pinned` is a store's fresh-install set, in its order. */
export function isDefaultPinOrder<K extends string>(pinned: readonly K[], defaults: readonly K[]): boolean {
  return pinned.length === defaults.length && pinned.every((kind, index) => kind === defaults[index]);
}

export type QuickFilterGroupInput<K extends string> = {
  /** The pinned rows, drawn the platform's way (`useMovableFormRows`). */
  pinned: MovableFormRows<K>;
  /** How many kinds are pinned: none leaves the pinned rows out. */
  pinnedCount: number;
  /** The unpinned kinds, as switch-only rows. */
  unpinnedRows: readonly SectionLayoutRowModel<K>[];
  onPinChange: (kind: K, pinned: boolean) => void;
  /** The saved pins have not loaded yet: every switch and arrow is greyed out. */
  disabled: boolean;
};

export type QuickFiltersSettingsModelInput<Climb extends string, Playlist extends string> = {
  t: SettingsTranslate;
  climbs: QuickFilterGroupInput<Climb>;
  playlists: QuickFilterGroupInput<Playlist>;
  canRestoreDefaults: boolean;
  onRestoreDefaults: () => void;
};

/** A group's heading and where its chips show. */
function groupCopy(t: SettingsTranslate, surface: QuickFilterSurface): { title: string; footer: string } {
  return surface === 'climbs'
    ? {
        title: t('mobile.settings.quickFilters.climbsTitle'),
        footer: t('mobile.settings.quickFilters.climbsFooter'),
      }
    : {
        title: t('mobile.settings.quickFilters.playlistsTitle'),
        footer: t('mobile.settings.quickFilters.playlistsFooter'),
      };
}

/**
 * One group as up to two form sections, as Settings › Home splits its movable
 * sections from the feed: the pinned rows, then the unpinned switches. The
 * group's title heads the first and its footer (where the chips show) closes
 * the last, so a group with nothing pinned, or nothing left to pin, still reads
 * as one.
 */
function groupSections<K extends string>(
  t: SettingsTranslate,
  surface: QuickFilterSurface,
  group: QuickFilterGroupInput<K>,
): MoreSection[] {
  // Both groups list Grade, Sort and more: the surface keeps their row keys apart.
  const options = { disabled: group.disabled, keyPrefix: `${surface}.` };
  const sections: MoreSection[] = [];
  if (group.pinnedCount > 0) {
    sections.push({
      key: `${surface}Pinned`,
      rows: movableFormRows(t, group.pinned, group.onPinChange, { ...options, key: `${surface}PinnedRows` }),
    });
  }
  if (group.unpinnedRows.length > 0) {
    sections.push({
      key: `${surface}Unpinned`,
      rows: group.unpinnedRows.map((row) => sectionLayoutToggleRow(row, group.onPinChange, options)),
    });
  }
  const copy = groupCopy(t, surface);
  const [first] = sections;
  const last = sections[sections.length - 1];
  if (first) first.title = copy.title;
  if (last) last.footer = copy.footer;
  return sections;
}

export function buildQuickFiltersSettingsModel<Climb extends string, Playlist extends string>(
  input: QuickFiltersSettingsModelInput<Climb, Playlist>,
): MoreFormModel {
  const { t } = input;
  return {
    sections: [
      ...groupSections(t, 'climbs', input.climbs),
      ...groupSections(t, 'playlists', input.playlists),
      {
        key: 'presets',
        footer: t('mobile.settings.quickFilters.footer'),
        rows: [
          {
            kind: 'button',
            key: 'restoreDefaults',
            label: t('mobile.settings.quickFilters.restoreDefaults'),
            disabled: !input.canRestoreDefaults,
            onPress: input.onRestoreDefaults,
          },
        ],
      },
    ],
  };
}
