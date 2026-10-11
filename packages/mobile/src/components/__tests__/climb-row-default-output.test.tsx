// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The guard for the configurable-row work: a climber who has touched nothing
// must get exactly the row they had. Every assertion spells out what is expected
// (no snapshot), so a change to the default row has to be made here on purpose.
//
// One such change has been made: the grade column holds one grade. Where it is
// not the community's (the climber's own, or a Boardsesh grade) and the two read
// differently, the community's grade leads the detail line instead of standing
// under the climber's own. "the community grade switch" below pins it.

type StatusEntry = { status: 'flash' | 'send' | 'attempt'; is_ascent: boolean; tries: number; is_mirror: boolean };

const live = vi.hoisted(() => ({
  statsCalls: 0,
  gradeCalls: 0,
  myGradeCalls: 0,
  myGrade: { status: 'unknown' } as { status: 'unknown' } | { status: 'set'; difficultyId: number; climbedAt: null },
  logbook: null as { logbookByClimbAngle: Map<string, StatusEntry[]> } | null,
  thumbnailProps: [] as Record<string, unknown>[],
}));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    Platform: { OS: 'ios', select: () => undefined },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <Styles,>(styles: Styles): Styles => styles, flatten: flattenStyle, hairlineWidth: 0.5 },
    View: ({
      children,
      style,
      testID,
      accessibilityLabel,
      accessibilityRole,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
      accessibilityLabel?: string;
      accessibilityRole?: string;
    }) =>
      createElement(
        'div',
        {
          'data-testid': testID,
          'aria-label': accessibilityLabel,
          'data-role': accessibilityRole,
          'data-style': JSON.stringify(flattenStyle(style)),
        },
        children,
      ),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { formattedCount?: string }) =>
      key === 'sends' && options?.formattedCount ? `${options.formattedCount} sends` : key,
  }),
}));

vi.mock('@boardsesh/board-react', () => ({
  useOptionalBoardLogbook: () => live.logbook,
  logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
  useEffectiveClimbStats: (
    _boardName: string,
    _layoutId: number,
    _climbUuid: string,
    _angle: number,
    base: { ascensionistCount?: number; qualityAverage?: string; difficulty?: string },
  ) => {
    live.statsCalls += 1;
    return {
      ascensionistCount: base.ascensionistCount ?? 0,
      qualityAverage: base.qualityAverage ?? null,
      difficulty: base.difficulty ?? null,
    };
  },
}));

vi.mock('../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => {
    live.gradeCalls += 1;
    return { boardseshActive: false, resolveGrade: () => ({ label: 'V4', color: '#44AA44', isBoardsesh: false }) };
  },
}));
vi.mock('../../hooks/use-my-grade', () => ({
  // The row's way to the climber's own grade, and so to the logbook: one call per
  // mounted leaf that subscribes.
  useMyGrade: () => {
    live.myGradeCalls += 1;
    return live.myGrade;
  },
}));
vi.mock('../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93', fill: '#E5E5EA' } }),
}));

vi.mock('../Text', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    Text: ({
      children,
      style,
      variant,
      numberOfLines,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      style?: unknown;
      variant?: string;
      numberOfLines?: number;
      accessibilityLabel?: string;
    }) =>
      createElement(
        'span',
        {
          'data-variant': variant,
          'data-lines': numberOfLines,
          'aria-label': accessibilityLabel,
          'data-style': JSON.stringify(flattenStyle(style)),
        },
        children,
      ),
  };
});

vi.mock('../ClimbListThumbnail', async () => {
  const metrics = await import('../climb-list-thumbnail-metrics');
  return {
    ...metrics,
    ClimbListThumbnail: (props: Record<string, unknown>) => {
      live.thumbnailProps.push(props);
      return createElement('i', { 'data-thumbnail': 'true' });
    },
  };
});

vi.mock('../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size: number; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': size, 'data-color': color }),
}));

// The tag strip has its own suite; here it only has to be mounted or not.
vi.mock('../ClimbPlaylistChips', () => ({
  ClimbPlaylistChips: ({ climbUuid }: { climbUuid: string }) =>
    createElement('div', { 'data-testid': 'playlist-chips', 'data-climb': climbUuid }),
}));

