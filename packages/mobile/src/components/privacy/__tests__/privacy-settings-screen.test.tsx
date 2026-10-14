// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacySettings, UpdatePrivacySettingsInput } from '@boardsesh/graphql/operations/privacy';
import type { MoreFormModel, MoreRow } from '../../MoreForm.types';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T = boolean>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** What `refetch()` resolves to: the fields the screen reads from a query result. */
type SettingsRead = { status: 'success' | 'error'; data: PrivacySettings | undefined; dataUpdatedAt: number };
const freshRead = (data: PrivacySettings): SettingsRead => ({ status: 'success', data, dataUpdatedAt: Date.now() });
type MutateCallbacks = { onSuccess?: () => void; onSettled?: () => void };

const state = vi.hoisted(() => ({
  model: null as MoreFormModel | null,
  signedIn: true,
  offline: false,
  viewerId: 'viewer' as string | undefined,
  credentialGeneration: 1,
  platform: 'ios',
  profile: { isLoading: false, isError: false, refetch: vi.fn() },
  settings: {
    data: undefined as PrivacySettings | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  update: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    variables: undefined as UpdatePrivacySettingsInput | undefined,
  },
  anonymous: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    variables: undefined as boolean | undefined,
  },
  confirm: vi.fn(),
  decideConsent: vi.fn(),
  track: vi.fn(),
  announce: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    state.model = model;
    return null;
  },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: (message: string) => state.announce(message) },
  Platform: {
    get OS() {
      return state.platform;
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/routing/scoped-navigation', () => ({
  scopedRouter: { push: (href: unknown) => state.push(href) },
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.signedIn }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => state.confirm }));
vi.mock('../../../providers/consent-provider', () => ({
  decideAnalyticsConsent: (choice: string, source: string) => state.decideConsent(choice, source),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline }),
}));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => state.credentialGeneration,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.credentialGeneration,
}));
vi.mock('../../../lib/consent-hooks', () => ({
  useAnalyticsPreference: () => true,
  useAnalyticsRegionDefault: () => false,
}));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({
  track: (event: string, properties: unknown) => state.track(event, properties),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ ...state.profile, data: state.viewerId ? { id: state.viewerId } : undefined }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => state.settings,
  useUpdatePrivacySettings: () => state.update,
  useSetAnonymousOnForeignBoards: () => state.anonymous,
  useIncomingFollowRequests: () => ({ data: [] }),
}));
vi.mock('../../settings/use-session-recording-toggle', () => ({
  useSessionRecordingToggle: () => ({ value: false, disabled: true, onValueChange: vi.fn() }),
}));

import { PrivacySettingsScreen } from '../PrivacySettingsScreen';

const SERVER: PrivacySettings = {
  isPrivate: false,
  privacyRevision: 0,
  defaultSessionAudience: 'public',
  anonymousOnForeignBoards: false,
  enabled: true,
};

function row<TKind extends MoreRow['kind']>(key: string, kind: TKind): Extract<MoreRow, { kind: TKind }> {
  const found = state.model?.sections.flatMap((section) => section.rows).find((candidate) => candidate.key === key);
  if (!found || found.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return found as Extract<MoreRow, { kind: TKind }>;
}
const hasRow = (key: string) =>
  state.model?.sections.some((section) => section.rows.some((candidate) => candidate.key === key)) ?? false;
const settingChangedEvents = () => state.track.mock.calls.filter(([event]) => event === 'Setting Changed');

const renderScreen = () => render(createElement(PrivacySettingsScreen));

beforeEach(() => {
  state.model = null;
  state.signedIn = true;
  state.offline = false;
  state.viewerId = 'viewer';
  state.credentialGeneration = 1;
  state.platform = 'ios';
  state.profile = { isLoading: false, isError: false, refetch: vi.fn() };
  state.settings = {
    data: { ...SERVER },
    isLoading: false,
    isError: false,
    // The fresh read before an account switch finds what the cache already has.
    refetch: vi.fn(() => Promise.resolve(freshRead(state.settings.data ?? SERVER))),
  };
  state.update = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, variables: undefined };
  state.anonymous = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, variables: undefined };
  state.confirm = vi.fn();
  state.decideConsent = vi.fn(() => Promise.resolve());
  state.track = vi.fn();
  state.announce = vi.fn();
  state.push = vi.fn();
});
afterEach(cleanup);

