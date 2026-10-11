import { describe, expect, it, vi } from 'vitest';

// `theme/tokens` reaches `ios-colors`, which calls these at module load.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: () => undefined },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));

import {
  CLIMB_ROW_GUTTER,
  CLIMB_ROW_MIN_HEIGHT,
  CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT,
  CLIMB_ROW_VERTICAL_PADDING,
  DEFAULT_CLIMB_ROW_SURFACE,
  climbRowLayout,
  climbRowReorderHeight,
  climbRowSeparatorInset,
  climbRowSkeletonCount,
  type ClimbRowLayoutInput,
  type ClimbRowSurface,
} from '../climb-row-layout';
import { THUMBNAIL_WIDTH } from '../climb-list-thumbnail-metrics';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_PRESETS,
  DEFAULT_CLIMB_ROW_DISPLAY,
  type ClimbRowDisplay,
} from '../../lib/climb-row-display';
import { materialTextStyles } from '../../theme/typography';

describe('climbRowSeparatorInset', () => {
  it('starts a plain row’s separator at the text column: gutter, thumbnail, gap', () => {
    expect(THUMBNAIL_WIDTH).toBe(76);
    expect(CLIMB_ROW_GUTTER).toBe(16);
    expect(climbRowSeparatorInset(true)).toBe(104);
  });

  it('starts at the gutter when the row has no thumbnail', () => {
    expect(climbRowSeparatorInset(false)).toBe(16);
  });

  // Where each real host ends up is pinned against the host itself, in
  // climb-row-separator-hosts.test.tsx. This file is the arithmetic only.
  it('adds the thumbnail and one gap to a host’s own leading inset', () => {
    expect(climbRowSeparatorInset(true, 52)).toBe(52 + 76 + 12);
    expect(climbRowSeparatorInset(true, 12)).toBe(12 + 76 + 12);
  });

  it('falls back to the host’s own leading inset without a thumbnail', () => {
    expect(climbRowSeparatorInset(false, 52)).toBe(52);
    expect(climbRowSeparatorInset(false, 12)).toBe(12);
  });

  it('measures the leading inset from the row edge, replacing the gutter rather than adding to it', () => {
    expect(climbRowSeparatorInset(true, CLIMB_ROW_GUTTER)).toBe(climbRowSeparatorInset(true));
    expect(climbRowSeparatorInset(true, 0)).toBe(88);
  });
});

// The surfaces that reuse the row visual, as each sets its props.
const CLIMBS_LIST: ClimbRowSurface = { ...DEFAULT_CLIMB_ROW_SURFACE, showPlaylistChips: true, showProgress: true };
const PLAYLIST_EDITOR: ClimbRowSurface = { ...DEFAULT_CLIMB_ROW_SURFACE, showAscentStatus: false };
const SESSION_MULTI_USER: ClimbRowSurface = {
  showAscentStatus: false,
  showPlaylistChips: false,
  detailLine: 'replaced',
};
const SESSION_SOLO: ClimbRowSurface = { showAscentStatus: false, showPlaylistChips: false, detailLine: 'hidden' };

const TEXT_ONLY: ClimbRowDisplay = { ...CLIMB_ROW_PRESETS.textOnly, quickActions: true };
const NAMES_ONLY: ClimbRowDisplay = { ...CLIMB_ROW_PRESETS.namesOnly, quickActions: true };

function layoutOf(overrides: Partial<ClimbRowLayoutInput> = {}) {
  return climbRowLayout({
    display: DEFAULT_CLIMB_ROW_DISPLAY,
    surface: CLIMBS_LIST,
    supportsMirroring: false,
    ...overrides,
  });
}