import { favoritesStore } from '@boardsesh/climb-actions';
import {
  ClimbAscentStatusView,
  ClimbFavoriteView,
  ClimbGradeView,
  ClimbListItemContent,
  ClimbSubtitleView,
  type ClimbRowLeaves,
} from '../ClimbListItemContent';
import { climbListRowStyles } from '../climb-list-row-styles';
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../lib/climb-row-display';
import { resetClimbRowDisplayForTests, setClimbRowField } from '../../lib/climb-row-display-preference';

const climb = {
  uuid: 'c1',
  name: 'Boulder Problem',
  frames: 'p1r12p2r13',
  difficulty: '6b/V4',
  quality_average: '4.5',
  ascensionist_count: 12,
  setter_username: 'setterx',
};

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

/** What the row draws, in document order: the thumbnail, each text, each glyph, each testID. */
function outline(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-thumbnail], [data-variant], [data-icon], [data-testid]')].map((node) => {
    if (node.hasAttribute('data-thumbnail')) return 'thumbnail';
    if (node.hasAttribute('data-icon')) return `icon:${node.getAttribute('data-icon')}`;
    if (node.hasAttribute('data-testid')) return `#${node.getAttribute('data-testid')}`;
    return `${node.getAttribute('data-variant')}:${node.textContent}`;
  });
}

