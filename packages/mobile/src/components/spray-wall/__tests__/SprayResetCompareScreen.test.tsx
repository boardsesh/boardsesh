// @vitest-environment jsdom
//
// The compare screen, mounted.
//
// Its reducer and its selectors are covered on their own; what nothing pinned is
// the wiring — that the four view states are reachable, that a ring tap reaches
// the reducer, and that Confirm sends the payload the review describes. Each of
// those could break without a single existing test noticing.
//
// The two that matter most are the failure shapes. A proposal that failed must
// NOT render as a review (an empty review reads as "every hold has gone"), and a
// phone that found no holds must say so rather than offer a commit.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

/** Typed so the payload assertion below reads the real argument, not `never`. */
type CommitPayload = { wallUuid: string; versionId: string; kept: unknown[]; removed: number[]; added: unknown[] };
const commitMutateAsync = vi.hoisted(() =>
  vi.fn(
    async (_input: { wallUuid: string; versionId: string; kept: unknown[]; removed: number[]; added: unknown[] }) => ({
      keptCount: 1,
      removedCount: 1,
      addedCount: 1,
      climbsChanged: 2,
    }),
  ),
);
const draftState = vi.hoisted(() => ({
  current: {
    isLoading: false,
    isUnavailable: false,
    homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] as readonly number[] | null,
  },
}));
const proposalState = vi.hoisted(() => ({
  current: { data: null as unknown, isPending: false, error: null as unknown },
}));
const wallState = vi.hoisted(() => ({
  current: null as null | {
    photoWidth: number;
    photoHeight: number;
    holds: { id: number; cx: number; cy: number; r: number }[];
  },
}));
/** The board's props, so a test can fire a ring tap the way a finger does. */
const boardProps = vi.hoisted(() => ({
  current: null as null | { onHoldTap?: (key: number) => void; holdTargets?: { id: number }[] },
}));

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: {}, hairlineWidth: 1, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { lg: 12 } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemOrange: '#FF9500', systemRed: '#FF3B30' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#000', secondaryBackground: '#111', secondaryLabel: '#888', separator: '#222' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
// See SprayWallResetScreen.test.tsx: the builders return `{ name, properties }`
// and `trackSprayEvent` unpacks the pair, so the stubs have to return it too.
vi.mock('@boardsesh/analytics', () => ({
  sprayWallResetPreviewed: (properties: Record<string, unknown>) => ({ name: 'p', properties }),
  sprayWallResetApplied: (properties: Record<string, unknown>) => ({ name: 'a', properties }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: (error: unknown) => (error as Error)?.message,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: { key: string; label: string }[];
    onSelect: (key: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'filter' },
      options.map((option) =>
        createElement('button', { key: option.key, onClick: () => onSelect(option.key) }, option.label),
      ),
    ),
}));
vi.mock('../../search/InteractiveFilterBoard', () => ({
  InteractiveFilterBoard: (props: { onHoldTap?: (key: number) => void; holdTargets?: { id: number }[] }) => {
    boardProps.current = props;
    return createElement('div', { 'data-testid': 'board' });
  },
}));
vi.mock('../SprayResetSvgLayer', () => ({ SprayResetSvgLayer: () => null }));

vi.mock('../../../lib/spray/spray-wall-registry', () => ({
  SPRAY_BOARD_NAME: 'spray',
  getSprayWall: () => wallState.current,
  subscribeToSprayWalls: () => () => {},
}));
vi.mock('../../../lib/spray/use-spray-wall-draft', () => ({ useSprayWallDraft: () => draftState.current }));
vi.mock('../../../lib/spray/use-spray-wall-reset', () => ({
  useSprayWallResetProposal: () => proposalState.current,
  useCommitSprayWallVersion: () => ({ mutateAsync: commitMutateAsync, isPending: false }),
}));

const { SprayResetCompareScreen } = await import('../SprayResetCompareScreen');

const CANDIDATES = [
  { cx: 400, cy: 400, r: 8, confidence: 0.9 },
  { cx: 500, cy: 500, r: 8, confidence: 0.5 },
];

const PROPOSAL = {
  versionNumber: 2,
  kept: [{ holdId: 11, detectionIndex: 0, confidence: 0.95 }],
  removed: [12],
  added: [1],
  lowConfidence: [],
  climbsAffected: 2,
  movesSuggested: [{ movedFromHoldId: 12, detectionIndex: 1, distance: 20 }],
  aspectMismatch: false,
};

function renderScreen(onCommitted = vi.fn()) {
  return render(
    createElement(SprayResetCompareScreen, {
      wallUuid: 'wall-1',
      layoutId: 9001,
      versionId: '42',
      versionNumber: 2,
      candidates: CANDIDATES,
      onCommitted,
    }),
  );
}

