// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

const queue = vi.hoisted(() => ({
  sessionId: null as string | null,
  joinSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
}));

const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn() }));

// A loaded, active session preview so the screen renders the confirmation card.
const preview = vi.hoisted(() => ({
  data: {
    id: 'session-42',
    boardPath: '/kilter/1/10/1,2/40',
    endedAt: null as string | null,
    users: [{ id: 'u1', username: 'host', avatarUrl: null, isLeader: true }],
  } as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

// Capture the confirmation card's Join button so the test can press it.
const buttons = vi.hoisted(() => ({ joinPress: null as (() => void) | null }));

// Lets a test simulate an unparseable board path (parseBoardPath → null).
const boardConfig = vi.hoisted(() => ({
  parsed: { boardName: 'kilter', layoutId: 1, angle: 40 } as { boardName: string; layoutId: number; angle: number } | null,
}));

vi.mock('../../../src/lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: vi.fn() },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'session-42' }),
  useRouter: () => router,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));

vi.mock('@boardsesh/board-config', () => ({
  parseBoardPath: () => boardConfig.parsed,
  formatBoardDisplayName: () => 'Kilter',
}));

// The first Button rendered in the confirmation card is the Join action.
vi.mock('../../../src/components/Button', () => ({
  Button: ({ onPress }: { onPress?: () => void }) => {
    if (buttons.joinPress === null && onPress) buttons.joinPress = onPress;
    return createElement('button');
  },
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../src/providers/queue-provider', () => ({
  useQueue: () => ({
    sessionId: queue.sessionId,
    joinSession: queue.joinSession,
    clearSession: queue.clearSession,
  }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useSessionPreview: () => preview,
  useMyBoards: () => ({ data: { boards: [] }, refetch: vi.fn(async () => ({ data: { boards: [] } })) }),
  useCreateBoard: () => ({ mutateAsync: vi.fn(async () => ({})) }),
}));
vi.mock('../../../src/lib/board-path-to-user-board', () => ({
  resolveBoardForSession: vi.fn(async () => ({ uuid: 'board-1' })),
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: {}, borderRadius: {} }));

import JoinSessionScreen from '../[sessionId]';

beforeEach(() => {
  analytics.track.mockClear();
  queue.sessionId = null;
  queue.joinSession.mockClear();
  buttons.joinPress = null;
  boardConfig.parsed = { boardName: 'kilter', layoutId: 1, angle: 40 };
});

describe('JoinSessionScreen analytics', () => {
  it('fires "Session Joined" with session_id + board props after a successful join', async () => {
    render(createElement(JoinSessionScreen));
    expect(buttons.joinPress).not.toBeNull();

    await act(async () => {
      buttons.joinPress?.();
    });

    // performJoin awaits resolveBoardForSession → joinSession before tracking;
    // poll until those promises settle rather than flushing a fixed number of
    // microtasks.
    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith('Session Joined', {
        session_id: 'session-42',
        board_name: 'kilter',
        layout_id: 1,
      }),
    );

    expect(queue.joinSession).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/record');
  });

  it('does not fire "Session Joined" when the board path is unparseable', async () => {
    boardConfig.parsed = null;
    render(createElement(JoinSessionScreen));
    expect(buttons.joinPress).not.toBeNull();

    await act(async () => {
      buttons.joinPress?.();
    });

    // The join still completes; we just skip the event rather than send null
    // board props that would never group with web's events.
    await waitFor(() => expect(queue.joinSession).toHaveBeenCalledTimes(1));
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/record');
    expect(analytics.track).not.toHaveBeenCalledWith('Session Joined', expect.anything());
  });
});
