// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';

const hapticSelection = vi.hoisted(() => vi.fn());
const renderState = vi.hoisted(() => ({ boardseshActive: true }));
// The LAYOUT DEFAULT — deliberately a different sizeId from every ascent's own
// renderBoard, so a row that silently fell back to it is impossible to miss.
const getDefaultRenderBoard = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: ({
    children,
    accessible,
    accessibilityElementsHidden,
    importantForAccessibility,
  }: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) =>
    createElement(
      'div',
      {
        'data-accessible': String(accessible),
        'data-elements-hidden': String(accessibilityElementsHidden),
        'data-important-for-accessibility': importantForAccessibility,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; grade?: string; details?: string }) => {
      const labels: Record<string, string> = {
        'you:mobile.logbook.status.flash': 'Flash',
        'you:mobile.logbook.row.project': 'Project',
        'you:mobile.logbook.row.a11yMirrored': 'mirrored',
        'you:mobile.logbook.row.a11yHasBetaVideo': 'has beta video',
      };
      if (key === 'you:mobile.logbook.tries') return `${options?.count ?? 0} tries`;
      if (key === 'you:mobile.logbook.row.a11yCommunityGrade') return `community grade ${options?.grade ?? ''}`;
      if (key === 'common:mobile.gradeToken.a11yYours') return `your grade ${options?.grade ?? ''}`;
      if (key === 'common:mobile.gradeToken.a11yCommunity') return `community grade ${options?.grade ?? ''}`;
      if (key === 'session:mobile.betaVideos.shareAscentLabel') return `Attach your beta to ${options?.details ?? ''}`;
      return labels[key] ?? key;
    },
  }),
}));

// The real board-config resolver is NOT mocked below — the point of this file is
// that the row goes through renderBoardToPlaylistConfig — so stub the shared
// board metadata it reads instead.
vi.mock('@boardsesh/board-config', () => ({
  getDefaultRenderBoard,
  toBoardName: (boardType: string) => (boardType === 'kilter' || boardType === 'tension' ? boardType : null),
}));

vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: (label: string) => `color:${label}`,
  DEFAULT_GRADE_COLOR: 'color:default',
}));

vi.mock('@boardsesh/profile-stats', () => ({
  formatTickRelativeTime: () => '2 hours ago',
  getLayoutDisplayName: (boardType: string, layoutId: number | null) => `${boardType} layout ${String(layoutId)}`,
}));

vi.mock('../../../hooks/use-display-grade', () => ({
  useBoardseshGradesActive: () => renderState.boardseshActive,
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (grade: string | null | undefined) => grade ?? null,
    formatGradeByDifficultyId: (difficulty: number | null | undefined) =>
      difficulty == null ? null : `V${difficulty}`,
  }),
}));

vi.mock('../../../lib/boardsesh-grade-display', () => ({
  resolveCrowdDifficultyId: (
    ascent: {
      boardseshDifficulty: number | null;
      boardseshConfidence: string | null;
      consensusDifficulty: number | null;
    },
    boardseshActive: boolean,
  ) =>
    boardseshActive && ascent.boardseshDifficulty != null && ascent.boardseshConfidence !== 'setter_only'
      ? ascent.boardseshDifficulty
      : ascent.consensusDifficulty,
  GRADE_BY_ID: new Map([
    [21, { difficulty_name: 'V21-name' }],
    [25, { difficulty_name: 'V25-name' }],
  ]),
  clampDifficultyId: (difficulty: number) => Math.round(difficulty),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      separator: '#ccc',
      fill: '#eee',
    },
    brandColors: { primary: '#6D28D9', success: '#34C759', warning: '#FF9F0A' },
  }),
}));

vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#8E8E93' } }));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { md: 8 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));

vi.mock('../../ClimbListThumbnail', () => ({
  ClimbListThumbnail: (props: {
    frames: string;
    boardName: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    mirrored?: boolean;
    size: { width: number; height: number };
  }) =>
    createElement('div', {
      'data-testid': 'climb-thumbnail',
      'data-frames': props.frames,
      'data-board-name': props.boardName,
      'data-layout-id': String(props.layoutId),
      'data-size-id': String(props.sizeId),
      'data-set-ids': props.setIds,
      'data-mirrored': String(props.mirrored),
      'data-width': String(props.size.width),
      'data-height': String(props.size.height),
    }),
}));

vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));

import { ShareBetaAscentRow } from '../ShareBetaAscentRow';

function makeAscent(overrides: Partial<AscentFeedItem> = {}): AscentFeedItem {
  return {
    uuid: 'tick-1',
    climbUuid: 'climb-1',
    climbName: 'Purple People Eater',
    setterUsername: null,
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: 'Garage Board',
    layoutId: 8,
    renderBoard: { layoutId: 8, sizeId: 17, setIds: [20, 21] },
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 3,
    quality: null,
    difficulty: 21,
    difficultyName: 'V5',
    consensusDifficulty: 20,
    consensusDifficultyName: 'V4',
    boardseshDifficulty: 25,
    boardseshConfidence: 'confirmed',
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: '',
    climbedAt: '2026-07-31T12:00:00.000Z',
    frames: 'p1r1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  renderState.boardseshActive = true;
  getDefaultRenderBoard.mockReturnValue({ layoutId: 8, sizeId: 99, setIds: [1, 2, 3] });
});

describe('ShareBetaAscentRow — board art', () => {
  it('draws the climb on the board the ascent was logged on, not the layout default', () => {
    const { getByTestId } = render(
      <ShareBetaAscentRow ascent={makeAscent({ isMirror: true })} source="other" onActivate={vi.fn()} />,
    );
    const thumbnail = getByTestId('climb-thumbnail');

    expect(thumbnail.getAttribute('data-frames')).toBe('p1r1');
    expect(thumbnail.getAttribute('data-board-name')).toBe('kilter');
    expect(thumbnail.getAttribute('data-layout-id')).toBe('8');
    // The regression guard for #4221: 17 is the climber's own wall, 99 the
    // layout default the fallback would have handed back.
    expect(thumbnail.getAttribute('data-size-id')).toBe('17');
    expect(thumbnail.getAttribute('data-set-ids')).toBe('20,21');
    // Mirror is a CSS flip on the same cached PNG.
    expect(thumbnail.getAttribute('data-mirrored')).toBe('true');
  });

  it('falls back to the layout default when the tick carries no renderBoard', () => {
    const { getByTestId } = render(
      <ShareBetaAscentRow
        ascent={makeAscent({ boardType: 'tension', renderBoard: null })}
        source="other"
        onActivate={vi.fn()}
      />,
    );

    expect(getByTestId('climb-thumbnail').getAttribute('data-size-id')).toBe('99');
  });

  it('keeps the cell portrait and within the shared ≤80px render-cache width', () => {
    const { getByTestId } = render(<ShareBetaAscentRow ascent={makeAscent()} source="other" onActivate={vi.fn()} />);
    const thumbnail = getByTestId('climb-thumbnail');
    const width = Number(thumbnail.getAttribute('data-width'));
    const height = Number(thumbnail.getAttribute('data-height'));

    expect(height).toBeGreaterThan(width);
    // Above 80 the renderWidth leaves `_w400_` and the picker stops sharing the
    // climbs list's cached PNG.
    expect(width).toBeLessThanOrEqual(80);
  });

  it('shows the neutral tile for a frameless tick', () => {
    const { container, queryByTestId } = render(
      <ShareBetaAscentRow ascent={makeAscent({ frames: null })} source="other" onActivate={vi.fn()} />,
    );

    expect(queryByTestId('climb-thumbnail')).toBeNull();
    expect(container.querySelector('[data-icon="lightbulb"]')).toBeTruthy();
  });

  it('shows the neutral tile when no board config resolves', () => {
    getDefaultRenderBoard.mockReturnValue(null);
    const { container, queryByTestId } = render(
      <ShareBetaAscentRow
        ascent={makeAscent({ boardType: 'moonboard', renderBoard: null })}
        source="other"
        onActivate={vi.fn()}
      />,
    );

    expect(queryByTestId('climb-thumbnail')).toBeNull();
    expect(container.querySelector('[data-icon="lightbulb"]')).toBeTruthy();
  });
});