beforeEach(() => {
  commitMutateAsync.mockClear();
  boardProps.current = null;
  draftState.current = { isLoading: false, isUnavailable: false, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  proposalState.current = { data: PROPOSAL, isPending: false, error: null };
  wallState.current = {
    photoWidth: 1000,
    photoHeight: 1000,
    holds: [
      { id: 11, cx: 100, cy: 100, r: 10 },
      { id: 12, cx: 200, cy: 200, r: 10 },
    ],
  };
});

describe('SprayResetCompareScreen', () => {
  it('spins while the wall loads rather than claiming nothing was found', () => {
    // `detections` is empty until the homography lands, so the empty state and
    // "still loading" are indistinguishable from the inside.
    draftState.current = { isLoading: true, isUnavailable: false, homography: null };
    const { getByTestId, queryByText } = renderScreen();

    expect(getByTestId('spinner')).toBeTruthy();
    expect(queryByText('sprayReset.compare.noDetections')).toBeNull();
  });

  it('refuses to review a reset the phone found no holds for', () => {
    const { getByText, queryByTestId } = render(
      createElement(SprayResetCompareScreen, {
        wallUuid: 'wall-1',
        layoutId: 9001,
        versionId: '42',
        versionNumber: 2,
        candidates: [],
        onCommitted: vi.fn(),
      }),
    );

    expect(getByText('sprayReset.compare.noDetections')).toBeTruthy();
    // No board and no Confirm: an empty second set means "the whole wall has gone".
    expect(queryByTestId('board')).toBeNull();
  });

  it('shows the proposal error instead of an empty review when propose fails', () => {
    proposalState.current = { data: null, isPending: false, error: new Error('Network request failed') };
    const { getByText, queryByTestId } = renderScreen();

    expect(getByText('Network request failed')).toBeTruthy();
    expect(queryByTestId('board')).toBeNull();
  });

  it('renders the review: counts, filter, board and Confirm', () => {
    const { getByTestId, getByText } = renderScreen();

    expect(getByTestId('board')).toBeTruthy();
    expect(getByTestId('filter')).toBeTruthy();
    expect(getByText(/sprayReset\.compare\.counts/)).toBeTruthy();
    expect(getByText('sprayReset.compare.confirm')).toBeTruthy();
  });

  it('opens the panel for the ring under the finger', () => {
    const { getByText } = renderScreen();

    act(() => boardProps.current?.onHoldTap?.(12));
    // Hold 12 is the proposal's removal, so the panel offers to put it back.
    expect(getByText('sprayReset.hold.stillHere')).toBeTruthy();
  });

  it('takes every suggested move in one press', () => {
    const { getByText } = renderScreen();

    act(() => getByText('sprayReset.compare.acceptMoves').click());
    // Detection 1 is now paired with hold 12, which the panel names.
    act(() => boardProps.current?.onHoldTap?.(-2));
    expect(getByText(/sprayReset\.pairing\.paired/)).toBeTruthy();
  });

  it('sends the reviewed decisions on Confirm and reports the result', async () => {
    const onCommitted = vi.fn();
    const { getByText } = renderScreen(onCommitted);

    await act(async () => {
      getByText('sprayReset.compare.confirm').click();
    });

    expect(commitMutateAsync).toHaveBeenCalledTimes(1);
    const payload = commitMutateAsync.mock.calls[0][0] as CommitPayload;
    expect(payload.wallUuid).toBe('wall-1');
    expect(payload.removed).toEqual([12]);
    expect(payload.added).toHaveLength(1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('keeps the review when the commit is refused', async () => {
    commitMutateAsync.mockRejectedValueOnce(new Error('SPRAY_WALL_VERSION_SUPERSEDED'));
    const onCommitted = vi.fn();
    const { getByText, getByTestId } = renderScreen(onCommitted);

    await act(async () => {
      getByText('sprayReset.compare.confirm').click();
    });

    expect(onCommitted).not.toHaveBeenCalled();
    // Still reviewable, so the owner can retry without redoing a hundred rings.
    expect(getByTestId('board')).toBeTruthy();
    expect(getByText('sprayReset.compare.confirm')).toBeTruthy();
  });

  it('warns about a differently framed photo without blocking the commit', () => {
    proposalState.current = { data: { ...PROPOSAL, aspectMismatch: true }, isPending: false, error: null };
    const { getByText } = renderScreen();

    expect(getByText('sprayReset.compare.aspectWarning')).toBeTruthy();
    expect(getByText('sprayReset.compare.confirm')).toBeTruthy();
  });
});
