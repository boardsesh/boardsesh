import { describe, expect, it } from 'vite-plus/test';
import { isBoardInviteRequest, readBoardInviteToken, searchCarriesBoardInvite } from '../board-invite';
import { redactShareCapabilitiesFromEvent } from '../observability/redact-share-capabilities';
import { redactShareCapabilities } from '../share-capability';

const TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';

describe('readBoardInviteToken', () => {
  it('reads one well-formed token', () => {
    expect(readBoardInviteToken(TOKEN)).toBe(TOKEN);
  });

  it('refuses a repeated, malformed or missing one', () => {
    for (const value of [[TOKEN, TOKEN], 'short', `${TOKEN}0`, 'Ab3_dE-fGhIjKlMnOpQr/t', '', undefined, null]) {
      expect(readBoardInviteToken(value)).toBeUndefined();
    }
  });
});

describe('isBoardInviteRequest', () => {
  it('matches any /b/ request carrying the param, well formed or not', () => {
    expect(isBoardInviteRequest('/b/the-garage', new URLSearchParams({ invite: TOKEN }))).toBe(true);
    expect(isBoardInviteRequest('/b/the-garage/40/list', new URLSearchParams({ invite: 'x' }))).toBe(true);
  });

  it('leaves other paths and the clean link alone', () => {
    expect(isBoardInviteRequest('/b/the-garage', new URLSearchParams())).toBe(false);
    expect(isBoardInviteRequest('/gym/the-gym', new URLSearchParams({ invite: TOKEN }))).toBe(false);
  });
});

describe('token redaction', () => {
  it('finds the token as its own param and inside an encoded sign-in return URL', () => {
    expect(searchCarriesBoardInvite(`?invite=${TOKEN}`)).toBe(true);
    expect(searchCarriesBoardInvite(`?callbackUrl=${encodeURIComponent(`/b/the-garage?invite=${TOKEN}`)}`)).toBe(true);
    const nested = `?callbackUrl=${encodeURIComponent(`/auth/login?callbackUrl=${encodeURIComponent(`/b/the-garage?invite=${TOKEN}`)}`)}`;
    expect(searchCarriesBoardInvite(nested)).toBe(true);
    expect(redactShareCapabilities(nested)).not.toContain(TOKEN);
    expect(searchCarriesBoardInvite('?src=qr&medium=kiosk')).toBe(false);
  });

  it('replaces every token value and keeps the rest of the URL', () => {
    const redacted = redactShareCapabilities(`https://www.boardsesh.com/b/the-garage?invite=${TOKEN}&src=qr`);
    expect(redacted).toBe('https://www.boardsesh.com/b/the-garage?invite=[redacted]&src=qr');
    const encoded = redactShareCapabilities(
      `/auth/login?callbackUrl=${encodeURIComponent(`/b/the-garage?invite=${TOKEN}`)}`,
    );
    expect(encoded).not.toContain(TOKEN);
  });

  it('scrubs a Sentry event wherever a URL landed, and passes other events through untouched', () => {
    const event = {
      request: { url: `https://www.boardsesh.com/b/the-garage?invite=${TOKEN}` },
      breadcrumbs: [{ category: 'navigation', data: { from: '/', to: `/b/the-garage?invite=${TOKEN}` } }],
      spans: [{ data: { 'url.full': `https://www.boardsesh.com/b/the-garage?invite=${TOKEN}` } }],
    };
    const scrubbed = redactShareCapabilitiesFromEvent(event);
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(scrubbed.request.url).toBe('https://www.boardsesh.com/b/the-garage?invite=[redacted]');

    const ordinary = { request: { url: 'https://www.boardsesh.com/b/the-garage' } };
    expect(redactShareCapabilitiesFromEvent(ordinary)).toBe(ordinary);
  });
});
