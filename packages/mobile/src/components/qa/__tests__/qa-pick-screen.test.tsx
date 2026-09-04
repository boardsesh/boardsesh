// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Every native leaf is stood in for; what this suite is actually about is the
// screen's four states (loading / surfing-off / unreachable / rows) and the
// pick → surf handoff.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: { branch: string }[];
    renderItem: (info: { item: { branch: string } }) => ReactNode;
    keyExtractor: (item: { branch: string }) => string;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'pick-list' },
      data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    ),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

const routerMock = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const params = vi.hoisted(() => ({
  prNumbers: undefined as string | undefined,
  origin: 'launch' as string | undefined,
}));
vi.mock('expo-router', () => ({
  router: routerMock,
  useLocalSearchParams: () => params,
  Redirect: ({ href }: { href: string }) => createElement('div', { 'data-redirect': href }),
}));

vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div', { 'data-spinner': '1' }) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      groupedBackground: '#fff',
      elevatedSurface: '#fafafa',
      secondaryLabel: '#888',
      tertiaryLabel: '#aaa',
      separator: '#ccc',
    },
    brandColors: { primary: '#70f', onPrimary: '#fff', success: '#0a0', warning: '#fa0', error: '#a00' },
  }),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12, full: 9999 },
}));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => '2 hr ago' }));
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
const profileState = vi.hoisted(() => ({ isTester: true, isLoading: false }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'user-1', isTester: profileState.isTester }, isLoading: profileState.isLoading }),
}));

const qa = vi.hoisted(() => ({
  surfingAvailable: true,
  listPrBranches: vi.fn(),
  surfToPr: vi.fn(),
  refusedPrNumber: null as number | null,
}));
vi.mock('../../../lib/qa/qa-surf', () => ({
  qaSurfingAvailable: () => qa.surfingAvailable,
  listPrBranches: qa.listPrBranches,
  surfToPr: qa.surfToPr,
  readRefusedPrNumber: () => qa.refusedPrNumber,
}));

const previews = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('../../../lib/qa/use-qa-previews', () => ({ useQaPreviews: () => ({ data: previews.data }) }));

import { QaPickScreen } from '../QaPickScreen';

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <QaPickScreen />
    </QueryClientProvider>,
  );
}

const BRANCHES = [
  { prNumber: 4792, branch: 'pr-4792', lastUpdateAt: '2026-08-26T10:00:00.000Z' },
  { prNumber: 4800, branch: 'pr-4800', lastUpdateAt: '2026-08-26T09:00:00.000Z' },
];

beforeEach(() => {
  routerMock.back.mockClear();
  routerMock.push.mockClear();
  showToast.mockClear();
  trackMock.mockClear();
  params.prNumbers = undefined;
  params.origin = 'launch';
  profileState.isTester = true;
  profileState.isLoading = false;
  previews.data = [];
  qa.surfingAvailable = true;
  qa.refusedPrNumber = null;
  qa.listPrBranches.mockReset().mockResolvedValue(BRANCHES);
  qa.surfToPr.mockReset().mockResolvedValue('reloading');
});