describe('Privacy page — signed out', () => {
  it('shows analytics and the policy instead of spinning on a query that never runs', () => {
    state.signedIn = false;
    state.viewerId = undefined;
    state.settings = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
    renderScreen();
    expect(state.model?.sections.map((section) => section.key)).toEqual(['analytics', 'policy']);
    expect(hasRow('loading')).toBe(false);
  });
});

describe('Stay anonymous on boards I do not own', () => {
  it('saves while the server account controls are off, and the account switch is replaced by a note', () => {
    state.settings.data = { ...SERVER, enabled: false };
    renderScreen();
    expect(hasRow('accountControlsLater')).toBe(true);
    expect(hasRow('privateAccount')).toBe(false);
    expect(hasRow('followRequests')).toBe(false);
    act(() => row('anonymousOnForeignBoards', 'toggle').onValueChange(true));
    expect(state.anonymous.mutate).toHaveBeenCalledExactlyOnceWith(true, expect.anything());
    expect(settingChangedEvents()).toEqual([
      ['Setting Changed', { page: 'privacy', key: 'anonymousOnForeignBoards', value: true }],
    ]);
  });

  it('shows the pending choice while it saves and locks every writing row', () => {
    state.anonymous = { ...state.anonymous, isPending: true, variables: true };
    renderScreen();
    expect(row('anonymousOnForeignBoards', 'toggle').value).toBe(true);
    expect(row('anonymousOnForeignBoards', 'toggle').disabled).toBe(true);
    expect(row('privateAccount', 'toggle').disabled).toBe(true);
    expect(row('sessionDefault', 'select').disabled).toBe(true);
  });

  it('ignores a change while an account write is pending', () => {
    state.update.isPending = true;
    renderScreen();
    act(() => row('anonymousOnForeignBoards', 'toggle').onValueChange(true));
    expect(state.anonymous.mutate).not.toHaveBeenCalled();
  });

  it('cannot change offline, and says so (out loud too) when a save fails', () => {
    state.offline = true;
    state.anonymous = { ...state.anonymous, isError: true };
    renderScreen();
    expect(row('anonymousOnForeignBoards', 'toggle').disabled).toBe(true);
    expect(hasRow('offline')).toBe(true);
    expect(hasRow('saveFailed')).toBe(true);
    expect(state.announce).toHaveBeenCalledWith('privacy.saveFailed');
  });
});

/** The callbacks the screen passed with its last `updatePrivacySettings` write. */
const lastUpdateCallbacks = (): MutateCallbacks => state.update.mutate.mock.calls.at(-1)?.[1] as MutateCallbacks;

