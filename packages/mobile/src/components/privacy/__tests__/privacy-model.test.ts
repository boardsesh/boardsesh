import { describe, expect, it, vi } from 'vitest';
import type { PrivacySettings } from '@boardsesh/graphql/operations/privacy';
import {
  buildPrivacyModel,
  displayedPrivacyValues,
  followRequestBadge,
  type PrivacyModelInput,
} from '../privacy-model';
import type { MoreRow } from '../../MoreForm.types';

const SERVER: PrivacySettings = {
  isPrivate: false,
  privacyRevision: 3,
  defaultSessionAudience: 'public',
  anonymousOnForeignBoards: false,
  enabled: true,
};

function makeInput(overrides: Partial<PrivacyModelInput> = {}): PrivacyModelInput {
  return {
    // Echo the key, plus any interpolation, so a test can assert which string was chosen.
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
    signedIn: true,
    settings: SERVER,
    settingsLoading: false,
    settingsLoadFailed: false,
    offline: false,
    saveFailed: false,
    writePending: false,
    pendingUpdate: undefined,
    pendingAnonymous: undefined,
    confirming: {},
    pendingRequestCount: 0,
    analytics: { preference: true, regionDefault: false },
    sessionRecording: { value: false, disabled: false },
    onRetry: vi.fn(),
    onPrivateAccountChange: vi.fn(),
    onSessionAudienceSelect: vi.fn(),
    onAnonymousOnForeignBoardsChange: vi.fn(),
    onOpenFollowRequests: vi.fn(),
    onOpenFollowers: vi.fn(),
    onReviewBoards: vi.fn(),
    onAnalyticsChange: vi.fn(),
    onSessionRecordingChange: vi.fn(),
    onOpenPrivacyPolicy: vi.fn(),
    ...overrides,
  };
}

const sectionKeys = (input: PrivacyModelInput) => buildPrivacyModel(input).sections.map((section) => section.key);
const rowKeys = (input: PrivacyModelInput) =>
  buildPrivacyModel(input).sections.flatMap((section) => section.rows.map((row) => row.key));

function findRow<TKind extends MoreRow['kind']>(
  input: PrivacyModelInput,
  key: string,
  kind: TKind,
): Extract<MoreRow, { kind: TKind }> {
  const row = buildPrivacyModel(input)
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row || row.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return row as Extract<MoreRow, { kind: TKind }>;
}

