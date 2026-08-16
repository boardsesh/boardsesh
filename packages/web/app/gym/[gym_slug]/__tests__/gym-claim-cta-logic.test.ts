import { describe, it, expect } from 'vite-plus/test';
import {
  CLAIM_PARAM,
  CLAIM_PARAM_VALUE,
  buildClaimReturnPath,
  resolveClaimCtaVariant,
  shouldAutoOpenClaimDialog,
} from '../gym-claim-cta-logic';

describe('resolveClaimCtaVariant', () => {
  describe('signed in', () => {
    it('offers the claim to a viewer the backend says may claim an unclaimed gym', () => {
      expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: true, gymIsClaimed: false })).toBe(
        'signed-in',
      );
    });

    it('still offers it on a gym someone else already owns', () => {
      // A signed-in non-member asking for a claimed gym is a deliberate path —
      // the backend routes it to admin review. `isClaimed` narrows the
      // anonymous arm only.
      expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: true, gymIsClaimed: true })).toBe(
        'signed-in',
      );
    });

    it.each([true, false])('hides it from a viewer who already covers the gym (claimed: %s)', (gymIsClaimed) => {
      // Owners, gym admins/editors and covering community leaders all come back
      // `canClaim: false` from the resolver — the gating this PR must not widen.
      expect(resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: true, gymIsClaimed })).toBe('hidden');
    });
  });

  describe('signed out', () => {
    it('shows the anonymous arm on an unclaimed gym', () => {
      // The whole point: `canClaim` is false for every anonymous request, so
      // reading it alone would hide the CTA from the gym owner who just googled
      // their own gym.
      expect(resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: false, gymIsClaimed: false })).toBe(
        'signed-out',
      );
    });

    it('hides the anonymous arm once the gym has a real owner', () => {
      // "Is this your gym?" directly under the displayed name of the person who
      // already runs it reads as a mistake.
      expect(resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: false, gymIsClaimed: true })).toBe(
        'hidden',
      );
    });

    it('still takes the anonymous arm if canClaim ever arrives without a session', () => {
      // Unreachable through the resolver, but with no session there is no
      // signed-in viewer whose dialog could be opened.
      expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: false, gymIsClaimed: false })).toBe(
        'signed-out',
      );
    });

    it('keeps the claimed gate ahead of that, too', () => {
      expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: false, gymIsClaimed: true })).toBe(
        'hidden',
      );
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