describe('climbRowLayout: the row’s structure', () => {
  it('describes today’s row for a climber who has touched nothing', () => {
    expect(layoutOf()).toEqual({
      hasThumbnail: true,
      hasDetailLine: true,
      communityGradePlace: 'detailLine',
      sentMarkPlace: 'besideGrade',
      hasPersonalLine: false,
      hasProgressLine: false,
      hasTagsLine: false,
      reservesLateLines: false,
      minHeight: 44,
      separatorInset: 104,
      estimatedHeight: 112,
    });
  });

  it('describes the text-only row: no thumbnail, late lines reserved, separator at the gutter', () => {
    expect(layoutOf({ display: TEXT_ONLY })).toEqual({
      hasThumbnail: false,
      hasDetailLine: true,
      communityGradePlace: 'detailLine',
      sentMarkPlace: 'besideGrade',
      hasPersonalLine: false,
      hasProgressLine: false,
      hasTagsLine: false,
      reservesLateLines: true,
      minHeight: 44,
      separatorInset: 16,
      estimatedHeight: 58,
    });
  });

  it('reserves late lines exactly when there is no thumbnail to fix the row’s height', () => {
    expect(layoutOf().reservesLateLines).toBe(false);
    expect(layoutOf({ display: { ...DEFAULT_CLIMB_ROW_DISPLAY, thumbnail: false } }).reservesLateLines).toBe(true);
  });

  it.each([
    { sends: true, rating: true, setter: true },
    { sends: true, rating: false, setter: false },
    { sends: false, rating: true, setter: false },
    { sends: false, rating: false, setter: true },
  ])('has a detail line while any of its own tokens is on (%o), with the community grade on it', (tokens) => {
    const withToken = layoutOf({ display: { ...DEFAULT_CLIMB_ROW_DISPLAY, ...tokens } });
    const withoutToken = layoutOf({ display: { ...DEFAULT_CLIMB_ROW_DISPLAY, ...tokens, communityGrade: false } });

    expect(withToken.hasDetailLine).toBe(true);
    expect(withToken.communityGradePlace).toBe('detailLine');
    expect(withoutToken.hasDetailLine).toBe(true);
    expect(withoutToken.communityGradePlace).toBe('none');
  });

  it('has no detail line with sends, rating and setter all off, and docks the community grade on the name line', () => {
    const noTokens = { ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false };

    expect(layoutOf({ display: noTokens })).toMatchObject({ hasDetailLine: false, communityGradePlace: 'nameLine' });
    expect(layoutOf({ display: { ...noTokens, communityGrade: false } })).toMatchObject({
      hasDetailLine: false,
      communityGradePlace: 'none',
    });
  });

  it('leaves a host’s own detail line alone: there whatever the switches say, and never with a community grade', () => {
    for (const display of [DEFAULT_CLIMB_ROW_DISPLAY, NAMES_ONLY]) {
      expect(layoutOf({ display, surface: SESSION_MULTI_USER })).toMatchObject({
        hasDetailLine: true,
        communityGradePlace: 'none',
      });
      expect(layoutOf({ display, surface: SESSION_SOLO })).toMatchObject({
        hasDetailLine: false,
        communityGradePlace: 'none',
      });
    }
  });

  it('puts the sent mark beside the grade, or on the personal line of a board that mirrors', () => {
    expect(layoutOf()).toMatchObject({ sentMarkPlace: 'besideGrade', hasPersonalLine: false });
    expect(layoutOf({ supportsMirroring: true })).toMatchObject({
      sentMarkPlace: 'personalLine',
      hasPersonalLine: true,
    });
  });

  it.each([false, true])('has no sent mark with the switch off (board mirrors: %s)', (supportsMirroring) => {
    const display = { ...DEFAULT_CLIMB_ROW_DISPLAY, sentMark: false };

    expect(layoutOf({ display, supportsMirroring })).toMatchObject({ sentMarkPlace: 'none', hasPersonalLine: false });
  });

  it.each([false, true])('has none on a host that shows the status itself (board mirrors: %s)', (supportsMirroring) => {
    expect(layoutOf({ surface: PLAYLIST_EDITOR, supportsMirroring })).toMatchObject({
      sentMarkPlace: 'none',
      hasPersonalLine: false,
      hasProgressLine: false,
    });
  });

  it('has a tags line only where the host can show tags AND the climber switched them on', () => {
    const tagsOn = { ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: true };

    expect(layoutOf({ display: tagsOn, surface: CLIMBS_LIST }).hasTagsLine).toBe(true);
    expect(layoutOf({ display: tagsOn, surface: DEFAULT_CLIMB_ROW_SURFACE }).hasTagsLine).toBe(false);
    expect(layoutOf({ surface: CLIMBS_LIST }).hasTagsLine).toBe(false);
  });

  it('starts the separator after the host’s own leading slot, and after the thumbnail only when there is one', () => {
    const queue = { ...DEFAULT_CLIMB_ROW_SURFACE, leadingInset: 52 };

    expect(layoutOf({ surface: queue }).separatorInset).toBe(140);
    expect(layoutOf({ surface: queue, display: TEXT_ONLY }).separatorInset).toBe(52);
  });

  // The ⋮ button is a way into a climb, not a line of the row.
  it('answers the same whether the quick-actions button is on or off', () => {
    for (const display of [DEFAULT_CLIMB_ROW_DISPLAY, TEXT_ONLY, NAMES_ONLY]) {
      expect(layoutOf({ display: { ...display, quickActions: false } })).toEqual(layoutOf({ display }));
    }
  });

  // Every content switch is read: flipping it changes the answer for at least
  // one row. A field added to the registry and forgotten in the layout function
  // would change none, and fail here.
  it.each(CLIMB_ROW_FIELD_IDS.filter((fieldId) => fieldId !== 'quickActions'))(
    'changes its answer for some row when %s is flipped',
    (fieldId) => {
      const everyDisplay = CLIMB_ROW_FIELD_IDS.reduce<ClimbRowDisplay[]>(
        (displays, id) => displays.flatMap((display) => [true, false].map((on) => ({ ...display, [id]: on }))),
        [DEFAULT_CLIMB_ROW_DISPLAY],
      );
      const answer = (display: ClimbRowDisplay) =>
        JSON.stringify([false, true].map((supportsMirroring) => layoutOf({ display, supportsMirroring })));

      const rowsItChanges = everyDisplay.filter(
        (display) => answer(display) !== answer({ ...display, [fieldId]: !display[fieldId] }),
      );

      expect(everyDisplay).toHaveLength(2 ** CLIMB_ROW_FIELD_IDS.length);
      expect(rowsItChanges.length).toBeGreaterThan(0);
    },
  );
});