// A DIARY surface, like LogbookRow: the picker lists YOUR ascents, so your own
// grade is the unremarkable number and the crowd's is the one that gets marked.
// One number in the slot; the other, when they differ, leads the result line.
describe('ShareBetaAscentRow — grade slot', () => {
  const gradeSlot = (container: HTMLElement) => container.querySelector('[data-variant="title3"]')?.textContent ?? '';

  it('shows the climber’s own grade unmarked', () => {
    const { container } = render(<ShareBetaAscentRow ascent={makeAscent()} source="other" onActivate={vi.fn()} />);

    expect(gradeSlot(container)).toBe('V21');
    expect(container.querySelector('[data-icon="people"]')).toBeNull();
    expect(container.querySelector('[data-icon="person"]')).toBeNull();
  });

  it('puts the crowd’s number on the result line when it disagrees with yours', () => {
    // Own grade 21, Boardsesh grade 25 (active + confirmed) — the crowd side.
    const { container } = render(<ShareBetaAscentRow ascent={makeAscent()} source="other" onActivate={vi.fn()} />);

    expect(container.textContent).toContain('V25 · 3 tries');
    // ...and never as a second number in the slot.
    expect(gradeSlot(container)).toBe('V21');
  });

  it('marks the crowd grade when the climber never graded it', () => {
    const { container } = render(
      <ShareBetaAscentRow
        ascent={makeAscent({ difficulty: null, difficultyName: null })}
        source="other"
        onActivate={vi.fn()}
      />,
    );

    expect(gradeSlot(container)).toBe('V25');
    expect(container.querySelector('[data-icon="people"]')).toBeTruthy();
    // Nothing to add to the result line: the crowd's number IS the slot.
    expect(container.textContent).not.toContain('V25 · 3 tries');
  });

  it('keeps the beta-video marker the logbook row shows', () => {
    const { container } = render(
      <ShareBetaAscentRow ascent={makeAscent({ hasBetaVideo: true })} source="other" onActivate={vi.fn()} />,
    );

    expect(container.querySelector('[data-icon="video.fill"]')).toBeTruthy();
  });
});

describe('ShareBetaAscentRow — accessibility and press', () => {
  it('exposes one descriptive button and hides the board art from assistive tech', () => {
    const { getByRole, container } = render(
      <ShareBetaAscentRow ascent={makeAscent({ isMirror: true })} source="suggested" onActivate={vi.fn()} />,
    );

    expect(
      getByRole('button', {
        name: 'Attach your beta to Purple People Eater, mirrored, V21, community grade V25, 3 tries, Garage Board 40°, 2 hours ago',
      }),
    ).toBeTruthy();
    const decorativeWrapper = container.querySelector('[data-important-for-accessibility="no-hide-descendants"]');
    expect(decorativeWrapper?.getAttribute('data-accessible')).toBe('false');
    expect(decorativeWrapper?.getAttribute('data-elements-hidden')).toBe('true');
  });

  it('reads the current ascent and section when FlashList recycles the row', () => {
    const onActivate = vi.fn();
    const first = makeAscent({ uuid: 'tick-1', climbName: 'First climb' });
    const second = makeAscent({ uuid: 'tick-2', climbName: 'Second climb' });
    const { getByRole, rerender } = render(
      <ShareBetaAscentRow ascent={first} source="suggested" onActivate={onActivate} />,
    );

    rerender(<ShareBetaAscentRow ascent={second} source="other" onActivate={onActivate} />);
    fireEvent.click(getByRole('button'));

    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(second, 'other');
  });

  it('is memoized — identical props do not re-run the row body', () => {
    // A layoutId no other test touches, so the board-config module cache can't
    // hide a second call.
    const ascent = makeAscent({ boardType: 'tension', layoutId: 4242, renderBoard: null });
    const onActivate = vi.fn();
    const { rerender } = render(<ShareBetaAscentRow ascent={ascent} source="other" onActivate={onActivate} />);
    expect(getDefaultRenderBoard).toHaveBeenCalledTimes(1);

    rerender(<ShareBetaAscentRow ascent={ascent} source="other" onActivate={onActivate} />);

    expect(getDefaultRenderBoard).toHaveBeenCalledTimes(1);
  });
});
