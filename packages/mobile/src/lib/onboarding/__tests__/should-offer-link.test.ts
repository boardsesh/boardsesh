import { describe, it, expect } from 'vitest';
import { shouldOfferLink, type ShouldOfferLinkInput } from '../should-offer-link';

const base: ShouldOfferLinkInput = {
  enabled: true,
  boardType: 'tension',
  isOffline: false,
  answered: false,
  hasLinkedAccount: false,
};

describe('shouldOfferLink', () => {
  it('offers the step to a climber who just bound a linkable board and has no account linked', () => {
    expect(shouldOfferLink(base)).toBe('show');
  });

  // A positive rollout flag, so the async-unresolved default is "no extra step".
  it('does nothing when the flag is off', () => {
    expect(shouldOfferLink({ ...base, enabled: false })).toBe('none');
  });

  // MoonBoard uses the separate file-import flow.
  it('never offers a link for MoonBoard, which cannot be linked', () => {
    expect(shouldOfferLink({ ...base, boardType: 'moonboard' })).toBe('none');
  });

  it('never offers a link when no board type came through', () => {
    expect(shouldOfferLink({ ...base, boardType: undefined })).toBe('none');
  });

  // Offline skips the optional form without writing an answer.
  it('skips the step offline rather than burning the question on a screen that cannot work', () => {
    expect(shouldOfferLink({ ...base, isOffline: true })).toBe('none');
  });

  it('waits while the answered marker is still being read', () => {
    expect(shouldOfferLink({ ...base, answered: undefined })).toBe('wait');
  });

  it('does not ask again once answered', () => {
    expect(shouldOfferLink({ ...base, answered: true })).toBe('none');
  });

  it('does not ask a climber who already linked an account', () => {
    expect(shouldOfferLink({ ...base, hasLinkedAccount: true })).toBe('none');
  });

  // Unresolved credentials never mean the account is unlinked.
  it('waits — never shows — while the credential read is unresolved', () => {
    expect(shouldOfferLink({ ...base, hasLinkedAccount: undefined })).toBe('wait');
  });

  // Cheap certain `none`s must beat the async `wait`s, so a climber who will never
  // see the step never blocks on a network read to find that out.
  it('rules itself out on the cheap checks before waiting on anything async', () => {
    const unresolvedAsync = { answered: undefined, hasLinkedAccount: undefined } as const;
    expect(shouldOfferLink({ ...base, ...unresolvedAsync, enabled: false })).toBe('none');
    expect(shouldOfferLink({ ...base, ...unresolvedAsync, boardType: 'moonboard' })).toBe('none');
    expect(shouldOfferLink({ ...base, ...unresolvedAsync, isOffline: true })).toBe('none');
  });
});
