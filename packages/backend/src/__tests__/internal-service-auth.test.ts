import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import { authenticateInternalServiceSecret } from '../middleware/internal-service-auth';

describe('authenticateInternalServiceSecret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a matching bearer secret', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', 'test-internal-secret');
    expect(authenticateInternalServiceSecret('Bearer test-internal-secret')).toBe(true);
  });

  it('rejects a mismatched secret', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', 'test-internal-secret');
    expect(authenticateInternalServiceSecret('Bearer wrong-value')).toBe(false);
  });

  it('rejects a secret of a different length (still constant-time, never throws)', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', 'test-internal-secret');
    expect(authenticateInternalServiceSecret('Bearer short')).toBe(false);
    expect(authenticateInternalServiceSecret('Bearer way-way-way-too-long-to-match-anything')).toBe(false);
  });

  it('fails closed when INTERNAL_SERVICE_SECRET is not configured', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', '');
    expect(authenticateInternalServiceSecret('Bearer anything')).toBe(false);
  });

  it('fails closed when INTERNAL_SERVICE_SECRET is blank whitespace', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', '   ');
    expect(authenticateInternalServiceSecret('Bearer   ')).toBe(false);
  });

  it('rejects a null header', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', 'test-internal-secret');
    expect(authenticateInternalServiceSecret(null)).toBe(false);
  });

  it('is not fooled by a plain-value header missing the Bearer prefix', () => {
    vi.stubEnv('INTERNAL_SERVICE_SECRET', 'test-internal-secret');
    expect(authenticateInternalServiceSecret('test-internal-secret')).toBe(false);
  });
});
