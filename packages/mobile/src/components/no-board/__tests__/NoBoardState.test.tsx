// @vitest-environment jsdom
//
// Climbs with no board bound: who gets the read-only preview, who keeps the
// "Pick your board" placard, and what the exposure event says about it. The
// copy is the en-US catalog itself, so a renamed key fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import climbsCatalog from '@boardsesh/i18n/locales/en-US/climbs.json';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import type { NoBoardPreviewConfig } from '../../../lib/boards/no-board-preview';

type Children = { children?: ReactNode };
type QueryResult<TData> = { data: TData | undefined; isError: boolean; isPending: boolean; isFetching: boolean };
type PreviewProps = {
  configs: readonly NoBoardPreviewConfig[];
  onFindBoard: () => void;
  onClimbPress: (config: NoBoardPreviewConfig, rowIndex: number) => void;
  onHeroPress: (config: NoBoardPreviewConfig) => void;
  searchName?: string;
  onSearchSettled: (outcome: 'ready' | 'error' | 'empty') => void;
  active?: boolean;
};

const trackMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const previewProps = vi.hoisted(() => ({ current: null as PreviewProps | null }));
const hookOptions = vi.hoisted(() => ({
  boards: vi.fn(),
  profile: vi.fn(),
  popular: vi.fn(),
}));
const world = vi.hoisted(() => ({
  auth: { isAuthenticated: true, isLoading: false },
  isOffline: false,
  isFocused: true,
  // What the Climbs search provider holds, or null where there is none.
  climbSearch: null as { name: string } | null,
  flagsResolved: true,
  previewEnabled: true,
  boards: { data: undefined, isError: false, isPending: true, isFetching: true } as QueryResult<{ boards: unknown[] }>,
  profile: { data: undefined, isError: false, isPending: true, isFetching: true } as QueryResult<{
    createdAt?: string;
  }>,
  popular: { data: undefined, isError: false, isPending: true, isFetching: true } as QueryResult<{
    configs: PopularBoardConfig[];
  }>,
  previewConfigs: [] as NoBoardPreviewConfig[],
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock }),
  useIsFocused: () => world.isFocused,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          climbsCatalog,
        );
      return typeof found === 'string' ? found : key;
    },
  }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
// The list itself has its own suite. Here it only has to say it mounted and
// hand its callbacks back.
vi.mock('../NoBoardClimbsPreview', () => ({
  NoBoardClimbsPreview: (props: PreviewProps) => {
    previewProps.current = props;
    return createElement(
      'div',
      { 'data-testid': 'preview' },
      props.configs.map((config) => config.boardName).join(','),
    );
  },
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => world.auth }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlagsResolved: () => world.flagsResolved,
  useNoBoardPreviewEnabled: () => world.previewEnabled,
}));
vi.mock('../../../providers/climb-search-provider', () => ({ useOptionalClimbSearch: () => world.climbSearch }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => world.isOffline }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useMyBoards: (input: unknown, options: unknown) => {
    hookOptions.boards(input, options);
    return world.boards;
  },
  useProfile: (options: unknown) => {
    hookOptions.profile(options);
    return world.profile;
  },
  usePopularBoardConfigs: (input: unknown, options: unknown) => {
    hookOptions.popular(input, options);
    return world.popular;
  },
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
// 50 hours after the account below was created.
vi.mock('../../../lib/clock', () => ({ nowMs: () => Date.parse('2026-10-03T02:00:00Z') }));
// The catalogue-backed resolution has its own suite; the real decision runs.
vi.mock('../../../lib/boards/no-board-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boards/no-board-preview')>()),
  resolvePreviewConfigs: (popularConfigs: readonly PopularBoardConfig[] | null | undefined) =>
    popularConfigs ? world.previewConfigs : [],
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray4: '#ccc' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16 } }));

const { NoBoardState } = await import('../NoBoardState');

