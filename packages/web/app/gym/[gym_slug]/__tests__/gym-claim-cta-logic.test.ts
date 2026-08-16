import { describe, it, expect } from 'vite-plus/test';
import {
  CLAIM_PARAM,
  CLAIM_PARAM_VALUE,
  buildClaimReturnPath,
  resolveClaimCtaVariant,
  shouldAutoOpenClaimDialog,
} from '../gym-claim-cta-logic';

describe('resolveClaimCtaVariant', () => {
  it('offers the claim to a signed-in viewer the backend says may claim', () => {
    expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: true })).toBe('signed-in');
  });

  it('hides the call-out from a signed-in viewer who already covers the gym', () => {
    // Owners, gym admins/editors and covering community leaders all come back
    // `canClaim: false` from the resolver — the gating this PR must not widen.
    expect(resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: true })).toBe('hidden');
  });

  it('shows the anonymous arm to a visitor with no session', () => {
    // The whole point: `canClaim` is false for every anonymous request, so
    // reading it alone would hide the CTA from the gym owner who just googled
    // their own gym.
    expect(resolveClaimCtaVariant({ serverCanClaim: false, serverHasSession: false })).toBe('signed-out');
  });

  it('still takes the anonymous arm if canClaim ever arrives without a session', () => {
    // Unreachable through the resolver, but with no session there is no
    // signed-in viewer whose dialog could be opened.
    expect(resolveClaimCtaVariant({ serverCanClaim: true, serverHasSession: false })).toBe('signed-out');
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
