import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { applyOriginRule, originRule, planOriginRule } from './cloudflare-origin-apply';
const secret = 'a'.repeat(64);
afterEach(() => vi.unstubAllGlobals());

describe('origin header transform', () => {
  it('overwrites a client header only on www', () => {
    const rule = originRule(secret);
    expect(rule.expression).toBe('(http.host eq "www.boardsesh.com")');
    expect(rule.action_parameters?.headers?.['x-boardsesh-origin-verify']).toEqual({ operation: 'set', value: secret });
  });
  it('preserves foreign rules and reports no credentials in a rotation plan', () => {
    const rules = [
      { id: 'foreign', description: 'other transform' },
      { ...originRule('b'.repeat(64)), id: 'owned' },
    ];
    expect(planOriginRule(rules, secret)).toEqual({ action: 'update', id: 'owned' });
    expect(rules[0]).toEqual({ id: 'foreign', description: 'other transform' });
  });
  it('is idempotent', () => {
    expect(planOriginRule([{ ...originRule(secret), id: 'owned' }], secret).action).toBe('none');
  });
  it('rejects another rule owning the same header', () => {
    expect(() =>
      planOriginRule(
        [{ action_parameters: { headers: { 'X-Boardsesh-Origin-Verify': { operation: 'remove' } } } }],
        secret,
      ),
    ).toThrow('Another rule');
  });
  it('rejects weak or malformed secrets', () => {
    expect(() => originRule('short')).toThrow('32 random bytes');
  });
  it('never prints a secret echoed by an API failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ secret }), { status: 403 })));
    await expect(
      applyOriginRule({ CLOUDFLARE_API_TOKEN: 'token', WEB_ORIGIN_VERIFY_SECRET: secret }, true),
    ).rejects.toThrow('HTTP 403');
  });
  it('dry run never writes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await applyOriginRule({ CLOUDFLARE_API_TOKEN: 'token', WEB_ORIGIN_VERIFY_SECRET: secret }, false)).toBe(
      'Dry run: create origin header rule',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
});

it('updates only the owned rule and verifies it without replacing the ruleset', async () => {
  const foreign = { id: 'foreign', description: 'unrelated transform' };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { id: 'ruleset', rules: [foreign, { ...originRule('b'.repeat(64)), id: 'owned' }] },
      }),
    )
    .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { id: 'ruleset', rules: [foreign, { ...originRule(secret), id: 'owned' }] },
      }),
    );
  vi.stubGlobal('fetch', fetchMock);
  expect(await applyOriginRule({ CLOUDFLARE_API_TOKEN: 'token', WEB_ORIGIN_VERIFY_SECRET: secret }, true)).toBe(
    'Applied and verified origin header rule',
  );
  expect(fetchMock.mock.calls[1][0]).toContain('/rulesets/ruleset/rules/owned');
  expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(originRule(secret));
});

it('withholds malformed API response bodies', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`invalid ${secret}`)));
  await expect(
    applyOriginRule({ CLOUDFLARE_API_TOKEN: 'token', WEB_ORIGIN_VERIFY_SECRET: secret }, true),
  ).rejects.toThrow('invalid JSON; response withheld');
});
