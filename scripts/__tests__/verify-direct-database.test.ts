import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { createClient, unsafe, end } = vi.hoisted(() => {
  const unsafe = vi.fn<(query: string) => Promise<unknown>>();
  const end = vi.fn<(options: { timeout: number }) => Promise<void>>();
  const createClient = vi.fn((_url: string, _options: Record<string, unknown>) => ({ unsafe, end }));
  return { createClient, unsafe, end };
});
vi.mock('postgres', () => ({ default: createClient }));

import { DIRECT_DATABASE_PROBE_TIMEOUT_MS } from '../../packages/db/scripts/direct-database-guard';
import { verifyDirectDatabase } from '../../packages/db/scripts/verify-direct-database';

const MIGRATOR_URL = 'postgresql://boardsesh_migrator:private-password@direct.example:5432/railway';

describe('direct migration endpoint CLI operation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unsafe.mockResolvedValue([{ '?column?': 1 }]);
    end.mockResolvedValue();
    vi.stubEnv('MIGRATOR_DATABASE_URL', MIGRATOR_URL);
    vi.stubEnv('DATABASE_DIRECT_ENDPOINT', 'direct.example:5432/railway');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('probes only the dedicated migrator connection and closes it', async () => {
    vi.stubEnv('DATABASE_DIRECT_URL', 'postgresql://postgres:old-shared-password@obsolete.example/railway');
    vi.stubEnv('DATABASE_URL', 'postgresql://runtime:runtime-password@pooler.example/railway');
    await verifyDirectDatabase();
    expect(createClient).toHaveBeenCalledExactlyOnceWith(
      MIGRATOR_URL,
      expect.objectContaining({
        max: 1,
        ssl: 'require',
        connection: { statement_timeout: DIRECT_DATABASE_PROBE_TIMEOUT_MS },
      }),
    );
    expect(unsafe).toHaveBeenCalledExactlyOnceWith('SELECT 1');
    expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });

  it('does not fall back to an old shared direct credential', async () => {
    vi.stubEnv('MIGRATOR_DATABASE_URL', undefined);
    vi.stubEnv('DATABASE_DIRECT_URL', MIGRATOR_URL);
    await expect(verifyDirectDatabase()).rejects.toThrow('MIGRATOR_DATABASE_URL is required');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('honors explicit certificate verification instead of overriding it with require', async () => {
    vi.stubEnv('MIGRATOR_DATABASE_URL', `${MIGRATOR_URL}?sslmode=verify-full`);
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    await verifyDirectDatabase();
    expect(createClient).toHaveBeenCalledWith(
      `${MIGRATOR_URL}?sslmode=verify-full`,
      expect.objectContaining({
        ssl: { rejectUnauthorized: true },
      }),
    );
  });

  it('refuses an unpinned endpoint before creating any client', async () => {
    vi.stubEnv('DATABASE_DIRECT_ENDPOINT', 'pooler.example:6432/railway');
    await expect(verifyDirectDatabase()).rejects.toThrow('does not match the trusted PostgreSQL endpoint');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('keeps both successful and failed probe outcomes when closing fails, without logging credentials', async () => {
    end.mockRejectedValue(new Error(MIGRATOR_URL));
    await expect(verifyDirectDatabase()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith('Direct migration endpoint probe connection cleanup failed');
    unsafe.mockRejectedValue(new Error(MIGRATOR_URL));
    await expect(verifyDirectDatabase()).rejects.toThrow('failed TLS connectivity or SELECT 1 verification');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-password');
  });

  it('bounds a stalled probe and closes its client', async () => {
    vi.useFakeTimers();
    unsafe.mockImplementation(() => new Promise(() => {}));

    const verification = verifyDirectDatabase();
    const rejectedVerification = expect(verification).rejects.toThrow(
      'failed TLS connectivity or SELECT 1 verification',
    );
    await vi.advanceTimersByTimeAsync(DIRECT_DATABASE_PROBE_TIMEOUT_MS);

    await rejectedVerification;
    expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
});
