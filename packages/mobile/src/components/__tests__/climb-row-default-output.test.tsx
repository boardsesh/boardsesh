// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The guard for the configurable-row work: a climber who has touched nothing
// must get exactly the row they had. Every assertion spells out what is expected
// (no snapshot), so a change to the default row has to be made here on purpose.

type StatusEntry = { status: 'flash' | 'send' | 'attempt'; is_ascent: boolean; tries: number; is_mirror: boolean };

const live = vi.hoisted(() => ({
  statsCalls: 0,
  gradeCalls: 0,
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
vi.mock('../../hooks/use-my-grade', () => ({ useMyGrade: () => live.myGrade }));
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

  it('draws a loaded Climbs-list row as before: detail parts, heart, sent mark, your grade over the crowd’s', () => {
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

    expect(outline(container)).toEqual([
      'thumbnail',
      'body:Boulder Problem',
      'footnote:12 sends · 4.5★ · setterx',
      'caption1:40° · 3 tries',
      'icon:favorite.fill',
      'icon:tick.outline',
      'icon:person',
      'title3:V10',
      'icon:people',
      'caption2:V4',
      'caption2:mobile.climbRow.setAngleMarker',
    ]);
    // Glyph sizes and the labels a screen reader composes the row from.
    expect(container.querySelector('[data-icon="favorite.fill"]')?.getAttribute('data-size')).toBe('16');
    expect(container.querySelector('[data-icon="tick.outline"]')?.getAttribute('data-size')).toBe('16');
    expect(container.querySelector('[data-icon="person"]')?.getAttribute('data-size')).toBe('13');
    expect(container.querySelector('[data-icon="people"]')?.getAttribute('data-size')).toBe('11');
    expect(
      [...container.querySelectorAll('[aria-label]')].map((node) => [
        node.getAttribute('data-role') ?? 'text',
        node.getAttribute('aria-label'),
      ]),
    ).toEqual([
      ['image', 'mobile.climbRow.favorited'],
      ['image', 'mobile.climbRow.ascentStatus.send'],
      ['text', 'mobile.climbRow.setAngleMarkerAria'],
    ]);
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

describe('playlist tags, the one switch the row honours so far', () => {
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

  // Holds for this commit only. Each later part that teaches the row a switch
  // takes its field out of this list and asserts what that switch hides instead.
  it('does not change the row for a switch it does not honour yet', () => {
    const before = render(<ClimbListItemContent climb={climb} {...board} showFavorite showPlaylistChips />);
    const untouched = before.container.innerHTML;

    act(() => {
      for (const fieldId of ['thumbnail', 'communityGrade', 'sends', 'rating', 'setter', 'sentMark'] as const) {
        setClimbRowField(fieldId, false);
      }
    });

    expect(before.container.innerHTML).toBe(untouched);
  });
});

describe('staged leaves, for the settings preview', () => {
  const sampleLeaves: ClimbRowLeaves = {
    Subtitle: () => (
      <ClimbSubtitleView isDraft={false} ascensionistCount={1200} qualityAverage="4.2" setterUsername="sample" />
    ),
    Grade: () => (
      <ClimbGradeView
        label="V5"
        color="#123456"
        markedAsMine
        gradeIsConsensus={false}
        secondaryLabel="V4"
        isProject={false}
        setAtAngle={null}
      />
    ),
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
      'footnote:1.2k sends · 4.2★ · sample',
      '#sample-chips',
      'icon:favorite.fill',
      'icon:flash',
      'icon:person',
      'title3:V5',
      'icon:people',
      'caption2:V4',
    ]);
    expect(live.statsCalls).toBe(0);
    expect(live.gradeCalls).toBe(0);
  });

  it('draws the same glyphs and text from a view as the live leaf does', () => {
    favoritesStore.setIsFavorited('c1', true);
    live.logbook = { logbookByClimbAngle: new Map([['c1:40', [{ ...sent, status: 'flash', tries: 1 }]]]) };
    const liveRow = render(<ClimbListItemContent climb={climb} {...board} showFavorite />);

    const matchingLeaves: ClimbRowLeaves = {
      ...sampleLeaves,
      Subtitle: () => (
        <ClimbSubtitleView isDraft={false} ascensionistCount={12} qualityAverage="4.5" setterUsername="setterx" />
      ),
      Grade: () => (
        <ClimbGradeView
          label="V4"
          color="#44AA44"
          markedAsMine={false}
          gradeIsConsensus={false}
          secondaryLabel={null}
          isProject={false}
          setAtAngle={null}
        />
      ),
    };
    const stagedRow = render(<ClimbListItemContent climb={climb} {...board} showFavorite leaves={matchingLeaves} />);

    expect(stagedRow.container.innerHTML).toBe(liveRow.container.innerHTML);
  });
});