describe('climbRowLayout: the estimated height', () => {
  it('is a touch target at the least, and that floor is the text column’s less the row’s padding', () => {
    expect(CLIMB_ROW_MIN_HEIGHT).toBe(44);
    expect(CLIMB_ROW_VERTICAL_PADDING).toBe(8);
    expect(CLIMB_ROW_MIN_TEXT_COLUMN_HEIGHT).toBe(28);
  });

  // The targets from the design, at default text on the HIG type scale.
  it.each([
    { label: 'name and grade only', display: NAMES_ONLY, supportsMirroring: false, height: 44 },
    { label: 'the default switches', display: TEXT_ONLY, supportsMirroring: false, height: 58 },
    {
      label: 'with playlist tags',
      display: { ...TEXT_ONLY, playlistTags: true },
      supportsMirroring: false,
      height: 84,
    },
    // 78 in the design, which counted an 18pt personal line. The direction
    // statuses are set in the 13pt caption, so the line is 5pt shorter.
    { label: 'the default switches on a board that mirrors', display: TEXT_ONLY, supportsMirroring: true, height: 73 },
    {
      label: 'everything on a board that mirrors',
      display: { ...TEXT_ONLY, playlistTags: true },
      supportsMirroring: true,
      height: 99,
    },
  ])('without a thumbnail, $label: $height', ({ display, supportsMirroring, height }) => {
    expect(layoutOf({ display, supportsMirroring }).estimatedHeight).toBe(height);
  });

  it('is the thumbnail’s 112 beside a thumbnail, whatever text is switched on at default size', () => {
    const everything = { ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: true };

    expect(layoutOf().estimatedHeight).toBe(112);
    expect(layoutOf({ display: { ...NAMES_ONLY, thumbnail: true } }).estimatedHeight).toBe(112);
    expect(layoutOf({ display: everything }).estimatedHeight).toBe(112);
    expect(layoutOf({ supportsMirroring: true }).estimatedHeight).toBe(112);
  });

  it('grows past the thumbnail when a loaded row’s lines do: tags and both directions on a board that mirrors', () => {
    const everything = { ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: true };

    // 22 + 18 + two stacked 13pt statuses and their 1pt gap + the 24pt tags line, three 2pt gaps: 97pt of text.
    expect(layoutOf({ display: everything, supportsMirroring: true }).estimatedHeight).toBe(113);
  });

  it('grows with the system text size: lines scale, gaps and padding do not', () => {
    const heightAt = (fontScale: number, display: ClimbRowDisplay = TEXT_ONLY) =>
      layoutOf({ display, fontScale }).estimatedHeight;

    expect(heightAt(1)).toBe(58);
    // Two name lines from 1.3: (44 + 18) × 1.3 + 2 + 16.
    expect(heightAt(1.3)).toBe(99);
    expect(heightAt(1.5)).toBe(111);
    expect(heightAt(2)).toBe(142);
    // A whole number of points, rounded up, so a window sized by it never clips.
    expect(heightAt(1.15)).toBe(64);
    // Below default size the row gets shorter, down to the touch target.
    expect(heightAt(0.85)).toBe(52);
    expect(heightAt(0.85, NAMES_ONLY)).toBe(44);
  });

  it('lets a lone name line pass the floor once the text is large enough', () => {
    // Two name lines are taller than the grade: 44 × 1.5 + 16.
    expect(layoutOf({ display: NAMES_ONLY, fontScale: 1.5 }).estimatedHeight).toBe(82);
  });

  it('keeps reorder names on one line at large text sizes', () => {
    expect(
      climbRowLayout({
        display: NAMES_ONLY,
        surface: DEFAULT_CLIMB_ROW_SURFACE,
        supportsMirroring: false,
        fontScale: 1.5,
        allowNameWrapping: false,
      }).estimatedHeight,
    ).toBe(54);
  });

  it('stops growing the tags line at its own cap of 1.3', () => {
    const withTags = { ...TEXT_ONLY, playlistTags: true };
    const tagsLineAt = (fontScale: number) =>
      layoutOf({ display: withTags, fontScale }).estimatedHeight -
      layoutOf({ display: TEXT_ONLY, fontScale }).estimatedHeight;

    // 2pt gap + 4pt margin + a 20pt chip.
    expect(tagsLineAt(1)).toBe(26);
    // The chip is its capped 16 × 1.3 label plus 4pt of padding: 24.8, with the gap and margin.
    expect(tagsLineAt(1.3)).toBeCloseTo(31, 0);
    expect(tagsLineAt(2)).toBe(tagsLineAt(1.3));
  });

  it('grows past the thumbnail at accessibility sizes', () => {
    expect(layoutOf({ fontScale: 2 }).estimatedHeight).toBe(142);
    // (44 + 18) × 3 + 2 + 16.
    expect(layoutOf({ fontScale: 3 }).estimatedHeight).toBe(204);
  });

  it('uses the type scale it is given: Material’s lines are not the HIG’s', () => {
    const material = (display: ClimbRowDisplay, supportsMirroring = false) =>
      layoutOf({ display, supportsMirroring, typeScale: materialTextStyles }).estimatedHeight;

    // 24 + 2 + 16 comes to the HIG's 22 + 2 + 18.
    expect(material(TEXT_ONLY)).toBe(58);
    // Material's caption is 16pt where the HIG's is 13.
    expect(material(TEXT_ONLY, true)).toBe(76);
    // Its grade line is 28pt, which is the floor exactly.
    expect(material(NAMES_ONLY)).toBe(44);
  });

  it('falls back to the HIG line height for a variant the given scale leaves out', () => {
    expect(layoutOf({ display: TEXT_ONLY, typeScale: { body: { lineHeight: 30 } } }).estimatedHeight).toBe(66);
  });

  it('does not let the font scale or the type scale change the structure', () => {
    const { estimatedHeight: _default, ...structure } = layoutOf({ display: TEXT_ONLY, supportsMirroring: true });
    const { estimatedHeight: _scaled, ...scaledStructure } = layoutOf({
      display: TEXT_ONLY,
      supportsMirroring: true,
      fontScale: 2,
      typeScale: materialTextStyles,
    });

    expect(scaledStructure).toEqual(structure);
  });
});