describe('buildPrivacyModel — which sections show', () => {
  it('signed out: only analytics and the policy, never a spinner', () => {
    const input = makeInput({ signedIn: false, settings: undefined, settingsLoading: true, offline: true });
    expect(sectionKeys(input)).toEqual(['analytics', 'policy']);
    expect(rowKeys(input)).toEqual(['analytics', 'sessionRecording', 'privacyPolicy']);
  });

  it('signed in and loading: a busy status row ahead of the local controls', () => {
    const input = makeInput({ settings: undefined, settingsLoading: true });
    expect(sectionKeys(input)).toEqual(['status', 'analytics', 'policy']);
    expect(findRow(input, 'loading', 'value').busy).toBe(true);
  });

  it('signed in and the read failed: says so and offers a retry', () => {
    const onRetry = vi.fn();
    const input = makeInput({ settings: undefined, settingsLoadFailed: true, onRetry });
    expect(rowKeys(input).slice(0, 2)).toEqual(['loadFailed', 'retry']);
    findRow(input, 'retry', 'button').onPress();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps a saved read on screen when a refetch fails', () => {
    expect(sectionKeys(makeInput({ settingsLoadFailed: true }))).not.toContain('status');
  });

  it('server controls off: a note instead of the account switch, and the anonymity switch still works', () => {
    const input = makeInput({ settings: { ...SERVER, enabled: false } });
    expect(sectionKeys(input)).toEqual(['account', 'boards', 'analytics', 'policy']);
    expect(findRow(input, 'accountControlsLater', 'info').body).toBe('settings:privacy.accountControlsLater');
    expect(rowKeys(input)).not.toContain('privateAccount');
    expect(findRow(input, 'anonymousOnForeignBoards', 'toggle').disabled).toBe(false);
  });

  it('server controls on: the whole page, in six groups', () => {
    expect(
      buildPrivacyModel(makeInput()).sections.map((section) => [section.key, section.rows.map((row) => row.key)]),
    ).toEqual([
      ['account', ['privateAccount']],
      ['people', ['followers']],
      ['sessionDefault', ['sessionDefault']],
      ['boards', ['anonymousOnForeignBoards', 'reviewBoards']],
      ['analytics', ['analytics', 'sessionRecording']],
      ['policy', ['privacyPolicy']],
    ]);
  });

  it('never offers export, which lives on Account', () => {
    expect(rowKeys(makeInput())).not.toContain('exportData');
    expect(rowKeys(makeInput({ signedIn: false }))).not.toContain('exportData');
  });

  it('keeps each board explanation next to its own row', () => {
    const boards = buildPrivacyModel(makeInput()).sections.find((section) => section.key === 'boards');
    expect(findRow(makeInput(), 'anonymousOnForeignBoards', 'toggle').subtitle).toBe(
      'settings:privacy.anonymousOnForeignBoardsDescription',
    );
    expect(boards?.footer).toBe('settings:privacy.boardReview');
    // Without the server's controls there is no review row, so no line about it.
    const withoutReview = buildPrivacyModel(makeInput({ settings: { ...SERVER, enabled: false } })).sections.find(
      (section) => section.key === 'boards',
    );
    expect(withoutReview?.rows.map((row) => row.key)).toEqual(['anonymousOnForeignBoards']);
    expect(withoutReview?.footer).toBeUndefined();
  });

  it('opens the policy outside the app', () => {
    const policy = findRow(makeInput({ signedIn: false }), 'privacyPolicy', 'nav');
    expect(policy.external).toBe(true);
    expect(policy.icon).toBe('policy');
  });

  it('adds offline and save-failed notes to the status section', () => {
    const input = makeInput({ offline: true, saveFailed: true });
    expect(buildPrivacyModel(input).sections[0].rows.map((row) => row.key)).toEqual(['offline', 'saveFailed']);
  });
});

