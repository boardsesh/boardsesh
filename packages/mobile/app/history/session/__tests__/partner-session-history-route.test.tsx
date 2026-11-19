// @vitest-environment jsdom
import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({
  authenticated: true,
  consent: true,
  fetching: false,
  answer: undefined as string | null | undefined,
  error: false,
  generation: 1,
  changeAccountDuringQuery: false,
  exportId: '3c2d56f7-1f63-4c63-9c48-3c239b14727d',
}));
const { replace, setItem } = vi.hoisted(() => ({
  replace: vi.fn(),
  setItem: vi.fn(async (_key: string, _stored: string) => {}),
}));
vi.mock('react-native', () => ({ View: 'div', StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ exportId: state.exportId }),
  useRouter: () => ({ replace }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => {
    if (state.changeAccountDuringQuery) state.generation += 1;
    return { data: state.answer, isError: state.error, isFetching: state.fetching, refetch: vi.fn() };
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { setItem } }));
vi.mock('../../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.authenticated }),
}));
vi.mock('../../../../src/lib/consent-hooks', () => ({ useConsentSettled: () => state.consent }));
vi.mock('../../../../src/lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => state.generation }));
vi.mock('../../../../src/lib/graphql/client', () => ({ getHttpClient: vi.fn() }));
vi.mock('../../../../src/lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children: string }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title }: { title: string }) => createElement('button', null, title),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../../src/theme/tokens', () => ({ spacing: { 4: 16 } }));

import PartnerSessionHistoryRoute from '../[exportId]';
import { readPendingSessionHistory } from '../../../../src/lib/partner-session-history-link';

beforeEach(() => {
  Object.assign(state, {
    authenticated: true,
    consent: true,
    fetching: false,
    answer: undefined,
    error: false,
    generation: 1,
    changeAccountDuringQuery: false,
  });
  vi.clearAllMocks();
});

describe('read-only session history route', () => {
  it('opens authenticated history detail without entering the join flow', () => {
    state.answer = 'internal-session-id';
    render(createElement(PartnerSessionHistoryRoute));
    expect(replace).toHaveBeenCalledWith({
      pathname: '/(tabs)/home/session/[sessionId]',
      params: { sessionId: 'internal-session-id' },
    });
  });

  it.each(['fetching', 'error'] as const)('does not open cached data while %s', (kind) => {
    state.answer = 'stale-private-session';
    state[kind] = true;
    render(createElement(PartnerSessionHistoryRoute));
    expect(replace).not.toHaveBeenCalled();
  });

  it('waits for privacy consent before opening private history', () => {
    state.answer = 'internal-session-id';
    state.consent = false;
    const view = render(createElement(PartnerSessionHistoryRoute));
    expect(replace).not.toHaveBeenCalled();
    state.consent = true;
    view.rerender(createElement(PartnerSessionHistoryRoute));
    expect(replace).toHaveBeenCalledOnce();
  });

  it('denies account mismatch without navigating to the session', () => {
    state.answer = null;
    const view = render(createElement(PartnerSessionHistoryRoute));
    expect(view.getByText('partnerHistory.unavailable')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('drops an older account’s resolved history when credentials change before navigation', () => {
    state.answer = 'previous-account-session';
    state.changeAccountDuringQuery = true;
    render(createElement(PartnerSessionHistoryRoute));
    expect(replace).not.toHaveBeenCalled();
  });

  it('preserves the opaque reference before opening sign-in', async () => {
    state.authenticated = false;
    render(createElement(PartnerSessionHistoryRoute));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/login'));
    const serialized = setItem.mock.calls.at(-1)?.[1] as string | undefined;
    expect(readPendingSessionHistory(serialized ?? null)).toBe(state.exportId);
  });

  it('does not redirect an obsolete signed-out render after credentials change while stashing', async () => {
    state.authenticated = false;
    setItem.mockImplementationOnce(async () => {
      state.generation += 1;
    });
    render(createElement(PartnerSessionHistoryRoute));
    await waitFor(() => expect(setItem).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
  });
});