describe('Private account switch', () => {
  it('goes private at once, narrowing a public session default to followers', async () => {
    renderScreen();
    await act(async () => row('privateAccount', 'toggle').onValueChange(true));
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.update.mutate).toHaveBeenCalledExactlyOnceWith(
      { isPrivate: true, defaultSessionAudience: 'followers' },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
    // Held at the new value until the write settles.
    expect(row('privateAccount', 'toggle').value).toBe(true);
  });

  it('counts the change only once the write lands', async () => {
    renderScreen();
    await act(async () => row('privateAccount', 'toggle').onValueChange(true));
    expect(settingChangedEvents()).toEqual([]);
    act(() => lastUpdateCallbacks().onSuccess?.());
    expect(settingChangedEvents()).toEqual([
      ['Setting Changed', { page: 'privacy', key: 'privateAccount', value: true }],
    ]);
  });

  it('does not count a write that failed', async () => {
    renderScreen();
    await act(async () => row('privateAccount', 'toggle').onValueChange(true));
    act(() => lastUpdateCallbacks().onSettled?.());
    expect(settingChangedEvents()).toEqual([]);
  });

  it('asks before going public; a cancel moves the switch back and writes nothing', async () => {
    state.settings.data = { ...SERVER, isPrivate: true, defaultSessionAudience: 'followers' };
    const answer = deferred();
    state.confirm.mockReturnValue(answer.promise);
    renderScreen();
    act(() => row('privateAccount', 'toggle').onValueChange(false));
    expect(row('privateAccount', 'toggle').value).toBe(false);
    await act(async () => answer.resolve(false));
    expect(row('privateAccount', 'toggle').value).toBe(true);
    expect(state.settings.refetch).not.toHaveBeenCalled();
    expect(state.update.mutate).not.toHaveBeenCalled();
    expect(settingChangedEvents()).toEqual([]);
  });

  it('says new sessions open to Public when going public will reopen the followers default', async () => {
    state.settings.data = { ...SERVER, isPrivate: true, defaultSessionAudience: 'followers' };
    state.confirm.mockResolvedValue(true);
    renderScreen();
    await act(async () => row('privateAccount', 'toggle').onValueChange(false));
    expect(state.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: 'settings:privacy.makeAccountPublicTitle',
        message: 'settings:privacy.makeAccountPublicMessage settings:privacy.makeAccountPublicSessionsNote',
      }),
    );
    expect(state.update.mutate).toHaveBeenCalledExactlyOnceWith(
      { isPrivate: false, defaultSessionAudience: 'public' },
      expect.anything(),
    );
  });

  it('leaves the note out, and the default alone, when going public keeps a narrower default', async () => {
    state.settings.data = { ...SERVER, isPrivate: true, defaultSessionAudience: 'invite_only' };
    state.confirm.mockResolvedValue(true);
    renderScreen();
    await act(async () => row('privateAccount', 'toggle').onValueChange(false));
    expect(state.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'settings:privacy.makeAccountPublicMessage' }),
    );
    expect(state.update.mutate).toHaveBeenCalledExactlyOnceWith({ isPrivate: false }, expect.anything());
  });

  it('drops a confirmed answer when another climber signed in behind the dialog', async () => {
    state.settings.data = { ...SERVER, isPrivate: true };
    const answer = deferred();
    state.confirm.mockReturnValue(answer.promise);
    const view = renderScreen();
    act(() => row('privateAccount', 'toggle').onValueChange(false));
    state.viewerId = 'replacement-viewer';
    state.credentialGeneration += 1;
    view.rerender(createElement(PrivacySettingsScreen));
    await act(async () => answer.resolve(true));
    expect(state.update.mutate).not.toHaveBeenCalled();
  });
});

describe('Private account switch reads the server before it writes', () => {
  it('builds the write from the fresh settings, not the cached ones, and locks the rows while it reads', async () => {
    // The cache says Public; another phone has since narrowed the default to invited people.
    const read = deferred<SettingsRead>();
    state.settings.refetch = vi.fn(() => read.promise);
    renderScreen();
    act(() => row('privateAccount', 'toggle').onValueChange(true));
    expect(state.settings.refetch).toHaveBeenCalledOnce();
    expect(state.update.mutate).not.toHaveBeenCalled();
    expect(row('privateAccount', 'toggle').value).toBe(true);
    expect(row('anonymousOnForeignBoards', 'toggle').disabled).toBe(true);
    expect(row('sessionDefault', 'select').disabled).toBe(true);
    await act(async () => read.resolve(freshRead({ ...SERVER, defaultSessionAudience: 'invite_only' })));
    // The cached Public would have sent `followers`, widening invite_only again.
    expect(state.update.mutate).toHaveBeenCalledExactlyOnceWith({ isPrivate: true }, expect.anything());
    expect(state.settings.refetch.mock.invocationCallOrder[0]).toBeLessThan(
      state.update.mutate.mock.invocationCallOrder[0],
    );
  });

  it('reads after the confirm, so the answer is checked against what is saved then', async () => {
    state.settings.data = { ...SERVER, isPrivate: true, defaultSessionAudience: 'invite_only' };
    const answer = deferred();
    state.confirm.mockReturnValue(answer.promise);
    state.settings.refetch = vi.fn(() =>
      Promise.resolve(freshRead({ ...SERVER, isPrivate: true, defaultSessionAudience: 'followers' })),
    );
    renderScreen();
    act(() => row('privateAccount', 'toggle').onValueChange(false));
    expect(state.settings.refetch).not.toHaveBeenCalled();
    await act(async () => answer.resolve(true));
    expect(state.confirm.mock.invocationCallOrder[0]).toBeLessThan(state.settings.refetch.mock.invocationCallOrder[0]);
    // The confirm never said new sessions would open, so the followers default stays.
    expect(state.update.mutate).toHaveBeenCalledExactlyOnceWith({ isPrivate: false }, expect.anything());
  });

  it('writes nothing, says the save failed and moves the switch back when the read fails', async () => {
    state.settings.refetch = vi.fn(() =>
      Promise.resolve({ status: 'error', data: { ...SERVER }, dataUpdatedAt: 0 } satisfies SettingsRead),
    );
    renderScreen();
    await act(async () => row('privateAccount', 'toggle').onValueChange(true));
    expect(state.update.mutate).not.toHaveBeenCalled();
    expect(row('privateAccount', 'toggle').value).toBe(false);
    expect(hasRow('saveFailed')).toBe(true);
    expect(state.announce).toHaveBeenCalledWith('privacy.saveFailed');
    expect(row('anonymousOnForeignBoards', 'toggle').disabled).toBe(false);
  });

  it('writes nothing when another phone already made the same change', async () => {
    state.settings.refetch = vi.fn(() => Promise.resolve(freshRead({ ...SERVER, isPrivate: true })));
    renderScreen();
    await act(async () => row('privateAccount', 'toggle').onValueChange(true));
    expect(state.update.mutate).not.toHaveBeenCalled();
    expect(hasRow('saveFailed')).toBe(false);
  });

  it('drops the write when another climber signed in during the read', async () => {
    const read = deferred<SettingsRead>();
    state.settings.refetch = vi.fn(() => read.promise);
    const view = renderScreen();
    act(() => row('privateAccount', 'toggle').onValueChange(true));
    state.viewerId = 'replacement-viewer';
    view.rerender(createElement(PrivacySettingsScreen));
    await act(async () => read.resolve(freshRead({ ...SERVER })));
    expect(state.update.mutate).not.toHaveBeenCalled();
  });
});

