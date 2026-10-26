import { describe, expect, it, vi } from 'vitest';
import { PINNABLE_CHIP_CATALOG, type PinnableChipKind } from '../../../../lib/pinnable-chips';
import { withChipPinned } from '../../../../lib/pinned-chips-store';
import { PLAYLIST_PINNABLE_CHIP_CATALOG, type PlaylistPinnableChipKind } from '../../../../lib/playlist-pinnable-chips';
import type { MoreToggleRow } from '../../../MoreForm.types';
import type { PlacedSectionLayoutRow, SectionLayoutRowModel } from '../../../section-layout/SectionLayoutList';
import {
  buildQuickFiltersSettingsModel,
  isDefaultPinOrder,
  quickFilterRows,
  type QuickFilterGroupInput,
  type QuickFiltersSettingsModelInput,
} from '../quick-filters-settings-model';

const echo = (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key);
const label = (kind: string) => `label:${kind}`;

/** [id, switched on, has arrows] per row, in order. */
function summarize(rows: ReturnType<typeof quickFilterRows>) {
  return rows.map((row) => [row.id, row.visible, row.movable]);
}

function hostedGroup<K extends string>(
  catalog: readonly K[],
  pinned: readonly K[],
  overrides: Partial<QuickFilterGroupInput<K>> = {},
): QuickFilterGroupInput<K> {
  const rows = quickFilterRows(catalog, pinned, label);
  return {
    pinned: { kind: 'hosted', content: `hosted ${pinned.join(',')}`, height: 200 },
    pinnedCount: rows.filter((row) => row.movable).length,
    unpinnedRows: rows.filter((row) => !row.movable),
    onPinChange: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

/** The pinned rows placed as `placeSectionLayoutRows` places one group of rows with arrows. */
function placeMovable<K extends string>(rows: readonly SectionLayoutRowModel<K>[]): PlacedSectionLayoutRow<K>[] {
  return rows.map((row, index) => ({
    ...row,
    first: index === 0,
    last: index === rows.length - 1,
    gapAbove: false,
    position: index + 1,
    movableCount: rows.length,
    canMoveUp: index > 0,
    canMoveDown: index < rows.length - 1,
  }));
}

function nativeGroup<K extends string>(
  catalog: readonly K[],
  pinned: readonly K[],
  overrides: Partial<QuickFilterGroupInput<K>> = {},
): QuickFilterGroupInput<K> {
  const rows = quickFilterRows(catalog, pinned, label);
  const pinnedRows = rows.filter((row) => row.movable);
  return {
    ...hostedGroup(catalog, pinned),
    pinned: { kind: 'native', rows: placeMovable(pinnedRows), onMove: vi.fn() },
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<QuickFiltersSettingsModelInput<PinnableChipKind, PlaylistPinnableChipKind>> = {},
): QuickFiltersSettingsModelInput<PinnableChipKind, PlaylistPinnableChipKind> {
  return {
    t: echo,
    climbs: hostedGroup(PINNABLE_CHIP_CATALOG, ['grade', 'rating']),
    playlists: hostedGroup(PLAYLIST_PINNABLE_CHIP_CATALOG, ['sort', 'grade']),
    canRestoreDefaults: true,
    onRestoreDefaults: vi.fn(),
    ...overrides,
  };
}

describe('quickFilterRows', () => {
  it('lists the pinned filters first in the saved order, with arrows, then the rest in catalog order', () => {
    const rows = quickFilterRows(PLAYLIST_PINNABLE_CHIP_CATALOG, ['sort', 'beta', 'grade'], label);
    expect(summarize(rows)).toEqual([
      ['sort', true, true],
      ['beta', true, true],
      ['grade', true, true],
      ['accuracy', false, false],
      ['progress', false, false],
      ['climbType', false, false],
      ['popularity', false, false],
      ['rating', false, false],
      ['boardFit', false, false],
    ]);
    expect(rows[0].label).toBe('label:sort');
  });

  it('drops pins outside the catalog and repeats', () => {
    const pinned = ['rating', 'recent', 'rating', 'tall'] as unknown as PlaylistPinnableChipKind[];
    const rows = quickFilterRows(PLAYLIST_PINNABLE_CHIP_CATALOG, pinned, label);
    expect(rows.filter((row) => row.movable).map((row) => row.id)).toEqual(['rating']);
    expect(rows.map((row) => row.id).sort()).toEqual([...PLAYLIST_PINNABLE_CHIP_CATALOG].sort());
  });

  it('puts a filter switched on at the end of the pinned rows, and one switched off back in catalog order', () => {
    const pinned: readonly PinnableChipKind[] = ['rating', 'grade', 'tall'];
    const switchedOn = quickFilterRows(PINNABLE_CHIP_CATALOG, withChipPinned(pinned, 'beta', true), label);
    expect(switchedOn.filter((row) => row.movable).map((row) => row.id)).toEqual(['rating', 'grade', 'tall', 'beta']);

    const switchedOff = quickFilterRows(PINNABLE_CHIP_CATALOG, withChipPinned(pinned, 'grade', false), label);
    expect(switchedOff.filter((row) => row.movable).map((row) => row.id)).toEqual(['rating', 'tall']);
    expect(switchedOff.filter((row) => !row.movable).map((row) => row.id)).toEqual([
      'recent',
      'grade',
      'accuracy',
      'progress',
      'collection',
      'climbType',
      'wide',
      'beta',
      'popularity',
      'sort',
    ]);
  });

  it('lists everything as switch-only when nothing is pinned', () => {
    const rows = quickFilterRows(PLAYLIST_PINNABLE_CHIP_CATALOG, [], label);
    expect(rows.every((row) => !row.movable && !row.visible)).toBe(true);
    expect(rows.map((row) => row.id)).toEqual([...PLAYLIST_PINNABLE_CHIP_CATALOG]);
  });
});

describe('buildQuickFiltersSettingsModel', () => {
  it('runs Climbs, then Playlists, each pinned rows then the rest, then Restore defaults', () => {
    const model = buildQuickFiltersSettingsModel(makeInput());
    expect(model.sections.map((section) => [section.key, section.title, section.footer])).toEqual([
      ['climbsPinned', 'mobile.settings.quickFilters.climbsTitle', undefined],
      ['climbsUnpinned', undefined, 'mobile.settings.quickFilters.climbsFooter'],
      ['playlistsPinned', 'mobile.settings.quickFilters.playlistsTitle', undefined],
      ['playlistsUnpinned', undefined, 'mobile.settings.quickFilters.playlistsFooter'],
      ['presets', undefined, 'mobile.settings.quickFilters.footer'],
    ]);
  });

  it('hosts the pinned rows as one full-bleed row, and lists the rest as switches that pin', () => {
    const climbs = hostedGroup(PINNABLE_CHIP_CATALOG, ['grade', 'rating']);
    const [pinned, unpinned] = buildQuickFiltersSettingsModel(makeInput({ climbs })).sections;
    expect(pinned.rows).toEqual([
      { kind: 'custom', key: 'climbsPinnedRows', content: 'hosted grade,rating', height: 200, fullBleed: true },
    ]);
    const toggles = unpinned.rows as MoreToggleRow[];
    expect(toggles.map((row) => [row.kind, row.key, row.label, row.value, row.actions])).toEqual([
      ['toggle', 'climbs.recent', 'label:recent', false, undefined],
      ['toggle', 'climbs.accuracy', 'label:accuracy', false, undefined],
      ['toggle', 'climbs.progress', 'label:progress', false, undefined],
      ['toggle', 'climbs.collection', 'label:collection', false, undefined],
      ['toggle', 'climbs.climbType', 'label:climbType', false, undefined],
      ['toggle', 'climbs.tall', 'label:tall', false, undefined],
      ['toggle', 'climbs.wide', 'label:wide', false, undefined],
      ['toggle', 'climbs.beta', 'label:beta', false, undefined],
      ['toggle', 'climbs.popularity', 'label:popularity', false, undefined],
      ['toggle', 'climbs.sort', 'label:sort', false, undefined],
    ]);
    toggles[0].onValueChange(true);
    expect(climbs.onPinChange).toHaveBeenCalledWith('recent', true);
  });

  it('on the native branch, draws pinned switches in order with move buttons dead at the ends', () => {
    const playlists = nativeGroup(PLAYLIST_PINNABLE_CHIP_CATALOG, ['sort', 'grade', 'beta']);
    const section = buildQuickFiltersSettingsModel(makeInput({ playlists })).sections.find(
      (candidate) => candidate.key === 'playlistsPinned',
    );
    const rows = (section?.rows ?? []) as MoreToggleRow[];
    expect(rows.map((row) => [row.key, row.value])).toEqual([
      ['playlists.sort', true],
      ['playlists.grade', true],
      ['playlists.beta', true],
    ]);
    expect(rows.map((row) => row.actions?.map((action) => `${action.icon}:${!action.disabled}`))).toEqual([
      ['moveUp:false', 'moveDown:true'],
      ['moveUp:true', 'moveDown:true'],
      ['moveUp:true', 'moveDown:false'],
    ]);
    expect(rows[1].actions?.[0].accessibilityLabel).toBe(
      'mobile.settings.sectionLayout.moveUp {"section":"label:grade"}',
    );

    rows[1].actions?.[1].onPress();
    if (playlists.pinned.kind !== 'native') throw new Error('not the native branch');
    expect(playlists.pinned.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'grade' }), 1);
    rows[2].onValueChange(false);
    expect(playlists.onPinChange).toHaveBeenCalledWith('beta', false);
  });

  it('greys every switch and arrow out until the saved pins load', () => {
    const climbs = nativeGroup(PINNABLE_CHIP_CATALOG, ['grade', 'rating'], { disabled: true });
    const model = buildQuickFiltersSettingsModel(makeInput({ climbs }));
    const climbRows = model.sections
      .filter((section) => section.key.startsWith('climbs'))
      .flatMap((section) => section.rows) as MoreToggleRow[];
    expect(climbRows.every((row) => row.disabled === true)).toBe(true);
    expect(climbRows.flatMap((row) => row.actions ?? []).every((action) => action.disabled)).toBe(true);
    // The other group has loaded: its switches stay live.
    const playlistToggles = model.sections.find((section) => section.key === 'playlistsUnpinned')
      ?.rows as MoreToggleRow[];
    expect(playlistToggles.some((row) => row.disabled)).toBe(false);
  });

  it('keeps one title and one footer per group when nothing is pinned, or everything is', () => {
    const climbs = hostedGroup(PINNABLE_CHIP_CATALOG, []);
    const playlists = hostedGroup(PLAYLIST_PINNABLE_CHIP_CATALOG, PLAYLIST_PINNABLE_CHIP_CATALOG);
    const model = buildQuickFiltersSettingsModel(makeInput({ climbs, playlists }));
    expect(model.sections.map((section) => [section.key, section.title, section.footer])).toEqual([
      ['climbsUnpinned', 'mobile.settings.quickFilters.climbsTitle', 'mobile.settings.quickFilters.climbsFooter'],
      [
        'playlistsPinned',
        'mobile.settings.quickFilters.playlistsTitle',
        'mobile.settings.quickFilters.playlistsFooter',
      ],
      ['presets', undefined, 'mobile.settings.quickFilters.footer'],
    ]);
  });

  it('offers Restore defaults only when a list changed', () => {
    const onRestoreDefaults = vi.fn();
    const button = (canRestoreDefaults: boolean) => {
      const row = buildQuickFiltersSettingsModel(makeInput({ canRestoreDefaults, onRestoreDefaults })).sections.at(-1)
        ?.rows[0];
      if (row?.kind !== 'button') throw new Error('no Restore defaults button');
      return row;
    };
    expect(button(false).disabled).toBe(true);
    const enabled = button(true);
    expect(enabled.label).toBe('mobile.settings.quickFilters.restoreDefaults');
    expect(enabled.disabled).toBe(false);
    enabled.onPress();
    expect(onRestoreDefaults).toHaveBeenCalledOnce();
  });
});

describe('isDefaultPinOrder', () => {
  it('is true only for the same kinds in the same order', () => {
    expect(isDefaultPinOrder(['grade', 'sort'], ['grade', 'sort'])).toBe(true);
    expect(isDefaultPinOrder(['sort', 'grade'], ['grade', 'sort'])).toBe(false);
    expect(isDefaultPinOrder(['grade'], ['grade', 'sort'])).toBe(false);
  });
});
