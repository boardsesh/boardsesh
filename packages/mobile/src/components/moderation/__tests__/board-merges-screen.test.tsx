// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { BoardMergesScreen } from '../BoardMergesScreen';
const state = vi.hoisted(() => ({
  authenticated: true,
  offline: false,
  canMerge: false,
  confirmed: true,
  previewError: false,
  previewFetching: false,
}));
const request = vi.hoisted(() => vi.fn(async () => ({})));
const confirm = vi.hoisted(() => vi.fn(async () => state.confirmed));
const invalidate = vi.hoisted(() => vi.fn(async () => {}));
const toast = vi.hoisted(() => vi.fn());
const boards = vi.hoisted(() => [
  {
    uuid: 'first',
    name: 'Mirror wall',
    isPublic: true,
    boardType: 'tension',
    layoutId: 10,
    sizeId: 6,
    angle: 30,
    setIds: '12,13',
  },
  {
    uuid: 'second',
    name: 'Spray wall',
    isPublic: true,
    boardType: 'tension',
    layoutId: 11,
    sizeId: 6,
    angle: 45,
    setIds: '12,13',
  },
]);
vi.mock('@boardsesh/graphql/operations', () => ({
  BOARD_MERGE_CANDIDATES: 'candidates',
  BOARD_MERGE_PREVIEW: 'preview',
  BOARD_MERGE_REQUESTS: 'requests',
  REQUEST_BOARD_MERGE: 'request',
  MERGE_BOARDS: 'merge',
  RESOLVE_BOARD_MERGE_REQUEST: 'resolve',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 8: 32 }, borderRadius: { md: 8 } }));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    data: unknown[];
    renderItem: (input: { item: unknown }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      ListHeaderComponent,
      data.length
        ? data.map((item, index) => createElement('div', { key: index }, renderItem({ item })))
        : ListEmptyComponent,
    ),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: invalidate }),
  useInfiniteQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: {
      pages: [queryKey[0] === 'boardMergeCandidates' ? { boards, hasMore: false } : { requests: [], hasMore: false }],
    },
    refetch: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled: boolean }) => ({
    data:
      enabled && queryKey[0] === 'boardMergePreview'
        ? { boards, suggestedCanonicalBoardUuid: 'first', canMerge: state.canMerge, version: 'v1' }
        : null,
    isError: state.previewError,
    isFetching: state.previewFetching,
    isPending: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityRole: string;
    accessibilityState: { checked: boolean };
    disabled: boolean;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'aria-label': accessibilityLabel,
        role: accessibilityRole,
        'aria-checked': accessibilityState.checked,
        disabled,
      },
      children,
    ),
}));
vi.mock('../../AccessibleTextInput', () => ({
  AccessibleTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (next: string) => void;
  }) =>
    createElement('input', {
      'aria-label': accessibilityLabel,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
vi.mock('../../AppMenu', () => ({ AppMenu: () => null }));
vi.mock('../../RadioGroup', () => ({ RadioGroup: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../OfflineState', () => ({ OfflineState: () => createElement('span', null, 'offline') }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../../lib/graphql/use-auth-token', () => ({
  useAuthToken: () => ({ data: state.authenticated ? 'token' : null }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline }),
}));
vi.mock('../../../hooks/use-privacy-scoped-state', () => ({ usePrivacyCredentialScope: () => 1 }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => 1 }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('../../../lib/graphql/hooks', () => ({ fetchBoardByUuid: vi.fn() }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  getActiveBoardWriteGeneration: () => 1,
  useActiveBoard: () => ({ data: null }),
  useSetActiveBoardIfCurrentGeneration: () => vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.authenticated = true;
  state.offline = false;
  state.canMerge = false;
  state.confirmed = true;
  state.previewError = false;
  state.previewFetching = false;
});
function compose() {
  const screen = render(<BoardMergesScreen gymUuid="gym" />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Mirror wall' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Spray wall' }));
  fireEvent.click(screen.getByRole('button', { name: 'merge.preview' }));
  fireEvent.change(screen.getByLabelText('merge.reason'), {
    target: { value: 'Both listings describe the same wall' },
  });
  return screen;
}
describe('board merge flow', () => {
  it('submits a request when the viewer cannot merge directly', async () => {
    const screen = compose();
    fireEvent.click(screen.getByRole('button', { name: 'merge.request' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('request', {
        input: {
          boardUuids: ['first', 'second'],
          canonicalBoardUuid: 'first',
          reason: 'Both listings describe the same wall',
        },
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
  });
  it('cancelling confirmation leaves boards untouched', async () => {
    state.canMerge = true;
    state.confirmed = false;
    const screen = compose();
    fireEvent.click(screen.getByRole('button', { name: 'merge.merge' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(request).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation and sends the reviewed version', async () => {
    state.canMerge = true;
    const screen = compose();
    fireEvent.click(screen.getByRole('button', { name: 'merge.merge' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('merge', {
        input: {
          boardUuids: ['first', 'second'],
          canonicalBoardUuid: 'first',
          reason: 'Both listings describe the same wall',
          version: 'v1',
        },
      }),
    );
  });
  it('blocks submission when a reviewed preview becomes stale or fails refresh', () => {
    state.canMerge = true;
    state.previewError = true;
    const screen = compose();
    expect(screen.getByRole('button', { name: 'merge.merge' }).hasAttribute('disabled')).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it('offers sign-in instead of a composer to signed-out users', () => {
    state.authenticated = false;
    const screen = render(<BoardMergesScreen gymUuid="gym" />);
    expect(screen.getByText('merge.authRequired')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('never queues an offline merge', () => {
    state.offline = true;
    state.canMerge = true;
    const screen = render(<BoardMergesScreen gymUuid="gym" />);
    expect(screen.getByRole('button', { name: 'merge.preview' }).hasAttribute('disabled')).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