describe('New session audience select', () => {
  it('a cancelled confirm moves the select back, so the native picker resyncs', async () => {
    state.settings.data = { ...SERVER, isPrivate: true, defaultSessionAudience: 'followers' };
    const answer = deferred();
    state.confirm.mockReturnValue(answer.promise);
    renderScreen();
    expect(row('sessionDefault', 'select').selectedKey).toBe('followers');
    act(() => row('sessionDefault', 'select').onSelect('public'));
    // Drawn as chosen while the dialog is up: the picker already shows it.
    expect(row('sessionDefault', 'select').selectedKey).toBe('public');
    await act(async () => answer.resolve(false));
    expect(row('sessionDefault', 'select').selectedKey).toBe('followers');
    expect(state.update.mutate).not.toHaveBeenCalled();
    expect(settingChangedEvents()).toEqual([]);
  });

  it('writes the default alone once confirmed, and counts it once the write lands', async () => {
    state.settings.data = { ...SERVER, isPrivate: true, defaultSessionAudience: 'followers' };
    state.confirm.mockResolvedValue(true);
    renderScreen();
    await act(async () => row('sessionDefault', 'select').onSelect('public'));
    expect(state.update.mutate).toHaveBeenCalledExactlyOnceWith(
      { defaultSessionAudience: 'public' },
      expect.anything(),
    );
    // The account switch is never re-sent with the default.
    expect(state.update.mutate.mock.calls[0]?.[0]).not.toHaveProperty('isPrivate');
    expect(settingChangedEvents()).toEqual([]);
    act(() => lastUpdateCallbacks().onSuccess?.());
    expect(settingChangedEvents()).toEqual([
      ['Setting Changed', { page: 'privacy', key: 'sessionDefault', value: 'public' }],
    ]);
  });

  it('narrowing never asks, and a failed write is not counted', () => {
    renderScreen();
    act(() => row('sessionDefault', 'select').onSelect('invite_only'));
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.settings.refetch).not.toHaveBeenCalled();
    expect(state.update.mutate).toHaveBeenCalledExactlyOnceWith(
      { defaultSessionAudience: 'invite_only' },
      expect.anything(),
    );
    act(() => lastUpdateCallbacks().onSettled?.());
    expect(settingChangedEvents()).toEqual([]);
  });

  it('holds the choice until the write settles, then shows what the server has', () => {
    let settle!: () => void;
    state.update.mutate.mockImplementation((_input: unknown, callbacks: { onSettled: () => void }) => {
      settle = callbacks.onSettled;
    });
    renderScreen();
    act(() => row('sessionDefault', 'select').onSelect('invite_only'));
    // A write that fails at once may never be seen pending, so the hold carries it.
    expect(row('sessionDefault', 'select').selectedKey).toBe('invite_only');
    act(() => settle());
    // The server still says public (the write failed): the picker moves back.
    expect(row('sessionDefault', 'select').selectedKey).toBe('public');
  });

  it('refuses a default the server would reject', () => {
    renderScreen();
    act(() => row('sessionDefault', 'select').onSelect('unlisted'));
    expect(state.update.mutate).not.toHaveBeenCalled();
  });
});

