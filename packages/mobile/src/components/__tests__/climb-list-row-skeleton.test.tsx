// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The placeholder for a loading climb row. It reads the climber's Climb list
// settings and takes its shape from the same layout function as the row, so the
// row that replaces it has the same thumbnail (or none), lines and separator.
//
// The first block pins the placeholder a climber gets who has touched nothing,
// block by block and style by style: that one must not move.

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    useWindowDimensions: () => ({ fontScale: 1 }),
    Platform: { OS: 'ios', select: () => undefined },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <Styles,>(styles: Styles): Styles => styles, flatten: flattenStyle, hairlineWidth: 0.5 },
    View: ({
      children,
      style,
      testID,
      accessibilityElementsHidden,
      importantForAccessibility,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
      accessibilityElementsHidden?: boolean;
      importantForAccessibility?: string;
    }) =>
      createElement(
        'div',
        {
          'data-testid': testID,
          'data-silent': accessibilityElementsHidden ? 'true' : undefined,
          'data-important': importantForAccessibility,
          'data-style': JSON.stringify(flattenStyle(style)),
        },
        children,
      ),
  };
});

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    textStyles: { body: { lineHeight: 22 } },
    systemColors: { background: '#fff', fill: '#E5E5EA', separator: '#ccc' },
  }),
}));

vi.mock('../Text', () => ({
  Text: ({
    children,
    variant,
    maxFontSizeMultiplier,
  }: {
    children?: ReactNode;
    variant?: string;
    maxFontSizeMultiplier?: number;
  }) => createElement('span', { 'data-variant': variant, 'data-max-scale': maxFontSizeMultiplier }, children),
}));

// Keeps the native image renderer out, and the real thumbnail size in.
vi.mock('../ClimbListThumbnail', async () => ({
  ...(await import('../climb-list-thumbnail-metrics')),
  ClimbListThumbnail: () => null,
}));

import { ClimbListRowSkeleton } from '../ClimbListRowSkeleton';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_PRESETS,
  DEFAULT_CLIMB_ROW_DISPLAY,
  type ClimbRowDisplay,
} from '../../lib/climb-row-display';
import {
  applyClimbRowPreset,
  resetClimbRowDisplayForTests,
  setClimbRowField,
} from '../../lib/climb-row-display-preference';

const BLANK = '\u00A0';

type Drawn = { style: Record<string, unknown>; children: Drawn[]; text: string | null; variant: string | null };

/** What a node draws: its style, and the same for everything in it. An empty line of text reads as its variant. */
function drawn(node: Element): Drawn {
  return {
    style: JSON.parse(node.getAttribute('data-style') ?? '{}') as Record<string, unknown>,
    children: [...node.children].map(drawn),
    text: node.children.length === 0 ? node.textContent : null,
    variant: node.getAttribute('data-variant'),
  };
}

function skeletonOf(container: HTMLElement) {
  const root = container.querySelector('[data-testid="climb-list-row-skeleton"]');
  if (!root) throw new Error('No skeleton row was drawn');
  const [contentRow, separator] = [...root.children].map(drawn);
  return { root, contentRow, separator };
}

function store(display: ClimbRowDisplay) {
  for (const fieldId of CLIMB_ROW_FIELD_IDS) setClimbRowField(fieldId, display[fieldId]);
}

