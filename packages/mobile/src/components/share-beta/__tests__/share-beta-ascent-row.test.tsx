// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';

const hapticSelection = vi.hoisted(() => vi.fn());
const boardConfigResolver = vi.hoisted(() => vi.fn());
const renderState = vi.hoisted(() => ({ boardseshActive: true }));

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
        'you:mobile.logbook.status.send': 'Send',
        'you:mobile.logbook.row.project': 'Project',
        'you:mobile.logbook.row.a11yMirrored': 'mirrored',
      };
      if (key === 'you:mobile.logbook.tries') return `${options?.count ?? 0} tries`;
      if (key === 'you:mobile.logbook.row.a11yCommunityGrade') return `community grade ${options?.grade ?? ''}`;
      if (key === 'mobile.betaVideos.shareAscentLabel') return `Attach beta to ${options?.details ?? ''}`;
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: (label: string) => `color:${label}`,
  DEFAULT_GRADE_COLOR: 'color:default',
}));

vi.mock('@boardsesh/logbook', () => ({
  deriveLogbookGradeDisplay: (personal: number | null, crowd: number | null) => ({
    gradeIsConsensus: personal == null && crowd != null,
  }),
  displayedAttemptCount: (attempts: number) => Math.max(1, attempts),
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

vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: boardConfigResolver,
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
  }),
}));

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
  boardConfigResolver.mockReturnValue({
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: [20, 21],
  });
});

describe('ShareBetaAscentRow', () => {
  it('renders square cached board art with view-only mirroring', () => {
    const { getByTestId } = render(<ShareBetaAscentRow ascent={makeAscent({ isMirror: true })} onActivate={vi.fn()} />);
    const thumbnail = getByTestId('climb-thumbnail');

    expect(thumbnail.getAttribute('data-frames')).toBe('p1r1');
    expect(thumbnail.getAttribute('data-board-name')).toBe('kilter');
    expect(thumbnail.getAttribute('data-layout-id')).toBe('8');
    expect(thumbnail.getAttribute('data-size-id')).toBe('17');
    expect(thumbnail.getAttribute('data-set-ids')).toBe('20,21');
    expect(thumbnail.getAttribute('data-mirrored')).toBe('true');
    expect(thumbnail.getAttribute('data-width')).toBe('48');
    expect(thumbnail.getAttribute('data-height')).toBe('48');
  });

  it.each([
    ['missing frames', { frames: null }],
    ['missing layout', { layoutId: null }],
  ])('uses the neutral fallback for %s', (_label, overrides) => {
    const { container, queryByTestId } = render(
      <ShareBetaAscentRow ascent={makeAscent(overrides)} onActivate={vi.fn()} />,
    );

    expect(queryByTestId('climb-thumbnail')).toBeNull();
    expect(container.querySelector('[data-icon="lightbulb"]')).toBeTruthy();
  });

  it('uses the fallback when a board configuration cannot resolve', () => {
    boardConfigResolver.mockReturnValue(null);
    const { container, queryByTestId } = render(<ShareBetaAscentRow ascent={makeAscent()} onActivate={vi.fn()} />);

    expect(queryByTestId('climb-thumbnail')).toBeNull();
    expect(container.querySelector('[data-icon="lightbulb"]')).toBeTruthy();
  });

  it('shows the climber grade over Boardsesh and consensus grades', () => {
    const { getByText, container } = render(<ShareBetaAscentRow ascent={makeAscent()} onActivate={vi.fn()} />);

    expect(getByText('V21')).toBeTruthy();
    expect(container.querySelector('[data-icon="people"]')).toBeNull();
  });

  it('uses the trusted Boardsesh grade with a people marker when the ascent has no personal grade', () => {
    const { getByText, container } = render(
      <ShareBetaAscentRow ascent={makeAscent({ difficulty: null, difficultyName: null })} onActivate={vi.fn()} />,
    );

    expect(getByText('V25')).toBeTruthy();
    expect(container.querySelector('[data-icon="people"]')).toBeTruthy();
  });

  it('falls back to consensus when Boardsesh grades are disabled', () => {
    renderState.boardseshActive = false;
    const { getByText } = render(
      <ShareBetaAscentRow
        ascent={makeAscent({ difficulty: null, difficultyName: null, consensusDifficulty: 21 })}
        onActivate={vi.fn()}
      />,
    );

    expect(getByText('V21')).toBeTruthy();
  });

  it('exposes one descriptive button and hides board art from accessibility', () => {
    const { getByRole, container } = render(
      <ShareBetaAscentRow ascent={makeAscent({ isMirror: true })} onActivate={vi.fn()} />,
    );

    expect(
      getByRole('button', {
        name: 'Attach beta to Purple People Eater, mirrored, V21, Send · 3 tries, Garage Board 40°, 2 hours ago',
      }),
    ).toBeTruthy();
    const decorativeWrapper = container.querySelector('[data-important-for-accessibility="no-hide-descendants"]');
    expect(decorativeWrapper?.getAttribute('data-accessible')).toBe('false');
    expect(decorativeWrapper?.getAttribute('data-elements-hidden')).toBe('true');
  });

  it('reads the current ascent when FlashList recycles the row', () => {
    const onActivate = vi.fn();
    const first = makeAscent({ uuid: 'tick-1', climbName: 'First climb' });
    const second = makeAscent({ uuid: 'tick-2', climbName: 'Second climb' });
    const { getByRole, rerender } = render(<ShareBetaAscentRow ascent={first} onActivate={onActivate} />);

    rerender(<ShareBetaAscentRow ascent={second} onActivate={onActivate} />);
    fireEvent.click(getByRole('button'));

    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(second);
  });

  it('does not re-render for referentially identical props', () => {
    const ascent = makeAscent();
    const onActivate = vi.fn();
    const element = <ShareBetaAscentRow ascent={ascent} onActivate={onActivate} />;
    const { rerender } = render(element);
    const callsAfterMount = boardConfigResolver.mock.calls.length;

    rerender(element);

    expect(boardConfigResolver).toHaveBeenCalledTimes(callsAfterMount);
  });
});