describe('Save status', () => {
  it('a new write clears an earlier failure, and a second failure is announced again', () => {
    state.update = { ...state.update, isError: true };
    const view = renderScreen();
    expect(hasRow('saveFailed')).toBe(true);
    expect(state.announce).toHaveBeenCalledTimes(1);

    act(() => row('anonymousOnForeignBoards', 'toggle').onValueChange(true));
    expect(state.update.reset).toHaveBeenCalled();
    expect(state.anonymous.reset).toHaveBeenCalled();
    expect(state.update.reset.mock.invocationCallOrder[0]).toBeLessThan(
      state.anonymous.mutate.mock.invocationCallOrder[0],
    );
    // What the hooks report once reset: the new write in flight, the old error gone.
    state.update = { ...state.update, isError: false };
    state.anonymous = { ...state.anonymous, isPending: true, variables: true };
    view.rerender(createElement(PrivacySettingsScreen));
    expect(hasRow('saveFailed')).toBe(false);

    state.anonymous = { ...state.anonymous, isPending: false, isError: true, variables: undefined };
    view.rerender(createElement(PrivacySettingsScreen));
    expect(hasRow('saveFailed')).toBe(true);
    expect(state.announce).toHaveBeenCalledTimes(2);
  });

  it('a session-default write clears a failed anonymity write first', () => {
    state.anonymous = { ...state.anonymous, isError: true };
    renderScreen();
    act(() => row('sessionDefault', 'select').onSelect('invite_only'));
    expect(state.anonymous.reset).toHaveBeenCalled();
    expect(state.anonymous.reset.mock.invocationCallOrder[0]).toBeLessThan(
      state.update.mutate.mock.invocationCallOrder[0],
    );
  });
});

describe('Loading the page', () => {
  it('says the settings failed to load, and Retry reads them again', () => {
    state.settings = { ...state.settings, data: undefined, isError: true };
    renderScreen();
    expect(hasRow('loadFailed')).toBe(true);
    act(() => row('retry', 'button').onPress());
    expect(state.settings.refetch).toHaveBeenCalledOnce();
    expect(state.profile.refetch).not.toHaveBeenCalled();
  });

  it('says so when the profile read failed (the settings read never starts), and Retry reads the profile', () => {
    state.viewerId = undefined;
    state.profile = { ...state.profile, isError: true };
    // Disabled without a viewer: neither loading nor failed on its own.
    state.settings = { ...state.settings, data: undefined, isLoading: false, isError: false };
    renderScreen();
    expect(hasRow('loadFailed')).toBe(true);
    expect(hasRow('loading')).toBe(false);
    act(() => row('retry', 'button').onPress());
    expect(state.profile.refetch).toHaveBeenCalledOnce();
    // Without a viewer there is no account to read settings for; the recovered profile starts it.
    expect(state.settings.refetch).not.toHaveBeenCalled();
  });

  it('retries both reads when both failed', () => {
    state.profile = { ...state.profile, isError: true };
    state.settings = { ...state.settings, data: undefined, isError: true };
    renderScreen();
    act(() => row('retry', 'button').onPress());
    expect(state.profile.refetch).toHaveBeenCalledOnce();
    expect(state.settings.refetch).toHaveBeenCalledOnce();
  });
});

describe('Analytics switch', () => {
  it.each([
    ['ios', 'ios'],
    ['android', 'android'],
    ['web', 'web'],
  ])('records the choice for %s as %s, and never reports it as a setting change', (platform, source) => {
    state.platform = platform;
    renderScreen();
    act(() => row('analytics', 'toggle').onValueChange(false));
    act(() => row('analytics', 'toggle').onValueChange(true));
    expect(state.decideConsent.mock.calls).toEqual([
      ['denied', source],
      ['granted', source],
    ]);
    expect(settingChangedEvents()).toEqual([]);
  });
});

describe('People rows', () => {
  it('open the people page in the right mode', () => {
    state.settings.data = { ...SERVER, isPrivate: true };
    renderScreen();
    row('followRequests', 'nav').onPress();
    row('followers', 'nav').onPress();
    expect(state.push.mock.calls).toEqual([
      [{ pathname: '/settings/privacy-people', params: { mode: 'request' } }],
      [{ pathname: '/settings/privacy-people', params: { mode: 'follower' } }],
    ]);
  });
});