const bar = (width: string, height: number, opacity: number): Drawn => ({
  style: { width, height, borderRadius: 9999, opacity, backgroundColor: '#E5E5EA' },
  children: [],
  text: '',
  variant: null,
});
const blankLine = (variant: string): Drawn => ({ style: {}, children: [], text: BLANK, variant });
const TITLE_BAR = bar('70%', 18, 0.55);
const DETAIL_BAR = bar('46%', 12, 0.4);
const GRADE_BLOCK: Drawn = {
  style: { width: 34, height: 20, borderRadius: 9999, opacity: 0.5, backgroundColor: '#E5E5EA' },
  children: [],
  text: '',
  variant: null,
};
const CONTENT_ROW_STYLE = {
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: 16,
  paddingVertical: 8,
  gap: 12,
  backgroundColor: '#fff',
};
// A bar on a real, empty line of the text it stands for.
const textLine = (lineBar: Drawn, variant: string): Drawn => ({
  style: { flexDirection: 'row', alignItems: 'center' },
  children: [lineBar, blankLine(variant)],
  text: null,
  variant: null,
});
const TEXT_COLUMN_STYLE = { flex: 1, minWidth: 0, justifyContent: 'center', gap: 2, minHeight: 28 };

beforeEach(() => {
  resetClimbRowDisplayForTests();
});

describe('the default skeleton row', () => {
  it('is what it was: a 76×96 block, two bars centred beside it, a grade block, a separator 104pt in', () => {
    const { contentRow, separator } = skeletonOf(render(<ClimbListRowSkeleton />).container);

    expect(contentRow).toEqual({
      style: CONTENT_ROW_STYLE,
      children: [
        {
          style: { width: 76, height: 96, borderRadius: 8, opacity: 0.55, backgroundColor: '#E5E5EA' },
          children: [],
          text: '',
          variant: null,
        },
        {
          style: { flex: 1, minWidth: 0, justifyContent: 'center', gap: 8 },
          children: [TITLE_BAR, DETAIL_BAR],
          text: null,
          variant: null,
        },
        GRADE_BLOCK,
      ],
      text: null,
      variant: null,
    });
    expect(separator).toEqual({
      style: { height: 0.5, marginStart: 104, backgroundColor: '#ccc' },
      children: [],
      text: '',
      variant: null,
    });
  });

  it('stays hidden from screen readers', () => {
    const { root } = skeletonOf(render(<ClimbListRowSkeleton />).container);

    expect(root.getAttribute('data-silent')).toBe('true');
    expect(root.getAttribute('data-important')).toBe('no-hide-descendants');
  });

  it('is the same for the Climbs list and for a board that mirrors: beside a thumbnail nothing is reserved', () => {
    const plain = render(<ClimbListRowSkeleton />).container.innerHTML;
    const climbsListOnTension = render(<ClimbListRowSkeleton showPlaylistChips supportsMirroring />).container
      .innerHTML;

    expect(climbsListOnTension).toBe(plain);
  });

  it('draws no text at all, so it needs no type scale', () => {
    const { container } = render(<ClimbListRowSkeleton />);

    expect(container.querySelectorAll('[data-variant]')).toHaveLength(0);
  });
});

describe('the skeleton row beside a thumbnail, with switches off', () => {
  it('drops the detail bar when the row has no detail line', () => {
    store({ ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false });

    const { contentRow } = skeletonOf(render(<ClimbListRowSkeleton />).container);

    expect(contentRow.children[1].children).toEqual([TITLE_BAR]);
    // Still the thumbnail's row: three blocks.
    expect(contentRow.children).toHaveLength(3);
  });

  it.each(['sends', 'rating', 'setter'] as const)('keeps the detail bar while %s alone is on', (fieldId) => {
    store({ ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false, rating: false, setter: false, [fieldId]: true });

    const { contentRow } = skeletonOf(render(<ClimbListRowSkeleton />).container);

    expect(contentRow.children[1].children).toEqual([TITLE_BAR, DETAIL_BAR]);
  });
});

