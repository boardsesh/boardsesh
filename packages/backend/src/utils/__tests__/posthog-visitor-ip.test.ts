import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolvePosthogVisitorIp } from '../posthog-visitor-ip';
import { resolveEdgeVisitorIp } from '../flag-country';

const PROOF = 'test-origin-proof-secret-at-least-32-bytes';
const NEXT_PROOF = 'rotated-origin-proof-secret-at-least-32-bytes';
const captureUrl = new URL('https://ws.boardsesh.com/api/posthog/batch/');

function request(headers: IncomingMessage['headers'] = {}): IncomingMessage {
  return {
    headers: {
      host: 'ws.boardsesh.com',
      'x-forwarded-for': '172.64.209.4, 79.127.151.145',
      'cf-connecting-ip': '203.0.113.7',
      'x-boardsesh-origin-proof': PROOF,
      ...headers,
    },
    socket: { remoteAddress: '::ffff:100.64.0.4' },
  } as unknown as IncomingMessage;
}

describe('PostHog visitor IP behind hosted ingress', () => {
  beforeEach(() => {
    vi.stubEnv('POSTHOG_ORIGIN_PROOF_SECRET', PROOF);
    vi.stubEnv('POSTHOG_ORIGIN_PROOF_SECRET_NEXT', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('accepts our zone proof through the observed CGNAT/public proxy chain without changing generic trust', () => {
    const req = request();
    expect(resolvePosthogVisitorIp(req, captureUrl)).toBe('203.0.113.7');
    expect(resolveEdgeVisitorIp(req)).toBeNull();
  });

  it('ignores a forged earlier XFF address even on a proven request', () => {
    expect(resolvePosthogVisitorIp(request({ 'x-forwarded-for': '1.1.1.1, 104.16.0.5' }), captureUrl)).toBe(
      '203.0.113.7',
    );
  });

  it.each([undefined, '', 'incorrect', `${PROOF}, ${PROOF}`, [PROOF, PROOF]])(
    'rejects a missing, wrong or duplicated proof: %j',
    (proof) => {
      expect(resolvePosthogVisitorIp(request({ 'x-boardsesh-origin-proof': proof }), captureUrl)).toBeNull();
    },
  );

  it('fails closed without a configured secret, even with Cloudflare in XFF', () => {
    vi.stubEnv('POSTHOG_ORIGIN_PROOF_SECRET', '');
    expect(resolvePosthogVisitorIp(request(), captureUrl)).toBeNull();
  });

  it('accepts the next secret during rotation', () => {
    vi.stubEnv('POSTHOG_ORIGIN_PROOF_SECRET_NEXT', NEXT_PROOF);
    expect(resolvePosthogVisitorIp(request({ 'x-boardsesh-origin-proof': NEXT_PROOF }), captureUrl)).toBe(
      '203.0.113.7',
    );
  });

  it.each(['api.boardsesh.com', 'origin.up.railway.app', 'ws.boardsesh.com.evil.example', undefined])(
    'rejects a proof outside its host scope: %s',
    (host) => {
      expect(resolvePosthogVisitorIp(request({ host }), captureUrl)).toBeNull();
    },
  );

  it.each(['/graphql', '/api/posthog-forged/batch/', '/api/auth/login'])('rejects a proof on %s', (path) => {
    expect(resolvePosthogVisitorIp(request(), new URL(path, captureUrl))).toBeNull();
  });

  it.each([
    undefined,
    '',
    'unknown',
    '203.0.113.7, 1.1.1.1',
    ['203.0.113.7', '1.1.1.1'],
    '10.0.0.1',
    '192.168.1.1',
    '100.64.0.4',
    '127.0.0.1',
    '169.254.1.1',
    '0.0.0.0',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:c0a8:114',
    '::ffff:6440:304',
  ])('rejects an unusable visitor address despite valid proof: %j', (address) => {
    expect(resolvePosthogVisitorIp(request({ 'cf-connecting-ip': address }), captureUrl)).toBeNull();
  });

  it.each([
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:db8::7', '2001:db8::7'],
  ])('normalizes public visitor %s to %s', (address, expected) => {
    expect(resolvePosthogVisitorIp(request({ 'cf-connecting-ip': address }), captureUrl)).toBe(expected);
  });
});