describe('QaPickScreen', () => {
  it('renders a tappable row per loadable branch even with no PR metadata', async () => {
    // The branch list is the spine: GitHub being down must not cost a tester
    // the ability to load the branch.
    renderScreen();

    expect(await screen.findByText('pr-4792')).toBeTruthy();
    expect(screen.getByText('pr-4800')).toBeTruthy();
  });

  it('decorates a row with the PR title once the backend answers', async () => {
    previews.data = [
      {
        prNumber: 4792,
        branch: 'pr-4792',
        title: 'Ask testers to try a PR preview',
        url: 'https://github.com/boardsesh/boardsesh/pull/4792',
        author: 'marco',
        isDraft: false,
        headSha: 'sha',
        headCommittedAt: null,
        updatedAt: '2026-08-26T10:00:00.000Z',
        risk: 3,
        riskReason: null,
        testPlan: null,
        testPlanSteps: [],
        myLatestVerdict: null,
      },
    ];
    renderScreen();

    expect(await screen.findByText('Ask testers to try a PR preview')).toBeTruthy();
    expect(screen.getByText('3/5')).toBeTruthy();
  });

  it('surfs to the PR behind the row that was tapped', async () => {
    renderScreen();

    fireEvent.click(await screen.findByLabelText('#4792 pr-4792'));

    expect(qa.surfToPr).toHaveBeenCalledWith(4792);
    expect(trackMock).toHaveBeenCalledWith('QA Preview Picked', { prNumber: 4792, risk: null });
  });

  it('says so when the pin took but there was nothing new to load', async () => {
    qa.surfToPr.mockResolvedValue('nothing-to-load');
    renderScreen();

    fireEvent.click(await screen.findByLabelText('#4792 pr-4792'));

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Nothing new for #4792 on this build — its next publish applies on relaunch',
        'info',
      ),
    );
  });

  it('shows a placard, not an empty list, when surfing is off for this channel', async () => {
    qa.listPrBranches.mockResolvedValue(null);
    renderScreen();

    expect(await screen.findByText('Previews are switched off')).toBeTruthy();
  });

  it('shows the thrown reason when the update server cannot be reached', async () => {
    qa.listPrBranches.mockRejectedValue(new Error('Could not reach the update server (502).'));
    renderScreen();

    // The screen's own `retry: 1` outlives the 1s default here — a GitHub or
    // update-server blip is worth one retry before the placard appears.
    expect(await screen.findByText('Could not reach the update server', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Could not reach the update server (502).')).toBeTruthy();
  });

  it('takes only the first of two rapid picks', async () => {
    // Both taps land inside one React batch, so neither sees the other's render
    // — the disabled rows cannot help here and only the ref guard can. Two
    // `surfToPr` calls would race: competing header overrides, two reloads, and
    // a verdict filed against the PR the tester did not choose.
    renderScreen();
    const first = await screen.findByLabelText('#4792 pr-4792');
    const second = await screen.findByLabelText('#4800 pr-4800');

    await act(async () => {
      fireEvent.click(first);
      fireEvent.click(second);
    });

    expect(qa.surfToPr).toHaveBeenCalledTimes(1);
    expect(qa.surfToPr).toHaveBeenCalledWith(4792);
  });

  it('flattens every row while a surf is in flight', async () => {
    // The app is on its way to another bundle; a second choice cannot be
    // honoured, so offering one would be a lie.
    renderScreen();
    fireEvent.click(await screen.findByLabelText('#4792 pr-4792'));

    expect(screen.getByLabelText('#4800 pr-4800').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('#4792 pr-4792').hasAttribute('disabled')).toBe(true);
  });

  it('re-arms the rows when the surf throws', async () => {
    qa.surfToPr.mockRejectedValue(new Error('Could not reach the update server (502).'));
    renderScreen();
    fireEvent.click(await screen.findByLabelText('#4792 pr-4792'));

    await vi.waitFor(() => expect(screen.getByLabelText('#4800 pr-4800').hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByLabelText('#4800 pr-4800'));
    expect(qa.surfToPr).toHaveBeenCalledTimes(2);
  });

  it('records a skip when the tester leaves the launch prompt without choosing', async () => {
    const { unmount } = renderScreen();
    await screen.findByText('pr-4792');

    unmount();
    expect(trackMock).toHaveBeenCalledWith('QA Preview Skipped', {});
  });

  it('records no skip for the picker opened by hand from the drawer', async () => {
    // Same screen, no launch prompt behind it: counting this as a skipped prompt
    // inflated the denominator and made prompted → picked/skipped unreadable.
    params.origin = undefined;
    const { unmount } = renderScreen();
    await screen.findByText('pr-4792');

    unmount();
    expect(trackMock).not.toHaveBeenCalledWith('QA Preview Skipped', {});
  });

  it('lists the branches for a non-tester who opened it by hand', async () => {
    // The screen is open to everyone now; only the cold-start prompt is not.
    // Reaching it by hand is also not a skipped prompt.
    profileState.isTester = false;
    params.origin = undefined;
    const { unmount } = renderScreen();
    await screen.findByText('pr-4792');

    unmount();
    expect(trackMock).not.toHaveBeenCalledWith('QA Preview Skipped', {});
  });

  it('records no skip for a non-tester even when the launch param is present', async () => {
    // Only QaTesterGate sets origin=launch, and only for a tester — but that is
    // a convention, not a guarantee, now that anyone can reach this route. A
    // hand-made deep link must not inflate the skip half of the funnel.
    profileState.isTester = false;
    params.origin = 'launch';
    const { unmount } = renderScreen();
    await screen.findByText('pr-4792');

    unmount();
    expect(trackMock).not.toHaveBeenCalledWith('QA Preview Skipped', {});
  });

  it('does not record a skip when a pick is in flight', async () => {
    const { unmount } = renderScreen();
    fireEvent.click(await screen.findByLabelText('#4792 pr-4792'));

    unmount();
    expect(trackMock).not.toHaveBeenCalledWith('QA Preview Skipped', {});
  });

  it('disables every row on a build that cannot surf', async () => {
    qa.surfingAvailable = false;
    renderScreen();

    expect((await screen.findByLabelText('#4792 pr-4792')).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Surfing is unavailable in a dev build — the list is read-only here.')).toBeTruthy();
  });
});
