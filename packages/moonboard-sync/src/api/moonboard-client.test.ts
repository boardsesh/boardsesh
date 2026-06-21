import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoonBoardClient, parseSetCookieHeaders } from './moonboard-client';

function htmlResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe('parseSetCookieHeaders', () => {
  it('extracts cookie name/value pairs from combined Set-Cookie headers', () => {
    expect(
      parseSetCookieHeaders([
        'ARRAffinity=abc; path=/; HttpOnly, __RequestVerificationToken=def; path=/; secure; HttpOnly',
      ]),
    ).toEqual(['ARRAffinity=abc', '__RequestVerificationToken=def']);
  });
});

describe('MoonBoardClient.authenticate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts CSRF tokens from reordered single-quoted input attributes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        htmlResponse(
          `<form id='frmLogin'>
            <input value='csrf-token' name='__RequestVerificationToken'>
            <input name='form_key' value='form-key'>
          </form>`,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/account' } }))
      .mockResolvedValueOnce(htmlResponse('<main>Account</main>'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new MoonBoardClient('https://moonboard.test');
    await expect(client.authenticate('user@example.com', 'secret')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const submittedRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(submittedRequest.body).toBeInstanceOf(URLSearchParams);
    const submittedBody = submittedRequest.body as URLSearchParams;
    expect(submittedBody.get('__RequestVerificationToken')).toBe('csrf-token');
    expect(submittedBody.get('form_key')).toBe('form-key');
  });

  it('rejects a successful status that returns the login form again', async () => {
    const loginForm = `<form id="frmLogin">
      <input name="__RequestVerificationToken" value="csrf-token">
      <input name="form_key" value="form-key">
    </form>`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(loginForm))
      .mockResolvedValueOnce(htmlResponse(loginForm));
    vi.stubGlobal('fetch', fetchMock);

    const client = new MoonBoardClient('https://moonboard.test');
    await expect(client.authenticate('user@example.com', 'wrong')).rejects.toThrow(/still on login form/);
  });
});