describe('climbRowSkeletonCount', () => {
  it('keeps the count for a row of the default height', () => {
    expect(climbRowSkeletonCount(10, 112)).toBe(10);
    expect(climbRowSkeletonCount(6, 112)).toBe(6);
  });

  it('draws as many shorter rows as cover the same height, rounded up', () => {
    // 10 × 112 = 1120pt.
    expect(climbRowSkeletonCount(10, 58)).toBe(20);
    expect(climbRowSkeletonCount(10, 44)).toBe(26);
    expect(climbRowSkeletonCount(10, 84)).toBe(14);
    expect(climbRowSkeletonCount(6, 44)).toBe(16);
  });

  it('never draws fewer than the default count for a taller row', () => {
    expect(climbRowSkeletonCount(10, 138)).toBe(10);
  });

  it('keeps the default count for a height that makes no sense', () => {
    expect(climbRowSkeletonCount(10, 0)).toBe(10);
    expect(climbRowSkeletonCount(10, -5)).toBe(10);
    expect(climbRowSkeletonCount(10, Number.NaN)).toBe(10);
  });
});

describe('personal progress geometry', () => {
  it('reserves progress without a picture before auth or history settles', () => {
    const layout = layoutOf({ display: { ...TEXT_ONLY, progress: true } });
    expect(layout).toMatchObject({
      hasProgressLine: true,
      hasPersonalLine: true,
      reservesLateLines: true,
      sentMarkPlace: 'none',
      estimatedHeight: 78,
    });
  });
  it('combines mirror statuses and progress into one personal line', () => {
    const display = { ...TEXT_ONLY, progress: true };
    const layout = layoutOf({ display, supportsMirroring: true });
    expect(layout).toMatchObject({
      hasProgressLine: true,
      hasPersonalLine: true,
      sentMarkPlace: 'personalLine',
      estimatedHeight: 78,
    });
    expect(layoutOf({ display: { ...display, sentMark: false }, supportsMirroring: true }).estimatedHeight).toBe(
      layout.estimatedHeight,
    );
  });
  it('leaves reorder hosts unchanged even with Everything selected', () => {
    const display = { ...CLIMB_ROW_PRESETS.everything, quickActions: true };
    expect(layoutOf({ display, surface: PLAYLIST_EDITOR })).toEqual(
      layoutOf({ display: { ...display, progress: false }, surface: PLAYLIST_EDITOR }),
    );
  });
  it('caps progress text height at 1.3 while names and details keep scaling', () => {
    const display = { ...TEXT_ONLY, progress: true };
    const before = layoutOf({ display, fontScale: 1.3 });
    const after = layoutOf({ display, fontScale: 1.5 });
    expect(after.estimatedHeight - before.estimatedHeight).toBeLessThan(16);
  });
});