const KILTER: NoBoardPreviewConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const TENSION: NoBoardPreviewConfig = { boardName: 'tension', layoutId: 9, sizeId: 1, setIds: '8,9', angle: 40 };

function ready<TData>(data: TData): QueryResult<TData> {
  return { data, isError: false, isPending: false, isFetching: false };
}
function failed<TData>(): QueryResult<TData> {
  return { data: undefined, isError: true, isPending: false, isFetching: false };
}
function loading<TData>(): QueryResult<TData> {
  return { data: undefined, isError: false, isPending: true, isFetching: true };
}

/** A signed-in, online account with no boards and two previewable setups. */
function zeroBoardNewcomer() {
  world.auth = { isAuthenticated: true, isLoading: false };
  world.isOffline = false;
  world.isFocused = true;
  world.climbSearch = null;
  world.flagsResolved = true;
  world.previewEnabled = true;
  world.boards = ready({ boards: [] });
  world.profile = ready({ createdAt: '2026-09-30T23:30:00Z' });
  world.popular = ready({ configs: [] });
  world.previewConfigs = [KILTER, TENSION];
}

function viewedEvents() {
  return trackMock.mock.calls.filter(([eventName]) => eventName === 'Climbs No Board State Viewed');
}

describe('NoBoardState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewProps.current = null;
    zeroBoardNewcomer();
  });
  afterEach(cleanup);

  it('shows an account with no boards the preview, with the setups from the popular list', () => {
    render(<NoBoardState />);

    expect(screen.getByTestId('preview').textContent).toBe('kilter,tension');
    expect(screen.queryByTestId('no-board-placard')).toBeNull();
    // The picker's cache entry, so the two share one request.
    expect(hookOptions.popular).toHaveBeenLastCalledWith({ limit: 12 }, { enabled: true });
  });

  it('reports the preview once its climbs are on screen, and only once', () => {
    const { rerender } = render(<NoBoardState />);
    // Mounted but still loading: nothing to report yet.
    expect(viewedEvents()).toHaveLength(0);

    act(() => previewProps.current?.onSearchSettled('ready'));
    // A second setup's search settling (a chip tap) is not a second exposure.
    act(() => previewProps.current?.onSearchSettled('ready'));
    rerender(<NoBoardState />);

    expect(viewedEvents()).toEqual([
      [
        'Climbs No Board State Viewed',
        {
          variant: 'preview',
          owned_board_count: 0,
          account_age_hours: 50,
          preview_board_type: 'kilter',
          fallback_reason: null,
        },
      ],
    ]);
  });

  it.each([
    ['error', 'search_error'],
    ['empty', 'no_climbs'],
  ] as const)('falls back to the placard when the search ends in %s', (outcome, fallbackReason) => {
    render(<NoBoardState />);
    act(() => previewProps.current?.onSearchSettled(outcome));

    expect(screen.queryByTestId('preview')).toBeNull();
    expect(screen.getByText('Pick your board')).toBeTruthy();
    expect(viewedEvents()).toEqual([
      [
        'Climbs No Board State Viewed',
        expect.objectContaining({ variant: 'placard', fallback_reason: fallbackReason, preview_board_type: null }),
      ],
    ]);
  });

  // The search is a network read. A connection lost before it lands would
  // leave a spinner with nothing behind it.
  it('falls back to the placard when the phone goes offline before the climbs land', () => {
    const { rerender } = render(<NoBoardState />);
    world.isOffline = true;
    rerender(<NoBoardState />);

    expect(screen.getByTestId('no-board-placard')).toBeTruthy();
    expect(viewedEvents()[0][1]).toMatchObject({ variant: 'placard', fallback_reason: 'offline' });
  });

  // Climbs stays mounted for the whole session: a launch in a signal gap must
  // not cost the climber the preview until they relaunch.
  it('brings the preview in once the connection is back, and reports both', () => {
    world.isOffline = true;
    const { rerender } = render(<NoBoardState />);
    expect(screen.getByTestId('no-board-placard')).toBeTruthy();

    world.isOffline = false;
    rerender(<NoBoardState />);
    expect(screen.getByTestId('preview')).toBeTruthy();
    act(() => previewProps.current?.onSearchSettled('ready'));

    expect(viewedEvents().map(([, props]) => [props.variant, props.fallback_reason])).toEqual([
      ['placard', 'offline'],
      ['preview', null],
    ]);
  });

  it('decides again after the board list recovers from a failed read', () => {
    world.boards = failed();
    const { rerender } = render(<NoBoardState />);
    expect(screen.getByTestId('no-board-placard')).toBeTruthy();

    world.boards = ready({ boards: [] });
    rerender(<NoBoardState />);
    expect(screen.getByTestId('preview')).toBeTruthy();
  });

  it('gets the preview back when a connection lost mid-search returns', () => {
    const { rerender } = render(<NoBoardState />);
    world.isOffline = true;
    rerender(<NoBoardState />);
    expect(screen.getByTestId('no-board-placard')).toBeTruthy();

    world.isOffline = false;
    rerender(<NoBoardState />);
    expect(screen.getByTestId('preview')).toBeTruthy();
  });

  // The climber picked another board type from a working list. That setup's
  // failure is the list's to show; the screen and the exposure stay a preview.
  it.each(['error', 'empty'] as const)('keeps a working preview when a later board type ends in %s', (outcome) => {
    render(<NoBoardState />);
    act(() => previewProps.current?.onSearchSettled('ready'));
    act(() => previewProps.current?.onSearchSettled(outcome));

    expect(screen.getByTestId('preview')).toBeTruthy();
    expect(screen.queryByTestId('no-board-placard')).toBeNull();
    expect(viewedEvents().map(([, props]) => props.variant)).toEqual(['preview']);
  });

  // Climbs is the entry tab, so the launch gate's first-board picker opens over
  // this for a new account. Someone who binds from that picker never saw the
  // preview and must not count as a preview conversion.
  it('searches nothing and reports nothing while another screen is over it', () => {
    world.isFocused = false;
    const { rerender } = render(<NoBoardState />);

    expect(previewProps.current?.active).toBe(false);
    // Even if a cached page reports in, nobody is looking.
    act(() => previewProps.current?.onSearchSettled('ready'));
    expect(viewedEvents()).toHaveLength(0);

    world.isFocused = true;
    rerender(<NoBoardState />);
    expect(previewProps.current?.active).toBe(true);
    expect(viewedEvents().map(([, props]) => props.variant)).toEqual(['preview']);
  });

  it('does not report a covered placard either', () => {
    world.isFocused = false;
    world.boards = ready({ boards: [{}] });
    const { rerender } = render(<NoBoardState />);
    expect(viewedEvents()).toHaveLength(0);

    world.isFocused = true;
    rerender(<NoBoardState />);
    expect(viewedEvents()).toHaveLength(1);
  });

  it('tries a failed search again when the climber comes back to Climbs', () => {
    const { rerender } = render(<NoBoardState />);
    act(() => previewProps.current?.onSearchSettled('error'));
    expect(screen.getByTestId('no-board-placard')).toBeTruthy();

    world.isFocused = false;
    rerender(<NoBoardState />);
    world.isFocused = true;
    rerender(<NoBoardState />);

    expect(screen.getByTestId('preview')).toBeTruthy();
  });

  it('keeps the placard on return when the setup simply had no climbs', () => {
    const { rerender } = render(<NoBoardState />);
    act(() => previewProps.current?.onSearchSettled('empty'));

    world.isFocused = false;
    rerender(<NoBoardState />);
    world.isFocused = true;
    rerender(<NoBoardState />);

    expect(screen.getByTestId('no-board-placard')).toBeTruthy();
  });

  it('keeps a preview that is already showing climbs through a connectivity blip', () => {
    const { rerender } = render(<NoBoardState />);
    act(() => previewProps.current?.onSearchSettled('ready'));
    world.isOffline = true;
    rerender(<NoBoardState />);

    expect(screen.getByTestId('preview')).toBeTruthy();
  });

  // Their own list is one tap away; a stranger's wall is the wrong thing to show.
  it('keeps the placard for an account that has boards, and never asks for the popular list', () => {
    world.boards = ready({ boards: [{}, {}] });
    render(<NoBoardState />);

    expect(screen.getByTestId('no-board-placard')).toBeTruthy();
    expect(hookOptions.popular).toHaveBeenLastCalledWith({ limit: 12 }, { enabled: false });
    expect(viewedEvents()).toEqual([
      [
        'Climbs No Board State Viewed',
        {
          variant: 'placard',
          owned_board_count: 2,
          account_age_hours: 50,
          preview_board_type: null,
          fallback_reason: 'has_boards',
        },
      ],
    ]);
  });

  it('keeps the placard with the kill switch on, and still reports the exposure', () => {
    world.previewEnabled = false;
    render(<NoBoardState />);

    expect(screen.getByTestId('no-board-placard')).toBeTruthy();
    expect(viewedEvents()[0][1]).toMatchObject({
      variant: 'placard',
      owned_board_count: 0,
      fallback_reason: 'kill_switch',
    });
  });

  it.each([
    [
      'offline',
      (): void => {
        world.isOffline = true;
      },
      'offline',
    ],
    [
      'the board list fails',
      (): void => {
        world.boards = failed();
      },
      'boards_unknown',
    ],
    [
      'the popular list fails',
      (): void => {
        world.popular = failed();
      },
      'no_config',
    ],
    [
      'no popular setup can be drawn',
      (): void => {
        world.previewConfigs = [];
      },
      'no_config',
    ],
    [
      'signed out',
      (): void => {
        world.auth = { isAuthenticated: false, isLoading: false };
      },
      'signed_out',
    ],
  ] as const)('keeps the placard when %s', (_name, arrange, fallbackReason) => {
    arrange();
    render(<NoBoardState />);

    expect(screen.getByTestId('no-board-placard')).toBeTruthy();
    expect(screen.queryByTestId('preview')).toBeNull();
    expect(viewedEvents()).toHaveLength(1);
    expect(viewedEvents()[0][1]).toMatchObject({ variant: 'placard', fallback_reason: fallbackReason });
  });

  // A kill switch flipped in PostHog has to land before the list is swapped in.
  it('holds the placard and reports nothing until the flags and the board list settle', () => {
    world.flagsResolved = false;
    world.boards = loading();
    const { rerender } = render(<NoBoardState />);

    expect(screen.getByTestId('no-board-placard')).toBeTruthy();
    expect(viewedEvents()).toHaveLength(0);

    world.boards = ready({ boards: [] });
    rerender(<NoBoardState />);
    expect(screen.queryByTestId('preview')).toBeNull();

    world.flagsResolved = true;
    rerender(<NoBoardState />);
    expect(screen.getByTestId('preview')).toBeTruthy();
  });

  it('waits for the profile, so the exposure carries the account age', () => {
    world.profile = loading();
    const { rerender } = render(<NoBoardState />);
    expect(screen.queryByTestId('preview')).toBeNull();

    world.profile = failed();
    rerender(<NoBoardState />);
    act(() => previewProps.current?.onSearchSettled('ready'));

    expect(viewedEvents()[0][1]).toMatchObject({ variant: 'preview', account_age_hours: null });
  });

  // The first settled answer holds: a refetch must not pull the list out from
  // under a climber who is reading it.
  it('does not swap the preview for the placard when a later refetch changes the inputs', () => {
    const { rerender } = render(<NoBoardState />);
    act(() => previewProps.current?.onSearchSettled('ready'));

    world.boards = ready({ boards: [{}] });
    world.previewEnabled = false;
    rerender(<NoBoardState />);

    expect(screen.getByTestId('preview')).toBeTruthy();
    expect(viewedEvents()).toHaveLength(1);
  });

  it('opens the picker from "Find my board" on the placard, tagged as the button', () => {
    world.boards = ready({ boards: [{}] });
    render(<NoBoardState />);
    fireEvent.click(screen.getByRole('button', { name: 'Find my board' }));

    expect(pushMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { source: 'no_board', trigger: 'cta' },
    });
  });

  it('opens the picker from the preview\'s "Find my board" the same way', () => {
    render(<NoBoardState />);
    act(() => previewProps.current?.onFindBoard());

    expect(pushMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { source: 'no_board', trigger: 'cta' },
    });
  });

  // Nothing is bound and no climb opens: a row tap goes to the picker.
  it('sends a tap on a previewed climb to the picker and reports which row', () => {
    render(<NoBoardState />);
    act(() => previewProps.current?.onClimbPress(TENSION, 4));

    expect(trackMock).toHaveBeenCalledWith('No Board Preview Climb Tapped', { board_type: 'tension', row_index: 4 });
    expect(pushMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { source: 'no_board', trigger: 'preview_row' },
    });
  });

  // The lit board at the top is the first climb of the page: same event, place
  // 0, and its own trigger so it can be told from a row.
  it('sends a tap on the lit board to the picker as place 0, with its own trigger', () => {
    render(<NoBoardState />);
    act(() => previewProps.current?.onHeroPress(KILTER));

    expect(trackMock).toHaveBeenCalledWith('No Board Preview Climb Tapped', { board_type: 'kilter', row_index: 0 });
    expect(pushMock).toHaveBeenCalledExactlyOnceWith({
      pathname: '/boards',
      params: { source: 'no_board', trigger: 'preview_hero' },
    });
  });

  it('hands the preview what is typed in the Climbs search field', () => {
    world.climbSearch = { name: 'moon' };
    render(<NoBoardState />);

    expect(previewProps.current?.searchName).toBe('moon');
  });

  it('mounts with no Climbs search around it, with nothing typed', () => {
    render(<NoBoardState />);

    expect(previewProps.current?.searchName).toBe('');
  });

  // Sign-in invalidates the `null` profile the signed-out tree cached, so the
  // query is not pending while the real one loads. Reporting then would send a
  // null age for exactly the fresh sign-ups this event is cut by.
  it('waits out a profile refetch over a cached null before reporting', () => {
    world.boards = ready({ boards: [{}] });
    world.profile = { data: undefined, isError: false, isPending: false, isFetching: true };
    const { rerender } = render(<NoBoardState />);
    expect(viewedEvents()).toHaveLength(0);

    world.profile = ready({ createdAt: '2026-09-30T23:30:00Z' });
    rerender(<NoBoardState />);
    expect(viewedEvents()[0][1]).toMatchObject({ variant: 'placard', account_age_hours: 50 });
  });

  // An unresolved flag bag reads as "enabled"; the request would be wasted
  // whenever the kill switch then lands.
  it('does not ask for the popular list until the flags have resolved', () => {
    world.flagsResolved = false;
    render(<NoBoardState />);

    expect(hookOptions.popular).toHaveBeenLastCalledWith({ limit: 12 }, { enabled: false });
  });

  it('only reads the board list and the profile for a signed-in climber', () => {
    world.auth = { isAuthenticated: false, isLoading: false };
    render(<NoBoardState />);

    expect(hookOptions.boards).toHaveBeenLastCalledWith(undefined, { enabled: false });
    expect(hookOptions.profile).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('waits for the stored session before calling anyone signed out', () => {
    world.auth = { isAuthenticated: false, isLoading: true };
    render(<NoBoardState />);

    expect(screen.getByTestId('no-board-placard')).toBeTruthy();
    expect(viewedEvents()).toHaveLength(0);
  });
});
