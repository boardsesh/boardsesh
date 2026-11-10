import { describe, expect, it } from 'vitest';
import { PARTNER_CONSENT_ERRORS, PARTNER_OAUTH_ISSUER } from '../partner-oauth';

describe('partner OAuth constants', () => {
  it('names the issuer the backend serves and the www pages return to', () => {
    expect(PARTNER_OAUTH_ISSUER).toBe('https://api.boardsesh.com/api/auth');
  });

  it('gives each consent refusal its own code', () => {
    const codes = Object.values(PARTNER_CONSENT_ERRORS);
    expect(new Set(codes).size).toBe(codes.length);
    expect(PARTNER_CONSENT_ERRORS).toMatchObject({ linkSpent: 'link_spent', appSuspended: 'app_suspended' });
  });
});
