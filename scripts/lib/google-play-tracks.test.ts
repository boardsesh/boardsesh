import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlayRequest, PLAY_ERROR_MESSAGE_LIMIT, playErrorDetail } from './google-play-tracks';

const TOKEN = 'ya29.access-token-under-test';
const envelope = (message: unknown, status: unknown = 'FAILED_PRECONDITION') =>
  JSON.stringify({ error: { code: 400, message, status } });

afterEach(() => vi.unstubAllGlobals());

describe('playErrorDetail', () => {
  it("returns Google's status and message", () => {
    expect(playErrorDetail(envelope('Changes cannot be sent for review automatically.'), TOKEN)).toBe(
      'FAILED_PRECONDITION: Changes cannot be sent for review automatically.',
    );
  });

  it('scrubs the access token, OAuth and JWT tokens, bearer headers, keys and emails', () => {
    const detail = playErrorDetail(
      envelope(
        `token ${TOKEN} other ya29.someone-elses jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJwbGF5In0.c2lnbmF0dXJl Bearer abc.def ` +
          '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- for play@boardsesh.iam.gserviceaccount.com',
      ),
      TOKEN,
    );
    expect(detail).toBe(
      'FAILED_PRECONDITION: token [redacted token] other [redacted token] jwt [redacted token] Bearer [redacted] [redacted key] for [redacted email]',
    );
  });

  it('scrubs a key that the message cuts off before its end marker', () => {
    expect(playErrorDetail(envelope('key -----BEGIN PRIVATE KEY-----\nMIIE'), TOKEN)).toBe(
      'FAILED_PRECONDITION: key [redacted key]',
    );
  });

  it('caps the message length and keeps it on one line', () => {
    const detail = playErrorDetail(envelope(`line one\n\nline two ${'x'.repeat(400)}`), TOKEN);
    expect(detail).not.toBeNull();
    expect(detail).not.toContain('\n');
    // The status prefix, then at most the limit's worth of message and one `…`.
    expect(detail!.length).toBe('FAILED_PRECONDITION: '.length + PLAY_ERROR_MESSAGE_LIMIT + '…'.length);
    expect(detail!.endsWith('…')).toBe(true);
  });

  it.each([
    ['plain text', 'private service-account diagnostic'],
    ['JSON without an error envelope', JSON.stringify({ message: 'private' })],
    ['an envelope without a message', JSON.stringify({ error: { code: 400 } })],
    ['an empty message', envelope('   ')],
    ['a JSON scalar', '"private"'],
  ])('returns nothing for %s', (_name, body) => {
    expect(playErrorDetail(body, TOKEN)).toBeNull();
  });

  it('drops a status that is not an enum name', () => {
    expect(playErrorDetail(envelope('Bad edit', 'not an enum'), TOKEN)).toBe('Bad edit');
  });
});

describe('createPlayRequest errors', () => {
  it('names the method, path and Google message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(envelope(`Edit rejected for ${TOKEN}`), { status: 400 })),
    );
    const request = createPlayRequest(TOKEN, 'production');
    await expect(request('/edits/edit-1:validate', 'POST')).rejects.toThrow(
      `Google Play production request returned HTTP 400 (POST /edits/edit-1:validate): FAILED_PRECONDITION: Edit rejected for [redacted token]`,
    );
  });

  it('never shows a body that is not Google’s error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private service-account diagnostic', { status: 500 })),
    );
    const error = await createPlayRequest(
      TOKEN,
      'production',
    )('/tracks/production/releases').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Google Play production request returned HTTP 500 (GET /tracks/production/releases)',
    );
  });
});
