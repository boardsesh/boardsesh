import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { chargeBoardRequestAddress } from '../graphql/resolvers/feedback/board-request-limit';
import { resetAllRateLimits } from '../utils/rate-limiter';

const { connected, configured, evaluate } = vi.hoisted(() => ({
  connected: vi.fn(() => false),
  configured: vi.fn(() => false),
  evaluate: vi.fn(),
}));
vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConfigured: configured,
    isRedisConnected: connected,
    getClients: () => ({ publisher: { eval: evaluate } }),
  },
}));

describe('private board-request ingress quota', () => {
  const ip = '192.0.2.37';
  beforeEach(() => {
    resetAllRateLimits();
    connected.mockReturnValue(false);
    configured.mockReturnValue(false);
    evaluate.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, 'unknown'])('refuses a request without a trusted address', async (unknownAddress) => {
    await expect(chargeBoardRequestAddress(unknownAddress)).rejects.toMatchObject({
      extensions: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('charges the shared address across requests and returns the distributed retry window', async () => {
    connected.mockReturnValue(true);
    configured.mockReturnValue(true);
    evaluate.mockResolvedValueOnce(5).mockResolvedValueOnce(6);
    await expect(chargeBoardRequestAddress(ip)).resolves.toBeUndefined();
    await expect(chargeBoardRequestAddress(ip)).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) },
    });
    const keys = evaluate.mock.calls.map((call) => call[2]);
    expect(keys[0]).toMatch(/^ratelimit:board-request-ip:192\.0\.2\.37:submitBoardRequest:/);
    expect(keys[1]).toBe(keys[0]);
  });
  it('rejects both disconnected and failing configured Redis without using fresh memory buckets', async () => {
    configured.mockReturnValue(true);
    const unavailable = { extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 60 } };
    await expect(chargeBoardRequestAddress(ip)).rejects.toMatchObject(unavailable);
    connected.mockReturnValue(true);
    evaluate.mockRejectedValueOnce(new Error('synthetic Redis failure'));
    await expect(chargeBoardRequestAddress(ip)).rejects.toMatchObject(unavailable);
  });
  it('requires a shared quota outside explicitly local or test environments', async () => {
    vi.stubEnv('NODE_ENV', '');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('VERCEL_ENV', '');
    await expect(chargeBoardRequestAddress(ip)).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
  });
  it('allows the normal quota in an explicitly local single process', async () => {
    for (let index = 0; index < 5; index++) await chargeBoardRequestAddress(ip);
    await expect(chargeBoardRequestAddress(ip)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
    await expect(chargeBoardRequestAddress('192.0.2.38')).resolves.toBeUndefined();
  });
});