function styleOf(node: Element | null | undefined): Record<string, unknown> {
  return JSON.parse(node?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

const sent: StatusEntry = { status: 'send', is_ascent: true, tries: 2, is_mirror: false };

beforeEach(() => {
  resetClimbRowDisplayForTests();
  favoritesStore.reset();
  live.statsCalls = 0;
  live.gradeCalls = 0;
  live.myGradeCalls = 0;
  live.myGrade = { status: 'unknown' };
  live.logbook = null;
  live.thumbnailProps = [];
});

describe('the default climb row', () => {
  it('draws thumbnail, name, detail line and grade, in that order', () => {
    const { container } = render(<ClimbListItemContent climb={climb} {...board} />);

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:12 sends · 4.5★ · setterx',
      'title3:V4',
    ]);
  });

  it('lays the three blocks out as before: 76×96 thumbnail, flexible text column, trailing grade', () => {
    const { container } = render(<ClimbListItemContent climb={climb} {...board} />);
    const [thumbnailBlock, textBlock, gradeBlock] = [...container.children];

    expect(container.children).toHaveLength(3);
    expect(styleOf(thumbnailBlock)).toEqual({ width: 76, height: 96, flexShrink: 0, position: 'relative' });
    expect(styleOf(textBlock)).toEqual({ flex: 1, minWidth: 0, justifyContent: 'center', gap: 2 });
    expect(styleOf(gradeBlock)).toEqual({
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 6,
    });
    expect(thumbnailBlock.querySelector('[data-thumbnail]')).not.toBeNull();
    expect(textBlock.textContent).toBe('Boulder Problem12 sends · 4.5★ · setterx');
    expect(gradeBlock.textContent).toBe('V4');
  });

  it('gives the thumbnail the climb and the board', () => {
    render(<ClimbListItemContent climb={climb} {...board} />);

    expect(live.thumbnailProps).toEqual([
      { frames: 'p1r12p2r13', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', mirrored: false },
    ]);
  });

  it('keeps the text styles: semibold one-line name, dimmed one-line detail, bold coloured grade', () => {
    const { container } = render(<ClimbListItemContent climb={climb} {...board} />);
    const name = container.querySelector('[data-variant="body"]');
    const detail = container.querySelector('[data-variant="footnote"]');
    const grade = container.querySelector('[data-variant="title3"]');

    expect(styleOf(name)).toEqual({ fontWeight: '600', flexShrink: 1 });
    expect(name?.getAttribute('data-lines')).toBe('1');
    expect(styleOf(detail)).toEqual({ opacity: 0.6 });
    expect(detail?.getAttribute('data-lines')).toBe('1');
    expect(styleOf(grade)).toEqual({
      fontWeight: '700',
      minWidth: 40,
      textAlign: 'right',
      fontVariant: ['tabular-nums'],
      color: '#44AA44',
    });
    expect(grade?.getAttribute('data-lines')).toBe('1');
  });

  it('starts the row separator 104pt in, under the text column', () => {
    expect(climbListRowStyles.separator).toEqual({ height: 0.5, marginLeft: 104 });
    expect(climbListRowStyles.contentRow).toEqual({
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 8,
      gap: 12,
    });
  });

  it('draws a loaded Climbs-list row: detail parts, heart, sent mark, your grade, the community’s in the detail line', () => {
    favoritesStore.setIsFavorited('c1', true);
    live.logbook = { logbookByClimbAngle: new Map([['c1:40', [sent]]]) };
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };

    const { container } = render(
      <ClimbListItemContent
        climb={{ ...climb, statsAngle: 45 }}
        {...board}
        subtitleDetailParts={['40°', '', '3 tries']}
        showFavorite
        showPlaylistChips
      />,
    );

    // The one deliberate change to the default row: the community's V4 leads the
    // detail line instead of standing under your V10 with a two-heads glyph.
    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:V4 · 12 sends · 4.5★ · setterx',
      'caption1:40° · 3 tries',
      'icon:favorite.fill',
      'icon:tick.outline',
      'icon:person',
      'title3:V10',
      'caption2:mobile.climbRow.setAngleMarker',
    ]);
    // Glyph sizes and the labels a screen reader composes the row from.
    expect(container.querySelector('[data-icon="favorite.fill"]')?.getAttribute('data-size')).toBe('16');
    expect(container.querySelector('[data-icon="tick.outline"]')?.getAttribute('data-size')).toBe('16');
    expect(container.querySelector('[data-icon="person"]')?.getAttribute('data-size')).toBe('13');
    expect(
      [...container.querySelectorAll('[aria-label]')].map((node) => [
        node.getAttribute('data-role') ?? 'text',
        node.getAttribute('aria-label'),
      ]),
    ).toEqual([
      ['text', 'mobile.climbRow.communityGradeAria · 12 sends · 4.5★ · setterx'],
      ['image', 'mobile.climbRow.favorited'],
      ['image', 'mobile.climbRow.ascentStatus.send'],
      ['text', 'mobile.climbRow.setAngleMarkerAria'],
    ]);
  });

  it('keeps the grade column of a marked grade as it was: the mark, the grade, the set-angle line', () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };

    const { container } = render(<ClimbListItemContent climb={{ ...climb, statsAngle: 45 }} {...board} />);
    const grade = container.querySelector('[data-variant="title3"]');
    const setAngleMarker = container.querySelector('[data-variant="caption2"]');

    // A marked grade gives up its 40pt floor to the glyph, as before.
    expect(styleOf(grade)).toMatchObject({ fontWeight: '700', minWidth: 0, textAlign: 'right' });
    expect(styleOf(grade?.parentElement)).toEqual({ flexDirection: 'row', alignItems: 'center', gap: 3 });
    expect(styleOf(grade?.parentElement?.parentElement)).toEqual({ alignItems: 'flex-end', gap: 1 });
    expect(styleOf(setAngleMarker)).toEqual({
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      marginTop: -2,
      color: '#8E8E93',
    });
    // Two children and no more: nothing stacks between the grade and the marker.
    expect(grade?.parentElement?.parentElement?.children).toHaveLength(2);
  });

  it('leaves playlist tags off, even on the surface that can show them', () => {
    const { queryByTestId } = render(<ClimbListItemContent climb={climb} {...board} showPlaylistChips />);

    expect(queryByTestId('playlist-chips')).toBeNull();
  });

  it('puts a mirror board’s direction lines under the detail line, as before', () => {
    live.logbook = { logbookByClimbAngle: new Map([['c1:40', [sent, { ...sent, is_mirror: true }]]]) };

    const { container } = render(<ClimbListItemContent climb={climb} {...board} boardName="tension" />);

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:12 sends · 4.5★ · setterx',
      'icon:tick.outline',
      'caption2:mobile.logbook.originalTag',
      'icon:tick.outline',
      'caption2:mobile.logbook.mirroredTag',
      'title3:V4',
    ]);
    const [, textBlock] = [...container.children];
    expect(textBlock.querySelectorAll('[data-icon="tick.outline"]')).toHaveLength(2);
  });

  it('keeps the placeholder for a climb that has not resolved', () => {
    const { container } = render(<ClimbListItemContent climb={null} {...board} />);

    expect(outline(container)).toEqual(['body:mobile.queue.unknownClimb']);
    expect(container.children).toHaveLength(3);
    expect(styleOf(container.children[0])).toEqual({ width: 76, height: 96, flexShrink: 0, position: 'relative' });
  });

  it.each([
    ['a plain row', {}],
    ['the Climbs-list row', { showFavorite: true, showPlaylistChips: true }],
  ])('draws the same thing for %s whether the default is passed or left out', (_label, surfaceProps) => {
    favoritesStore.setIsFavorited('c1', true);
    live.logbook = { logbookByClimbAngle: new Map([['c1:40', [sent]]]) };

    const implicit = render(<ClimbListItemContent climb={climb} {...board} {...surfaceProps} />);
    const explicit = render(
      <ClimbListItemContent climb={climb} {...board} {...surfaceProps} display={DEFAULT_CLIMB_ROW_DISPLAY} />,
    );

    expect(explicit.container.innerHTML).toBe(implicit.container.innerHTML);
    expect(implicit.container.innerHTML).not.toBe('');
  });
});

