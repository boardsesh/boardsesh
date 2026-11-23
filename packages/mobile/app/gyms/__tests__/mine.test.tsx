// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type PressProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
type ButtonProps = { title: string; onPress: () => void };

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
const openUrl = vi.hoisted(() => ({ openValidatedUrl: vi.fn().mockResolvedValue(true) }));
const setKioskHintSeen = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const fetchNextPage = vi.hoisted(() => vi.fn());

// Mutable per-test state driving the mocked hooks.
const state = vi.hoisted(() => ({
  profileId: 'owner-1' as string | undefined,
  kioskHintSeen: false,
  hasNextPage: false,
  myGyms: {
    data: undefined as { gyms: Gym[] } | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', null, children),
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data: Gym[];
    renderItem: (item: { item: Gym }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      ListHeaderComponent,
      data.map((item) => createElement('div', { key: item.uuid }, renderItem({ item }))),
      ListFooterComponent,
    ),
}));

vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => routerMock }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { gym?: string }) => {
      const map: Record<string, string> = {
        'mobile.myGyms.screenTitle': 'My gyms',
        'mobile.myGyms.loadError': 'We could not load your gyms',
        'mobile.myGyms.retry': 'Try again',
        'mobile.myGyms.emptyTitle': 'No gyms yet',
        'mobile.myGyms.emptyBody': 'Claim your gym',
        'mobile.myGyms.findGym': 'Find your gym',
        'mobile.myGyms.kioskHint': 'Kiosk setup lives on the big screen',
        'mobile.myGyms.kioskHintDismiss': 'Got it',
        'mobile.myGyms.manageKiosks': 'Manage kiosks & TVs',
        'mobile.myGyms.manageError': 'Could not open the manage console',
        'mobile.myGyms.manageUnavailable': 'This gym is not set up for kiosks yet',
        'mobile.myGyms.noAddress': 'No address yet',
        'mobile.myGyms.roleOwner': 'Owner',
        'gymReporting.title': 'Gym analytics',
      };
      if (key === 'mobile.myGyms.manageKiosksFor') return `Manage ${opts?.gym ?? ''}`;
      if (key === 'gymReporting.openForGym') return `Open analytics for ${opts?.gym ?? ''}`;
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isLoading: false, isAuthenticated: !!state.profileId }),
}));
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: state.profileId, isLoading: false }),
}));
vi.mock('../../../src/hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false }),
}));
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useManagedMyGyms: () => ({
    ...state.myGyms,
    data: state.myGyms.data ? { pages: [state.myGyms.data] } : undefined,
    refetch,
    fetchNextPage,
    hasNextPage: state.hasNextPage,
  }),
}));

vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#f7f7f7',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      separator: '#ccc',
      fill: '#eee',
    },
    brandColors: { primary: '#6D28D9', onPrimary: '#fff' },
  }),
}));

vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => toastMock }));
vi.mock('../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../src/settings', () => ({
  useSetting: () => [state.kioskHintSeen, setKioskHintSeen],
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/open-external-link', () => openUrl);
vi.mock('../../../src/lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
vi.mock('../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32 },
  borderRadius: { lg: 12, full: 9999 },
}));
vi.mock('../../../src/theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#8e8e93' } }));

vi.mock('../../../src/components/StatusPill', () => ({
  StatusPill: ({ label }: { label: string }) => createElement('span', null, label),
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, type: 'button' }, children),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));

import MyGymsScreen from '../mine';

function makeGym(overrides: Partial<Gym>): Gym {
  return {
    uuid: 'g1',
    slug: 'movement',
    ownerId: 'owner-1',
    name: 'Movement',
    address: '1 Crag St',
    canEdit: true,
    myRole: null,
    ...overrides,
  } as unknown as Gym;
}

beforeEach(() => {
  routerMock.push.mockClear();
  toastMock.showToast.mockClear();
  openUrl.openValidatedUrl.mockClear();
  openUrl.openValidatedUrl.mockResolvedValue(true);
  setKioskHintSeen.mockClear();
  refetch.mockClear();
  fetchNextPage.mockClear();
  state.hasNextPage = false;
  state.profileId = 'owner-1';
  state.kioskHintSeen = false;
  state.myGyms = { data: undefined, isLoading: false, isError: false };
});