describe('uniform reorder geometry', () => {
  const namesOnly = { ...CLIMB_ROW_PRESETS.namesOnly, quickActions: true };
  const noStatuses = { ...DEFAULT_CLIMB_ROW_SURFACE, showAscentStatus: false };
  it('uses the mirror row budget throughout a mixed-board queue, regardless of row order', () => {
    const rows = [{ supportsMirroring: false }, { supportsMirroring: true }, { supportsMirroring: false }];
    const height = climbRowReorderHeight({ display: TEXT_ONLY, surface: DEFAULT_CLIMB_ROW_SURFACE, rows });
    expect(height).toBe(73);
    expect(
      climbRowReorderHeight({ display: TEXT_ONLY, surface: DEFAULT_CLIMB_ROW_SURFACE, rows: [...rows].reverse() }),
    ).toBe(height);
    expect(
      climbRowReorderHeight({
        display: TEXT_ONLY,
        surface: DEFAULT_CLIMB_ROW_SURFACE,
        rows: [{ supportsMirroring: false }],
      }),
    ).toBe(58);
  });
  it('holds the grade floor for Names only, including ungraded rows at large text', () => {
    expect(
      climbRowReorderHeight({
        display: namesOnly,
        surface: noStatuses,
        rows: [{ supportsMirroring: false }],
        fontScale: 1.5,
      }),
    ).toBe(54);
  });
  it('includes the set-angle grade caption even when the text column is shorter', () => {
    expect(
      climbRowReorderHeight({
        display: namesOnly,
        surface: DEFAULT_CLIMB_ROW_SURFACE,
        rows: [{ supportsMirroring: false, hasSetAngleMarker: true }],
        fontScale: 1.5,
      }),
    ).toBe(72);
  });
  it.each([1, 1.5])('reserves both warning lines and the remove target at font scale %s', (fontScale) => {
    expect(
      climbRowReorderHeight({
        display: namesOnly,
        surface: noStatuses,
        rows: [{ supportsMirroring: false }, { supportsMirroring: false, unrenderable: true }],
        fontScale,
      }),
    ).toBe(fontScale === 1 ? 76 : 105);
  });
  it('uses actual theme typography for mirror labels above the thumbnail floor', () => {
    const rows = [{ supportsMirroring: false }, { supportsMirroring: true }];
    expect(
      climbRowReorderHeight({
        display: DEFAULT_CLIMB_ROW_DISPLAY,
        surface: DEFAULT_CLIMB_ROW_SURFACE,
        rows,
        fontScale: 1.5,
      }),
    ).toBe(120);
    const materialHeight = climbRowReorderHeight({
      display: DEFAULT_CLIMB_ROW_DISPLAY,
      surface: DEFAULT_CLIMB_ROW_SURFACE,
      rows,
      fontScale: 1.5,
      typeScale: materialTextStyles,
    });
    expect(materialHeight).toBeGreaterThanOrEqual(112);
    expect(materialHeight).not.toBe(120);
  });
});