describe('the skeleton row without a thumbnail', () => {
  it('has no thumbnail block, real lines of text under its bars, and a separator at the gutter', () => {
    applyClimbRowPreset('textOnly');

    const { contentRow, separator } = skeletonOf(render(<ClimbListRowSkeleton />).container);

    expect(contentRow).toEqual({
      style: { ...CONTENT_ROW_STYLE, minHeight: 58 },
      children: [
        {
          style: TEXT_COLUMN_STYLE,
          children: [textLine(TITLE_BAR, 'body'), textLine(DETAIL_BAR, 'footnote')],
          text: null,
          variant: null,
        },
        GRADE_BLOCK,
      ],
      text: null,
      variant: null,
    });
    expect(separator.style).toEqual({ height: 0.5, marginStart: 16, backgroundColor: '#ccc' });
  });

  it('is one line of name, floored at the row’s touch target, for the names-only row', () => {
    applyClimbRowPreset('namesOnly');

    const { contentRow } = skeletonOf(render(<ClimbListRowSkeleton />).container);
    const [textColumn] = contentRow.children;

    // 28pt of text column inside 8pt of padding above and below: 44pt.
    expect(textColumn.style).toEqual(TEXT_COLUMN_STYLE);
    expect(contentRow.style.paddingVertical).toBe(8);
    expect(textColumn.children).toEqual([textLine(TITLE_BAR, 'body')]);
  });

  it('holds the line a mirror board’s rows reserve for their directions, empty and no shorter than the glyph', () => {
    applyClimbRowPreset('textOnly');

    const { contentRow } = skeletonOf(render(<ClimbListRowSkeleton supportsMirroring />).container);

    expect(contentRow.children[0].children).toEqual([
      textLine(TITLE_BAR, 'body'),
      textLine(DETAIL_BAR, 'footnote'),
      { style: { minHeight: 12 }, children: [blankLine('caption2')], text: null, variant: null },
    ]);
  });

  it('holds no such line once the sent mark is off', () => {
    store({ ...CLIMB_ROW_PRESETS.textOnly, quickActions: true, sentMark: false });

    const { contentRow } = skeletonOf(render(<ClimbListRowSkeleton supportsMirroring />).container);

    expect(contentRow.children[0].children).toHaveLength(2);
  });

  it('holds the tags line on the list that shows tags, sized like a line of tags and capped like one', () => {
    store({ ...CLIMB_ROW_PRESETS.textOnly, quickActions: true, playlistTags: true });

    const { container } = render(<ClimbListRowSkeleton showPlaylistChips />);
    const { contentRow } = skeletonOf(container);

    expect(contentRow.children[0].children).toEqual([
      textLine(TITLE_BAR, 'body'),
      textLine(DETAIL_BAR, 'footnote'),
      {
        // The chips row's 4pt margin, and a chip's 2pt padding and 20pt floor.
        style: { marginTop: 4, paddingVertical: 2, minHeight: 20, justifyContent: 'center' },
        children: [blankLine('caption1')],
        text: null,
        variant: null,
      },
    ]);
    expect(container.querySelector('[data-variant="caption1"]')?.getAttribute('data-max-scale')).toBe('1.3');
  });

  it('holds no tags line on a list that never shows tags', () => {
    store({ ...CLIMB_ROW_PRESETS.textOnly, quickActions: true, playlistTags: true });

    const { contentRow } = skeletonOf(render(<ClimbListRowSkeleton />).container);

    expect(contentRow.children[0].children).toHaveLength(2);
  });

  it('holds every line of the fullest row, in the row’s order: name, detail, personal, tags', () => {
    store({ ...CLIMB_ROW_PRESETS.textOnly, quickActions: true, playlistTags: true });

    const { container } = render(<ClimbListRowSkeleton showPlaylistChips supportsMirroring />);

    expect([...container.querySelectorAll('[data-variant]')].map((line) => line.getAttribute('data-variant'))).toEqual([
      'body',
      'footnote',
      'caption2',
      'caption1',
    ]);
  });

  it('follows a switch flipped while it is on screen', () => {
    const { container } = render(<ClimbListRowSkeleton />);
    expect(skeletonOf(container).contentRow.children).toHaveLength(3);

    act(() => setClimbRowField('thumbnail', false));

    expect(skeletonOf(container).contentRow.children).toHaveLength(2);
    expect(skeletonOf(container).separator.style.marginStart).toBe(16);
  });
});