describe('MyGymsScreen', () => {
  it('shows a spinner while gyms load', () => {
    state.myGyms = { data: undefined, isLoading: true, isError: false };
    const { getByTestId } = render(<MyGymsScreen />);
    expect(getByTestId('spinner')).toBeTruthy();
  });

  it('shows the error state and retries on tap', () => {
    state.myGyms = { data: undefined, isLoading: false, isError: true };
    const { getByText } = render(<MyGymsScreen />);
    expect(getByText('We could not load your gyms')).toBeTruthy();
    fireEvent.click(getByText('Try again'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and routes to the wall finder', () => {
    state.myGyms = { data: { gyms: [] }, isLoading: false, isError: false };
    const { getByText } = render(<MyGymsScreen />);
    expect(getByText('No gyms yet')).toBeTruthy();
    fireEvent.click(getByText('Find your gym'));
    expect(routerMock.push).toHaveBeenCalledWith('/gyms');
  });

  it("lists gyms and opens the gym's page when a row is tapped", () => {
    state.myGyms = { data: { gyms: [makeGym({})] }, isLoading: false, isError: false };
    const { getByRole } = render(<MyGymsScreen />);
    fireEvent.click(getByRole('button', { name: 'Movement' }));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/gyms/[gym]', params: { gym: 'g1' } });
  });

  it('opens the pushed analytics route and loads another page on request', () => {
    state.myGyms = { data: { gyms: [makeGym({})] }, isLoading: false, isError: false };
    state.hasNextPage = true;
    const { getByRole } = render(<MyGymsScreen />);
    fireEvent.click(getByRole('button', { name: 'Open analytics for Movement' }));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/gyms/analytics', params: { gymUuid: 'g1' } });
    fireEvent.click(getByRole('button', { name: 'gymReporting.moreGyms' }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('withholds the Analytics and kiosk actions from a non-editor', () => {
    state.myGyms = { data: { gyms: [makeGym({ canEdit: false })] }, isLoading: false, isError: false };
    const { getByText, queryByRole } = render(<MyGymsScreen />);
    expect(getByText('Movement')).toBeTruthy();
    expect(queryByRole('button', { name: 'Open analytics for Movement' })).toBeNull();
    expect(queryByRole('button', { name: 'Manage Movement' })).toBeNull();
  });

  it('hands off to the web manage console and dismisses the kiosk hint', () => {
    state.myGyms = { data: { gyms: [makeGym({})] }, isLoading: false, isError: false };
    const { getByRole } = render(<MyGymsScreen />);
    fireEvent.click(getByRole('button', { name: 'Manage Movement' }));
    expect(openUrl.openValidatedUrl).toHaveBeenCalledWith(
      'https://www.boardsesh.com/gym/movement/manage',
      expect.any(Function),
    );
    expect(setKioskHintSeen).toHaveBeenCalledWith(true);
  });

  it('falls back to the gym uuid when the slug is null', () => {
    state.myGyms = { data: { gyms: [makeGym({ slug: null })] }, isLoading: false, isError: false };
    const { getByRole } = render(<MyGymsScreen />);
    fireEvent.click(getByRole('button', { name: 'Manage Movement' }));
    // The web manage route resolves a uuid too, so a slugless gym still opens.
    expect(openUrl.openValidatedUrl).toHaveBeenCalledWith(
      'https://www.boardsesh.com/gym/g1/manage',
      expect.any(Function),
    );
  });

  it('toasts a "not set up yet" message when a gym has neither slug nor uuid', () => {
    state.myGyms = { data: { gyms: [makeGym({ slug: null, uuid: '' })] }, isLoading: false, isError: false };
    const { getByRole } = render(<MyGymsScreen />);
    fireEvent.click(getByRole('button', { name: 'Manage Movement' }));
    expect(openUrl.openValidatedUrl).not.toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledWith('This gym is not set up for kiosks yet', 'error');
  });

  it('toasts when the manage console fails to open', async () => {
    openUrl.openValidatedUrl.mockResolvedValue(false);
    state.myGyms = { data: { gyms: [makeGym({})] }, isLoading: false, isError: false };
    const { getByRole } = render(<MyGymsScreen />);
    fireEvent.click(getByRole('button', { name: 'Manage Movement' }));
    await waitFor(() => expect(toastMock.showToast).toHaveBeenCalledWith('Could not open the manage console', 'error'));
  });

  it('renders the kiosk hint the first time and dismisses it', () => {
    state.myGyms = { data: { gyms: [makeGym({})] }, isLoading: false, isError: false };
    const { getByText, getByRole } = render(<MyGymsScreen />);
    expect(getByText('Kiosk setup lives on the big screen')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Got it' }));
    expect(setKioskHintSeen).toHaveBeenCalledWith(true);
  });

  it('hides the kiosk hint once it has been seen', () => {
    state.kioskHintSeen = true;
    state.myGyms = { data: { gyms: [makeGym({})] }, isLoading: false, isError: false };
    const { queryByText } = render(<MyGymsScreen />);
    expect(queryByText('Kiosk setup lives on the big screen')).toBeNull();
  });
});
