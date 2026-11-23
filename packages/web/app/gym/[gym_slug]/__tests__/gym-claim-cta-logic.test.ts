import { describe, it, expect } from 'vite-plus/test';
import {
  CLAIM_PARAM,
  CLAIM_PARAM_VALUE,
  buildClaimReturnPath,
  gymListingStateOf,
  resolveClaimCtaVariant,
  resolveClaimSurface,
  shouldAutoOpenClaimDialog,
} from '../gym-claim-cta-logic';

describe('resolveClaimCtaVariant', () => {
  describe('signed in', () => {
    it.each(['UNCLAIMED', 'CLIMBER_LISTED'] as const)(
      'offers the claim to a viewer the backend says may claim a %s gym',
      (listingState) => {
        expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: true, listingState })).toBe(
          'signed-in',
        );
      },
    );

    it.each(['UNCLAIMED', 'CLIMBER_LISTED'] as const)(
      'hides it from a viewer who already covers a %s gym',
      (listingState) => {
        // Owners, gym admins/editors and covering community leaders all come back
        // `canClaim: false` from the resolver.
        expect(resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: true, listingState })).toBe('hidden');
      },
    );
  });

  describe('signed out', () => {
    it('shows the anonymous arm on a gym nobody has claimed', () => {
      // `canClaim` is false for every anonymous request, so reading it alone
      // would hide the CTA from the gym owner who just googled their own gym.
      expect(
        resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: false, listingState: 'UNCLAIMED' }),
      ).toBe('signed-out');
    });

    it('shows it on a gym a climber added too: the staff still have to claim that one', () => {
      // Before listingState this gym read as claimed and the anonymous arm hid.
      expect(
        resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: false, listingState: 'CLIMBER_LISTED' }),
      ).toBe('signed-out');
    });

    it('still takes the anonymous arm if canClaim ever arrives without a session', () => {
      expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: false, listingState: 'UNCLAIMED' })).toBe(
        'signed-out',
      );
    });
  });

  describe('run by the gym', () => {
    it.each([
      [true, true],
      [false, true],
      [false, false],
      [true, false],
    ])('hides the claim for everyone (canClaim %s, session %s)', (serverCanClaim, serverHasSession) => {
      // Its staff are named on the page; a dispute is a report to our team.
      expect(resolveClaimCtaVariant({ serverCanClaim, serverHasSession, listingState: 'RUN_BY_GYM' })).toBe('hidden');
    });
  });
});

describe('gymListingStateOf', () => {
  it('reads the server answer when there is one', () => {
    expect(gymListingStateOf({ listingState: 'CLIMBER_LISTED', isClaimed: true })).toBe('CLIMBER_LISTED');
  });

  it('falls back to the two-state reading for a backend without it, erring on run by the gym', () => {
    expect(gymListingStateOf({ listingState: null, isClaimed: true })).toBe('RUN_BY_GYM');
    expect(gymListingStateOf({ isClaimed: false })).toBe('UNCLAIMED');
  });
});

describe('resolveClaimSurface', () => {
  it('swaps the call-out for the review notice once the viewer has a claim in flight', () => {
    // `canClaim` stays true while a claim sits in the queue, so without this the
    // claimant is invited to submit the same claim again, forever.
    expect(resolveClaimSurface({ variant: 'signed-in', gymIsPublic: true, hasPendingClaim: true })).toEqual({
      kind: 'pending',
    });
  });

  it('shows the call-out to a signed-in viewer with no claim of their own', () => {
    expect(resolveClaimSurface({ variant: 'signed-in', gymIsPublic: true, hasPendingClaim: false })).toEqual({
      kind: 'cta',
      viewerState: 'signed-in',
    });
  });

  it('keeps the anonymous arm a call-out — a signed-out viewer has no claim to be pending', () => {
    expect(resolveClaimSurface({ variant: 'signed-out', gymIsPublic: true, hasPendingClaim: true })).toEqual({
      kind: 'cta',
      viewerState: 'signed-out',
    });
  });

  it.each([true, false])('renders nothing for a viewer who already covers the gym (pending: %s)', (hasPendingClaim) => {
    // They were granted access while the claim sat in the queue: a "under
    // review" notice above a gym they can already edit is stale.
    expect(resolveClaimSurface({ variant: 'hidden', gymIsPublic: true, hasPendingClaim })).toEqual({ kind: 'none' });
  });

  it('renders nothing on a private gym, which the backend refuses to let anyone claim', () => {
    expect(resolveClaimSurface({ variant: 'signed-in', gymIsPublic: false, hasPendingClaim: false })).toEqual({
      kind: 'none',
    });
  });
});

describe('shouldAutoOpenClaimDialog', () => {
  it('auto-opens for the exact scalar claim value', () => {
    expect(shouldAutoOpenClaimDialog(CLAIM_PARAM_VALUE)).toBe(true);
  });

  it('does not auto-open for a repeated param, which Next hands over as an array', () => {
    expect(shouldAutoOpenClaimDialog(['1', '1'])).toBe(false);
  });

  it.each([undefined, '0', 'true', ''])('does not auto-open for %o', (rawParam) => {
    expect(shouldAutoOpenClaimDialog(rawParam)).toBe(false);
  });
});

describe('buildClaimReturnPath', () => {
  it('returns to the same gym page with the claim intent intact', () => {
    expect(buildClaimReturnPath('boulderwelt-ost')).toBe('/gym/boulderwelt-ost?claim=1');
  });

  it('builds the path from the same constants the reader parses', () => {
    expect(buildClaimReturnPath('x')).toBe(`/gym/x?${CLAIM_PARAM}=${CLAIM_PARAM_VALUE}`);
  });
});
