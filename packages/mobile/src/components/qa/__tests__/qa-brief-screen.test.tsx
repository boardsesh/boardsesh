// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

const routerMock = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({
  router: routerMock,
  Redirect: ({ href }: { href: string }) => createElement('div', { 'data-redirect': href }),
}));

vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div', { 'data-spinner': '1' }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled, 'data-button': title }, title),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { groupedBackground: '#fff', elevatedSurface: '#fafafa', secondaryLabel: '#888' },
    brandColors: { onPrimary: '#fff', success: '#0a0', warning: '#fa0', error: '#a00' },
  }),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12, full: 9999 },
}));
const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/open-url', () => ({ openExternalUrl }));
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
const profileState = vi.hoisted(() => ({ id: 'user-1' as string | undefined, isTester: true }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({
    data: profileState.id === undefined ? undefined : { id: profileState.id, isTester: profileState.isTester },
    isLoading: false,
  }),
}));

const presentQaVerdict = vi.hoisted(() => vi.fn());
vi.mock('../../user-drawer/UserDrawerProvider', () => ({ useUserDrawer: () => ({ presentQaVerdict }) }));

const qa = vi.hoisted(() => ({
  runningPrNumber: 4792 as number | null,
  surfingAvailable: true,
  surfToProduction: vi.fn(),
}));
vi.mock('../../../lib/qa/qa-surf', () => ({
  qaSurfingAvailable: () => qa.surfingAvailable,
  readRunningPrNumber: () => qa.runningPrNumber,
  surfToProduction: qa.surfToProduction,
}));

const previews = vi.hoisted(() => ({ data: [] as unknown[], isPending: false }));
vi.mock('../../../lib/qa/use-qa-previews', () => ({
  useQaPreviews: () => ({ data: previews.data, isPending: previews.isPending }),
}));

import { QaBriefScreen } from '../QaBriefScreen';

function preview(overrides: Record<string, unknown> = {}) {
  return {
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
    riskReason: 'Touches the launch path',
    testPlan: null,
    testPlanSteps: [],
    myLatestVerdict: null,
    ...overrides,
  };
}

beforeEach(() => {
  routerMock.back.mockClear();
  routerMock.replace.mockClear();
  showToast.mockClear();
  trackMock.mockClear();
  openExternalUrl.mockClear();
  presentQaVerdict.mockClear();
  previews.data = [preview()];
  previews.isPending = false;
  qa.runningPrNumber = 4792;
  qa.surfingAvailable = true;
  qa.surfToProduction.mockReset().mockResolvedValue('nothing-to-load');
  profileState.id = 'user-1';
  profileState.isTester = true;
});

describe('QaBriefScreen', () => {
  // The tester-only route guard is gone: anyone who surfed onto a pr-<n> bundle
  // can read what it is meant to do. A redirect here used to be the only way a
  // non-tester learned the screen existed at all.
  it('shows the brief to a non-tester instead of redirecting them out', () => {
    profileState.isTester = false;
    render(<QaBriefScreen />);

    expect(screen.getByText('What to test · #4792')).toBeTruthy();
  });

  it('still renders for a signed-out reader, minus the PR metadata', () => {
    // `qaPreviews` needs an account, so the query is skipped rather than sent to
    // be rejected — the screen falls back to the branch it can read locally.
    profileState.id = undefined;
    previews.data = [];
    render(<QaBriefScreen />);

    expect(screen.getByText('What to test · #4792')).toBeTruthy();
  });

  it('shows the PR and its numbered test plan', () => {
    previews.data = [preview({ testPlanSteps: ['Open the Climbs tab', 'Relaunch the app'] })];
    render(<QaBriefScreen />);

    expect(screen.getByText('Ask testers to try a PR preview')).toBeTruthy();
    expect(screen.getByText('What to test · #4792')).toBeTruthy();
    expect(screen.getByText('Open the Climbs tab')).toBeTruthy();
    expect(screen.getByText('Risk 3/5')).toBeTruthy();
  });

  it('keys plan steps by position, so a repeated step is still a valid list', () => {
    // "Relaunch the app" twice is a normal test plan. Keyed on the text, that is
    // two children with the same key: React shouts about it and its reconciler
    // stops being able to tell the rows apart on an update.
    previews.data = [preview({ testPlanSteps: ['Relaunch the app', 'Relaunch the app'] })];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<QaBriefScreen />);

    expect(screen.getAllByText('Relaunch the app')).toHaveLength(2);
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
    expect(consoleError.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('same key');
    consoleError.mockRestore();
  });

  it('degrades to a usable screen when the PR has no plan', () => {
    render(<QaBriefScreen />);

    expect(screen.getByText('No test plan on this PR yet — open it on GitHub and use your judgement.')).toBeTruthy();
    expect(screen.getByText('Open on GitHub')).toBeTruthy();
  });

  it('says so when the backend knows nothing about the running branch', () => {
    previews.data = [];
    render(<QaBriefScreen />);

    expect(screen.getByText('PR #4792 is closed or unknown. Nothing here to test.')).toBeTruthy();
  });

  it('opens the verdict sheet only after this modal route is gone', () => {
    // The sheet lives at the drawer provider's root and presents off the ROOT
    // view controller (#3211), so it can only present once this route's own
    // controller has been torn down.
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const { unmount } = render(<QaBriefScreen />);

    fireEvent.click(screen.getByText('Finish testing'));
    expect(routerMock.back).toHaveBeenCalled();
    expect(presentQaVerdict).not.toHaveBeenCalled();

    unmount();
    expect(presentQaVerdict).toHaveBeenCalledTimes(1);
    rafSpy.mockRestore();
  });

  it('clears the pin and says when nothing newer was there to load', async () => {
    render(<QaBriefScreen />);

    fireEvent.click(screen.getByText('Leave preview'));

    expect(trackMock).toHaveBeenCalledWith('QA Preview Left', { prNumber: 4792 });
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Back on production at the next update', 'info'));
  });

  it('blames the pin, not the verdict, when the surf back throws', async () => {
    qa.surfToProduction.mockRejectedValue(new Error('Could not reach the update server (502).'));
    render(<QaBriefScreen />);

    fireEvent.click(screen.getByText('Leave preview'));

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not switch off this preview — try again', 'error'),
    );
    expect(trackMock).toHaveBeenCalledWith('QA Surf Failed', {
      prNumber: null,
      reason: 'Could not reach the update server (502).',
    });
  });

  it('sends a tester on production to the picker instead', () => {
    qa.runningPrNumber = null;
    render(<QaBriefScreen />);

    expect(screen.getByText("You're on production")).toBeTruthy();
    fireEvent.click(screen.getByText('Test a PR preview'));
    expect(routerMock.replace).toHaveBeenCalledWith('/qa/pick');
  });

  it('disables leaving on a build that cannot surf', () => {
    qa.surfingAvailable = false;
    render(<QaBriefScreen />);

    expect((screen.getByText('Leave preview') as HTMLButtonElement).disabled).toBe(true);
  });
});
