import { describe, expect, it } from 'vitest';
import type { PrivacyResourceAudience } from '@boardsesh/graphql/operations/privacy';
import {
  accountSwitchConfirmation,
  accountSwitchPayload,
  accountSwitchReopensSessions,
  audienceConfirmation,
  sessionAudienceConfirmation,
} from '../privacy-settings-changes';

const t = (key: string) => key;

describe('accountSwitchPayload', () => {
  it.each<[boolean, PrivacyResourceAudience, PrivacyResourceAudience | undefined]>([
    // Going private narrows anything wider than approved followers...
    [true, 'public', 'followers'],
    [true, 'unlisted', 'followers'],
    // ...and never widens a narrower choice (invite_only used to become followers),
    // so those leave the default out of the write.
    [true, 'followers', undefined],
    [true, 'invite_only', undefined],
    [true, 'only_me', undefined],
    // Going public reopens the followers default only.
    [false, 'followers', 'public'],
    [false, 'public', undefined],
    [false, 'invite_only', undefined],
    [false, 'only_me', undefined],
  ])('isPrivate=%s with a %s default sends %s', (nextIsPrivate, current, expected) => {
    const payload = accountSwitchPayload(nextIsPrivate, current);
    expect(payload).toEqual(
      expected === undefined
        ? { isPrivate: nextIsPrivate }
        : { isPrivate: nextIsPrivate, defaultSessionAudience: expected },
    );
    // An unchanged default is left out, not sent as `undefined`.
    expect('defaultSessionAudience' in payload).toBe(expected !== undefined);
  });

  it('keeps a followers default when the climber was not told it would open', () => {
    expect(accountSwitchPayload(false, 'followers', { reopenSessions: false })).toEqual({ isPrivate: false });
    // Narrowing on the way to private does not depend on it.
    expect(accountSwitchPayload(true, 'public', { reopenSessions: false })).toEqual({
      isPrivate: true,
      defaultSessionAudience: 'followers',
    });
  });
});

describe('accountSwitchReopensSessions', () => {
  it('is true only when going public from a followers default', () => {
    expect(accountSwitchReopensSessions(false, 'followers')).toBe(true);
    expect(accountSwitchReopensSessions(false, 'invite_only')).toBe(false);
    expect(accountSwitchReopensSessions(false, 'public')).toBe(false);
    expect(accountSwitchReopensSessions(true, 'followers')).toBe(false);
  });
});

describe('accountSwitchConfirmation', () => {
  it('never asks before going private', () => {
    expect(accountSwitchConfirmation(true, 'public', t)).toBeNull();
    expect(accountSwitchConfirmation(true, 'followers', t)).toBeNull();
  });

  it('asks before going public, and says new sessions open when the followers default will', () => {
    expect(accountSwitchConfirmation(false, 'followers', t)).toEqual({
      title: 'settings:privacy.makeAccountPublicTitle',
      message: 'settings:privacy.makeAccountPublicMessage settings:privacy.makeAccountPublicSessionsNote',
      confirmLabel: 'settings:privacy.publishPublic',
      cancelLabel: 'settings:privacy.cancel',
    });
  });

  it('leaves the sessions note out when the default stays as it is', () => {
    for (const current of ['invite_only', 'only_me', 'public'] as const) {
      expect(accountSwitchConfirmation(false, current, t)).toEqual({
        title: 'settings:privacy.makeAccountPublicTitle',
        message: 'settings:privacy.makeAccountPublicMessage',
        confirmLabel: 'settings:privacy.publishPublic',
        cancelLabel: 'settings:privacy.cancel',
      });
    }
  });
});

describe('sessionAudienceConfirmation', () => {
  it.each<[PrivacyResourceAudience, PrivacyResourceAudience, boolean, string | null]>([
    // A private account widening its default is asked first.
    ['public', 'followers', true, 'settings:privacy.publishPublicTitle'],
    ['unlisted', 'followers', true, 'settings:privacy.publishLinkTitle'],
    ['public', 'invite_only', true, 'settings:privacy.publishPublicTitle'],
    // Narrowing, or staying put, never asks.
    ['followers', 'public', true, null],
    ['invite_only', 'public', true, null],
    ['public', 'public', true, null],
    // A public account has nothing to protect by asking.
    ['public', 'followers', false, null],
    ['unlisted', 'followers', false, null],
  ])('%s from %s (private=%s) asks %s', (next, current, isPrivate, expectedTitle) => {
    expect(sessionAudienceConfirmation(next, current, isPrivate, t)?.title ?? null).toBe(expectedTitle);
  });

  it('uses the session/board wording for Public', () => {
    expect(sessionAudienceConfirmation('public', 'followers', true, t)).toEqual({
      title: 'settings:privacy.publishPublicTitle',
      message: 'settings:privacy.publishResourceMessage',
      confirmLabel: 'settings:privacy.publishPublic',
      cancelLabel: 'settings:privacy.cancel',
    });
  });
});

describe('audienceConfirmation', () => {
  it('asks again for the current value only when a stale consent needs renewing', () => {
    const base = { next: 'public' as const, current: 'public' as const, confirmPublic: true, t };
    expect(audienceConfirmation(base)).toBeNull();
    expect(audienceConfirmation({ ...base, reconfirmPublic: true })?.message).toBe(
      'settings:privacy.publishPublicMessage',
    );
  });
});