describe('buildPrivacyModel — what each row shows', () => {
  it('prefers a pending confirm, then the in-flight write, then the server', () => {
    const settings = { ...SERVER, isPrivate: true, defaultSessionAudience: 'followers' as const };
    expect(
      displayedPrivacyValues({ settings, confirming: {}, pendingUpdate: undefined, pendingAnonymous: undefined }),
    ).toEqual({ isPrivate: true, sessionAudience: 'followers', anonymousOnForeignBoards: false });
    expect(
      displayedPrivacyValues({
        settings,
        confirming: {},
        pendingUpdate: { isPrivate: false, defaultSessionAudience: 'public' },
        pendingAnonymous: true,
      }),
    ).toEqual({ isPrivate: false, sessionAudience: 'public', anonymousOnForeignBoards: true });
    expect(
      displayedPrivacyValues({
        settings,
        confirming: { isPrivate: false, sessionAudience: 'invite_only' },
        pendingUpdate: { isPrivate: true, defaultSessionAudience: 'followers' },
        pendingAnonymous: undefined,
      }),
    ).toEqual({ isPrivate: false, sessionAudience: 'invite_only', anonymousOnForeignBoards: false });
  });

  it('a session-default write leaves the account switch on the server value', () => {
    const input = makeInput({
      settings: { ...SERVER, isPrivate: true, defaultSessionAudience: 'followers' },
      writePending: true,
      pendingUpdate: { defaultSessionAudience: 'invite_only' },
    });
    expect(findRow(input, 'privateAccount', 'toggle').value).toBe(true);
    expect(findRow(input, 'sessionDefault', 'select').selectedKey).toBe('invite_only');
  });

  it.each([
    ['a write is pending', { writePending: true }],
    ['the phone is offline', { offline: true }],
  ])('locks every writing row while %s', (_reason, overrides) => {
    const input = makeInput(overrides);
    expect(findRow(input, 'privateAccount', 'toggle').disabled).toBe(true);
    expect(findRow(input, 'sessionDefault', 'select').disabled).toBe(true);
    expect(findRow(input, 'anonymousOnForeignBoards', 'toggle').disabled).toBe(true);
    // Consent is local, so it never waits on the server.
    expect(findRow(input, 'analytics', 'toggle').disabled).toBeUndefined();
  });

  it('leaves every writing row open when nothing is in flight', () => {
    const input = makeInput();
    expect(findRow(input, 'privateAccount', 'toggle').disabled).toBe(false);
    expect(findRow(input, 'sessionDefault', 'select').disabled).toBe(false);
    expect(findRow(input, 'anonymousOnForeignBoards', 'toggle').disabled).toBe(false);
  });

  it('offers only the defaults the server accepts, plus a saved one outside them', () => {
    const optionKeys = (input: PrivacyModelInput) =>
      findRow(input, 'sessionDefault', 'select').options.map((option) => option.key);
    expect(optionKeys(makeInput())).toEqual(['public', 'followers', 'invite_only']);
    expect(optionKeys(makeInput({ settings: { ...SERVER, defaultSessionAudience: 'only_me' } }))).toEqual([
      'public',
      'followers',
      'invite_only',
      'only_me',
    ]);
  });
});

describe('buildPrivacyModel — follow requests', () => {
  it('hides the requests row on a public account with nothing waiting', () => {
    expect(rowKeys(makeInput())).not.toContain('followRequests');
    expect(rowKeys(makeInput())).toContain('followers');
  });

  it('shows the row on a private account, with no badge at zero', () => {
    const input = makeInput({ settings: { ...SERVER, isPrivate: true } });
    expect(findRow(input, 'followRequests', 'nav').badge).toBeUndefined();
  });

  it('shows waiting requests on a public account too', () => {
    expect(findRow(makeInput({ pendingRequestCount: 3 }), 'followRequests', 'nav').badge).toBe('3');
  });

  it('caps the badge', () => {
    expect(followRequestBadge(0)).toBeUndefined();
    expect(followRequestBadge(-1)).toBeUndefined();
    expect(followRequestBadge(1)).toBe('1');
    expect(followRequestBadge(99)).toBe('99');
    expect(followRequestBadge(100)).toBe('99+');
  });
});

describe('buildPrivacyModel — analytics', () => {
  it('puts the long copy in the footer, with the region note first when it applies', () => {
    const footer = (input: PrivacyModelInput) =>
      buildPrivacyModel(input).sections.find((section) => section.key === 'analytics')?.footer;
    expect(footer(makeInput())).toBe('consent:settingsBody');
    expect(footer(makeInput({ analytics: { preference: true, regionDefault: true } }))).toBe(
      'consent:regionDefaultNote consent:settingsBody',
    );
    expect(findRow(makeInput(), 'analytics', 'toggle').label).toBe('consent:analyticsLabel');
  });

  it('says on the recording switch itself what it records and when to use it', () => {
    const recording = findRow(makeInput(), 'sessionRecording', 'toggle');
    expect(recording.label).toBe('common:mobile.settings.diagnostics.recording');
    expect(recording.subtitle).toBe('common:mobile.settings.diagnostics.recordingDescription');
  });

  it('locks recording without consent', () => {
    const recording = findRow(
      makeInput({ sessionRecording: { value: false, disabled: true } }),
      'sessionRecording',
      'toggle',
    );
    expect(recording.disabled).toBe(true);
    expect(recording.value).toBe(false);
  });
});
