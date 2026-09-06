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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolates `{{name}}` like the real `t`, so assertions on toasts and
    // labels match the string a tester actually reads.
    t: (key: string, values?: Record<string, unknown>) => {
      const template =
        {
          'qa.pick.title': 'Test a PR',
          'qa.pick.skip': 'Skip',
          'qa.pick.emptyTitle': 'Nothing to test right now',
          'qa.pick.emptyBody': 'No PR has published a preview for this build yet. Check back after the next push.',
          'qa.pick.surfingOffTitle': 'Previews are switched off',
          'qa.pick.surfingOffBody': 'This channel is not serving PR previews at the moment.',
          'qa.pick.unreachableTitle': 'Could not reach the update server',
          'qa.pick.draftChip': 'Draft',
          'qa.pick.approvedChip': 'You approved',
          'qa.pick.declinedChip': 'You declined',
          'qa.pick.headChangedChip': 'Head changed since',
          'qa.pick.crashedChip': 'Crashed on launch',
          'qa.pick.nothingNewToast':
            'Nothing new for #{{prNumber}} on this build — its next publish applies on relaunch',
          'qa.pick.buildingChip': 'Building',
          'qa.pick.buildingNewerChip': 'Building newer',
          'qa.pick.buildingToast': 'Still publishing — it appears here when the bundle lands',
          'qa.pick.buildingHint': 'This preview is still publishing and cannot be loaded yet',
          'qa.pick.searchPlaceholder': 'Search by title or number',
          'qa.pick.clearSearch': 'Clear search',
          'qa.pick.noMatchTitle': 'No PR matches that',
          'qa.pick.noMatchBody': 'Nothing published for this build matches “{{query}}”.',
          'qa.pick.trySurfAction': 'Try #{{prNumber}} anyway',
          'qa.pick.trySurfHint': 'It may not have a preview this build can load.',
          'qa.pick.notServableToast': 'No preview of #{{prNumber}} for this build — it may need a rebase onto main',
        }[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''));
    },
  }),
}));

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
vi.mock('../../SearchField', () => ({
  SearchField: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
  }) =>
    createElement('input', {
      value,
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
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
  useAppColorScheme: () => 'light',
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
const profileState = vi.hoisted(() => ({ id: 'user-1' as string | undefined, isTester: true, isLoading: false }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({
    data: profileState.id === undefined ? undefined : { id: profileState.id, isTester: profileState.isTester },
    isLoading: profileState.isLoading,
  }),
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

const previews = vi.hoisted(() => ({
  data: [] as unknown[],
  // Records `enabled` so a test can assert the metadata query is skipped rather
  // than fired at a resolver that can only reject it.
  lastOptions: undefined as { enabled?: boolean } | undefined,
}));
vi.mock('../../../lib/qa/use-qa-previews', () => ({
  useQaPreviews: (_prNumbers: number[], options?: { enabled?: boolean }) => {
    previews.lastOptions = options;
    return { data: previews.data };
  },
}));

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
  profileState.id = 'user-1';
  profileState.isTester = true;
  profileState.isLoading = false;
  previews.data = [];
  previews.lastOptions = undefined;
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

  it('shows a PR that is still building, and says why it cannot be loaded', async () => {
    // The row exists precisely because the branch list cannot know about it —
    // nothing is published yet. It must still be pressable: `disabled` would
    // kill onPress and with it the only explanation the tester gets.
    qa.listPrBranches.mockResolvedValue([]);
    previews.data = [
      {
        prNumber: 4901,
        branch: 'pr-4901',
        title: 'Publishing right now',
        url: 'https://github.com/boardsesh/boardsesh/pull/4901',
        author: 'marcodejongh',
        isDraft: false,
        headSha: 'abc',
        headCommittedAt: null,
        updatedAt: '2026-08-26T10:00:00.000Z',
        risk: 2,
        riskReason: null,
        testPlan: null,
        testPlanSteps: [],
        myLatestVerdict: null,
        labels: [],
        otaBuild: 'building',
      },
    ];

    renderScreen();
    const row = await screen.findByLabelText('#4901 Publishing right now');

    fireEvent.click(row);
    expect(qa.surfToPr).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Still publishing'), 'info');
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
    expect(trackMock).toHaveBeenCalledWith('QA Preview Picked', { prNumber: 4792, risk: null, source: 'list' });
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

  it('still lists branches signed out, without asking for metadata it cannot get', async () => {
    // The branch list is an unauthenticated device endpoint, so surfing works
    // with no account — only the PR titles need one. Rows fall back to bare
    // `pr-N` rather than the screen refusing to render.
    profileState.id = undefined;
    const { unmount } = renderScreen();
    await screen.findByText('pr-4792');

    // `includeBuilding` still rides along — it is a property of the screen, not
    // of the session — but `enabled: false` is what keeps the request unsent.
    expect(previews.lastOptions).toEqual({ enabled: false, includeBuilding: true });
    unmount();
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

describe('QaPickScreen search', () => {
  const TITLED_PREVIEWS = [
    {
      prNumber: 4792,
      branch: 'pr-4792',
      title: 'Fix the queue reducer',
      url: 'https://github.com/boardsesh/boardsesh/pull/4792',
      author: 'marcodejongh',
      isDraft: false,
      headSha: 'abc',
      headCommittedAt: null,
      updatedAt: '2026-08-26T10:00:00.000Z',
      risk: 2,
      riskReason: null,
      testPlan: null,
      testPlanSteps: [],
      myLatestVerdict: null,
      labels: [],
      otaBuild: 'ready',
    },
  ];

  async function search(text: string) {
    const field = await screen.findByPlaceholderText('Search by title or number');
    fireEvent.change(field, { target: { value: text } });
    return field;
  }

  it('filters the list by title', async () => {
    previews.data = TITLED_PREVIEWS;
    renderScreen();
    expect(await screen.findByText('Fix the queue reducer')).toBeTruthy();
    expect(screen.getByText('pr-4800')).toBeTruthy();

    await search('queue');

    expect(screen.getByText('Fix the queue reducer')).toBeTruthy();
    expect(screen.queryByText('pr-4800')).toBeNull();
  });

  it('filters the list by PR number, and clearing brings the rest back', async () => {
    renderScreen();
    await screen.findByText('pr-4792');

    const field = await search('479');
    expect(screen.getByText('pr-4792')).toBeTruthy();
    expect(screen.queryByText('pr-4800')).toBeNull();

    fireEvent.change(field, { target: { value: '' } });
    expect(screen.getByText('pr-4800')).toBeTruthy();
  });

  it('offers to load an unlisted PR when a number matches nothing', async () => {
    renderScreen();
    await screen.findByText('pr-4792');

    await search('9999');

    expect(screen.getByText('No PR matches that')).toBeTruthy();
    expect(screen.getByText('Try #9999 anyway')).toBeTruthy();
  });

  // There is no branch name to guess from a handful of words.
  it('offers nothing to load when the query is not a PR number', async () => {
    renderScreen();
    await screen.findByText('pr-4792');

    await search('zzz');

    expect(screen.getByText('No PR matches that')).toBeTruthy();
    expect(screen.queryByText(/anyway/)).toBeNull();
  });

  // An empty list is the signature of a fingerprint drift, which is exactly when
  // somebody hands a tester a PR number.
  it('offers the escape hatch even when nothing at all is published', async () => {
    qa.listPrBranches.mockResolvedValue([]);
    renderScreen();
    await screen.findByPlaceholderText('Search by title or number');

    await search('9999');

    expect(screen.getByText('Try #9999 anyway')).toBeTruthy();
    expect(screen.queryByText('Nothing to test right now')).toBeNull();
  });

  it('hides the escape hatch on a build that cannot surf, but keeps the field', async () => {
    qa.surfingAvailable = false;
    renderScreen();
    await search('9999');

    expect(screen.getByText('No PR matches that')).toBeTruthy();
    expect(screen.queryByText('Try #9999 anyway')).toBeNull();
  });

  it('re-asks the server first, and takes the ordinary path when the PR is now listed', async () => {
    // The 30s cache is the commonest honest reason a PR is missing, and that case
    // must never reach the speculative pin.
    qa.listPrBranches
      .mockResolvedValueOnce(BRANCHES)
      .mockResolvedValue([
        ...BRANCHES,
        { prNumber: 9999, branch: 'pr-9999', lastUpdateAt: '2026-08-26T11:00:00.000Z' },
      ]);
    renderScreen();
    await screen.findByText('pr-4792');
    await search('9999');

    await act(async () => {
      fireEvent.click(screen.getByText('Try #9999 anyway'));
    });

    expect(qa.surfToPr).toHaveBeenCalledWith(9999);
    expect(trackMock).toHaveBeenCalledWith('QA Preview Picked', { prNumber: 9999, risk: null, source: 'search' });
  });

  // The live branch list is authoritative, and an unrecognised branch does NOT make
  // the server answer "nothing available" — it serves the channel's own latest. So
  // pinning here would reload the tester onto production under this PR's name.
  it('never pins a PR the refreshed list still omits, and reports the miss', async () => {
    renderScreen();
    await screen.findByText('pr-4792');
    await search('9999');

    await act(async () => {
      fireEvent.click(screen.getByText('Try #9999 anyway'));
    });

    expect(qa.surfToPr).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'No preview of #9999 for this build — it may need a rebase onto main',
      'info',
    );
    expect(trackMock).toHaveBeenCalledWith('QA Unlisted Surf Missed', { prNumber: 9999, refetchFailed: false });
  });

  it('says so when the refreshed PR was already the running bundle', async () => {
    qa.listPrBranches
      .mockResolvedValueOnce(BRANCHES)
      .mockResolvedValue([
        ...BRANCHES,
        { prNumber: 9999, branch: 'pr-9999', lastUpdateAt: '2026-08-26T11:00:00.000Z' },
      ]);
    qa.surfToPr.mockResolvedValue('nothing-to-load');
    renderScreen();
    await screen.findByText('pr-4792');
    await search('9999');

    await act(async () => {
      fireEvent.click(screen.getByText('Try #9999 anyway'));
    });

    expect(showToast).toHaveBeenCalledWith(
      'Nothing new for #9999 on this build — its next publish applies on relaunch',
      'info',
    );
  });

  it('re-arms after a miss so an ordinary row is still pickable', async () => {
    qa.surfToPr.mockResolvedValue('nothing-to-load');
    renderScreen();
    await screen.findByText('pr-4792');

    const field = await search('9999');
    await act(async () => {
      fireEvent.click(screen.getByText('Try #9999 anyway'));
    });

    fireEvent.change(field, { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('#4792 pr-4792'));
    });

    expect(qa.surfToPr).toHaveBeenCalledWith(4792);
  });

  // Pinning after the server has switched surfing off would push the device into
  // exactly the state the server is switching off.
  it('never pins when surfing was switched off since the screen loaded', async () => {
    qa.listPrBranches.mockResolvedValueOnce(BRANCHES).mockResolvedValue(null);
    renderScreen();
    await screen.findByText('pr-4792');
    await search('9999');

    await act(async () => {
      fireEvent.click(screen.getByText('Try #9999 anyway'));
    });

    expect(qa.surfToPr).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Previews are switched off', 'info');
  });

  it('ignores a second tap while the first attempt is in flight', async () => {
    qa.listPrBranches
      .mockResolvedValueOnce(BRANCHES)
      .mockResolvedValue([
        ...BRANCHES,
        { prNumber: 9999, branch: 'pr-9999', lastUpdateAt: '2026-08-26T11:00:00.000Z' },
      ]);
    renderScreen();
    await screen.findByText('pr-4792');
    await search('9999');

    await act(async () => {
      const button = screen.getByText('Try #9999 anyway');
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(qa.surfToPr).toHaveBeenCalledTimes(1);
  });
});
