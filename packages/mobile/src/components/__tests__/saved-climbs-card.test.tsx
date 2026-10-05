// @vitest-environment jsdom
//
// The Climbs "saved climbs" card (#6002). The copy is the en-US catalog itself,
// so a renamed or missing key fails here instead of rendering a raw key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import playlistsCatalog from '@boardsesh/i18n/locales/en-US/playlists.json';

type Children = { children?: ReactNode };
type StoreState = { noticeShows: number; cardDismissedAt: number | null };

const trackMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const storeCtrl = vi.hoisted(() => ({
  state: { noticeShows: 0, cardDismissedAt: null } as StoreState | null,
  dismiss: vi.fn(async () => undefined),
  ensureLoaded: vi.fn(),
}));
const flagsCtrl = vi.hoisted(() => ({ enabled: true, resolved: true }));
const savedCtrl = vi.hoisted(() => ({ hasSaved: true, asked: vi.fn() }));
const deviceCtrl = vi.hoisted(() => ({ device: { connectedAt: null } as { connectedAt: number | null } | null }));
const profileCtrl = vi.hoisted(() => ({ userId: 'user-1' }));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({ router: { push: pushMock } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          playlistsCatalog,
        );
      return typeof found === 'string' ? found : key;
    },
  }),
}));
vi.mock('../Text', () => ({
  Text: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children),
}));
vi.mock('../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../lib/clock', () => ({ nowMs: () => 42 }));
vi.mock('../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: { id: profileCtrl.userId } }) }));
vi.mock('../../lib/onboarding/first-connect-store', () => ({
  getFirstConnectSnapshot: () => ({ device: deviceCtrl.device }),
}));
vi.mock('../../lib/save-next-session/save-next-session-store', () => ({
  ensureSaveNextSessionLoaded: storeCtrl.ensureLoaded,
  dismissSavedClimbsCard: storeCtrl.dismiss,
  useSaveNextSessionSelector: <Selected,>(select: (current: StoreState | null) => Selected) => select(storeCtrl.state),
}));
vi.mock('../../lib/save-next-session/use-has-saved-climbs-on-board', () => ({
  useHasSavedClimbsOnBoard: (options: { userId: string | null; boardType: string | null }) => {
    savedCtrl.asked(options);
    return savedCtrl.hasSaved;
  },
}));
vi.mock('../../lib/smart-playlists', () => ({
  smartPlaylistHref: (type: string, source: string) => ({
    pathname: '/(tabs)/discover/smart/[type]',
    params: { type, source },
  }),
}));
vi.mock('../../providers/feature-flags-provider', () => ({
  useSaveNextSessionEnabled: () => flagsCtrl.enabled,
  useFeatureFlagsResolved: () => flagsCtrl.resolved,
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { secondaryLabel: '#666', secondaryBackground: '#eee' },
    brandColors: { primary: '#6D28D9' },
    m3SurfaceContainers: { high: '#ddd' },
  }),
}));
vi.mock('../../theme/tokens', () => ({ borderRadius: { lg: 12 }, spacing: { 1: 4, 2: 8, 3: 12 } }));

const { SavedClimbsCard, resetSavedClimbsCardForTests } = await import('../SavedClimbsCard');

function renderCard(props: { boardType?: string | null; suppressed?: boolean } = {}) {
  return render(<SavedClimbsCard boardType={props.boardType ?? 'kilter'} suppressed={props.suppressed ?? false} />);
}

describe('SavedClimbsCard', () => {
  beforeEach(() => {
    storeCtrl.state = { noticeShows: 0, cardDismissedAt: null };
    storeCtrl.dismiss.mockClear();
    storeCtrl.ensureLoaded.mockClear();
    flagsCtrl.enabled = true;
    flagsCtrl.resolved = true;
    savedCtrl.hasSaved = true;
    savedCtrl.asked.mockClear();
    deviceCtrl.device = { connectedAt: null };
    profileCtrl.userId = 'user-1';
    trackMock.mockClear();
    pushMock.mockClear();
    resetSavedClimbsCardForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it('offers the way back to hearted climbs, with no count', () => {
    const { container } = renderCard();

    expect(screen.getByRole('heading').textContent).toBe('Pick up your saved climbs');
    expect(screen.getByText('Everything you hearted is waiting in Liked Climbs.')).toBeTruthy();
    expect(screen.getByText('See saved climbs')).toBeTruthy();
    expect(screen.getByLabelText('Dismiss')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d/);
  });

  it('asks about the active board, not every board', () => {
    renderCard({ boardType: 'tension' });

    expect(savedCtrl.asked).toHaveBeenCalledWith({ userId: 'user-1', boardType: 'tension' });
  });

  it('logs that it showed once per launch, however often the header remounts', () => {
    renderCard();
    cleanup();
    renderCard();

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Saved Climbs Card Shown', {
      board_type: 'kilter',
      phone_has_connected: false,
    });
  });

  it('logs it again for a second account signed in on the same launch', () => {
    renderCard();
    cleanup();

    // Sign-out and sign-in as someone else, without restarting the app.
    profileCtrl.userId = 'user-2';
    renderCard();
    cleanup();
    renderCard();

    expect(trackMock).toHaveBeenCalledTimes(2);

    // The first climber coming back on this launch was already counted.
    cleanup();
    profileCtrl.userId = 'user-1';
    renderCard();

    expect(trackMock).toHaveBeenCalledTimes(2);
  });

  it('renders nothing, and logs nothing, when the board has no liked climb', () => {
    savedCtrl.hasSaved = false;
    const { container } = renderCard();

    expect(container.textContent).toBe('');
    expect(trackMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the kill switch on', () => (flagsCtrl.enabled = false)],
    ['flags still resolving', () => (flagsCtrl.resolved = false)],
    ['the X already tapped on this phone', () => (storeCtrl.state = { noticeShows: 0, cardDismissedAt: 7 })],
    ['the dismissal not read yet', () => (storeCtrl.state = null)],
  ])('renders nothing and sends no request with %s', (_label, arrange) => {
    arrange();
    const { container } = renderCard();

    expect(container.textContent).toBe('');
    expect(savedCtrl.asked).not.toHaveBeenCalled();
  });

  it('waits while another card or tip has the slot', () => {
    const { container } = renderCard({ suppressed: true });

    expect(container.textContent).toBe('');
    expect(savedCtrl.asked).not.toHaveBeenCalled();
  });

  it('renders nothing with no active board', () => {
    const { container } = render(<SavedClimbsCard boardType={null} suppressed={false} />);

    expect(container.textContent).toBe('');
    expect(savedCtrl.asked).not.toHaveBeenCalled();
  });

  it('opens the liked list, tagged as coming from the card', () => {
    renderCard();

    fireEvent.click(screen.getByText('See saved climbs'));

    expect(trackMock).toHaveBeenCalledWith('Saved Climbs Card Action', { action: 'open', board_type: 'kilter' });
    expect(pushMock).toHaveBeenCalledWith(
      {
        pathname: '/(tabs)/discover/smart/[type]',
        params: { type: 'LIKED_CLIMBS', source: 'saved_card' },
      },
      // The Discover library loads underneath when that tab was never opened.
      { withAnchor: true },
    );
    expect(storeCtrl.dismiss).not.toHaveBeenCalled();
  });

  it('records the X on the phone', () => {
    renderCard();

    fireEvent.click(screen.getByLabelText('Dismiss'));

    expect(trackMock).toHaveBeenCalledWith('Saved Climbs Card Action', { action: 'dismiss', board_type: 'kilter' });
    expect(storeCtrl.dismiss).toHaveBeenCalledWith(42);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