describe('playlist tags, a switch the row honours', () => {
  it('mounts the tag strip under the detail line once the climber turns tags on', () => {
    const { container, queryByTestId } = render(<ClimbListItemContent climb={climb} {...board} showPlaylistChips />);
    expect(queryByTestId('playlist-chips')).toBeNull();

    act(() => setClimbRowField('playlistTags', true));

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:12 sends · 4.5★ · setterx',
      '#playlist-chips',
      'title3:V4',
    ]);
    expect(queryByTestId('playlist-chips')?.getAttribute('data-climb')).toBe('c1');
  });

  it('still leaves them off a surface that does not show tags', () => {
    setClimbRowField('playlistTags', true);

    const { queryByTestId } = render(<ClimbListItemContent climb={climb} {...board} />);

    expect(queryByTestId('playlist-chips')).toBeNull();
  });

  it('uses a passed display as given, over the stored one', () => {
    setClimbRowField('playlistTags', true);
    const staged = render(
      <ClimbListItemContent
        climb={climb}
        {...board}
        showPlaylistChips
        display={{ ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: false }}
      />,
    );
    expect(staged.queryByTestId('playlist-chips')).toBeNull();
    staged.unmount();

    resetClimbRowDisplayForTests();
    const stagedOn = render(
      <ClimbListItemContent
        climb={climb}
        {...board}
        showPlaylistChips
        display={{ ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: true }}
      />,
    );
    expect(stagedOn.queryByTestId('playlist-chips')).not.toBeNull();
  });

  // Holds until the row honours them. Each later part that teaches the row a
  // switch takes its field out of this list and asserts what that switch hides
  // instead. The row is a loaded one, so a switch that started hiding something
  // would show here.
  it('does not change the row for a switch it does not honour yet', () => {
    favoritesStore.setIsFavorited('c1', true);
    live.logbook = { logbookByClimbAngle: new Map([['c1:40', [sent]]]) };
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    const before = render(<ClimbListItemContent climb={climb} {...board} showFavorite showPlaylistChips />);
    const untouched = before.container.innerHTML;

    act(() => {
      for (const fieldId of ['thumbnail', 'sends', 'rating', 'setter', 'sentMark'] as const) {
        setClimbRowField(fieldId, false);
      }
    });

    expect(before.container.innerHTML).toBe(untouched);
  });
});

describe('the community grade switch', () => {
  const rowWithMyGrade = () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    return render(<ClimbListItemContent climb={climb} {...board} />);
  };

  it('is on by default: the community’s grade leads the detail line when yours is in the column', () => {
    const { container } = rowWithMyGrade();

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:V4 · 12 sends · 4.5★ · setterx',
      'icon:person',
      'title3:V10',
    ]);
    // The token is part of the one detail line, in that line's style.
    const detail = container.querySelector('[data-variant="footnote"]');
    expect(styleOf(detail)).toEqual({ opacity: 0.6 });
    expect(detail?.getAttribute('data-lines')).toBe('1');
  });

  it('hides exactly the token when the climber turns it off', () => {
    const { container } = rowWithMyGrade();

    act(() => setClimbRowField('communityGrade', false));

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:12 sends · 4.5★ · setterx',
      'icon:person',
      'title3:V10',
    ]);
    expect(container.querySelector('[data-variant="footnote"]')?.hasAttribute('aria-label')).toBe(false);
  });

  it('changes nothing on a row whose column already shows the community grade', () => {
    const before = render(<ClimbListItemContent climb={climb} {...board} />);
    const untouched = before.container.innerHTML;
    expect(outline(before.container)).toContain('footnote:12 sends · 4.5★ · setterx');

    act(() => setClimbRowField('communityGrade', false));

    expect(before.container.innerHTML).toBe(untouched);
  });

  it('uses a passed display as given, over the stored one', () => {
    live.myGrade = { status: 'set', difficultyId: 27, climbedAt: null };
    const staged = render(
      <ClimbListItemContent
        climb={climb}
        {...board}
        display={{ ...DEFAULT_CLIMB_ROW_DISPLAY, communityGrade: false }}
      />,
    );

    expect(outline(staged.container)).toContain('footnote:12 sends · 4.5★ · setterx');
  });

  // What the token costs a row: one more reader of the logbook while it is on,
  // and never another reader of the stats store.
  it.each([
    { switched: 'on', communityGrade: true, logbookReaders: 2 },
    { switched: 'off', communityGrade: false, logbookReaders: 1 },
  ])(
    'switched $switched, the row has two stats readers and $logbookReaders logbook readers for the grade',
    ({ communityGrade, logbookReaders }) => {
      render(
        <ClimbListItemContent climb={climb} {...board} display={{ ...DEFAULT_CLIMB_ROW_DISPLAY, communityGrade }} />,
      );

      expect(live.statsCalls).toBe(2);
      expect(live.myGradeCalls).toBe(logbookReaders);
    },
  );
});

describe('staged leaves, for the settings preview', () => {
  const sampleLeaves: ClimbRowLeaves = {
    // A staged leaf gets the switch from the row, so the preview follows it.
    Subtitle: ({ showCommunityGrade }) => (
      <ClimbSubtitleView
        isDraft={false}
        ascensionistCount={1200}
        qualityAverage="4.2"
        setterUsername="sample"
        communityGrade={showCommunityGrade ? 'V4' : null}
      />
    ),
    Grade: () => <ClimbGradeView label="V5" color="#123456" markedAsMine isProject={false} setAtAngle={null} />,
    AscentStatus: () => <ClimbAscentStatusView supportsMirroring={false} ascentStatus="flash" mirrorStatus={null} />,
    Favorite: () => <ClimbFavoriteView />,
    PlaylistChips: () => <div data-testid="sample-chips" />,
  };

  it('draws the row from the views, without running one live hook', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={climb}
        {...board}
        showFavorite
        showPlaylistChips
        display={{ ...DEFAULT_CLIMB_ROW_DISPLAY, playlistTags: true }}
        leaves={sampleLeaves}
      />,
    );

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:V4 · 1.2k sends · 4.2★ · sample',
      '#sample-chips',
      'icon:favorite.fill',
      'icon:flash',
      'icon:person',
      'title3:V5',
    ]);
    expect(container.querySelector('[data-variant="footnote"]')?.getAttribute('aria-label')).toBe(
      'mobile.climbRow.communityGradeAria · 1.2k sends · 4.2★ · sample',
    );
    expect(live.statsCalls).toBe(0);
    expect(live.gradeCalls).toBe(0);
    expect(live.myGradeCalls).toBe(0);
  });

  it('hands a staged detail line the community grade switch', () => {
    const { container } = render(
      <ClimbListItemContent
        climb={climb}
        {...board}
        display={{ ...DEFAULT_CLIMB_ROW_DISPLAY, communityGrade: false }}
        leaves={sampleLeaves}
      />,
    );

    expect(outline(container)).toContain('footnote:1.2k sends · 4.2★ · sample');
  });

  it('draws the same glyphs and text from a view as the live leaf does', () => {
    favoritesStore.setIsFavorited('c1', true);
    live.logbook = { logbookByClimbAngle: new Map([['c1:40', [{ ...sent, status: 'flash', tries: 1 }]]]) };
    const liveRow = render(<ClimbListItemContent climb={climb} {...board} showFavorite />);

    const matchingLeaves: ClimbRowLeaves = {
      ...sampleLeaves,
      Subtitle: () => (
        <ClimbSubtitleView
          isDraft={false}
          ascensionistCount={12}
          qualityAverage="4.5"
          setterUsername="setterx"
          communityGrade={null}
        />
      ),
      Grade: () => (
        <ClimbGradeView label="V4" color="#44AA44" markedAsMine={false} isProject={false} setAtAngle={null} />
      ),
    };
    const stagedRow = render(<ClimbListItemContent climb={climb} {...board} showFavorite leaves={matchingLeaves} />);

    expect(stagedRow.container.innerHTML).toBe(liveRow.container.innerHTML);
  });
});
