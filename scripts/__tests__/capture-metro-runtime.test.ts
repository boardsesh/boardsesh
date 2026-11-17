import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { captureMetroRuntimeEnv } from '../lib/capture-metro-runtime';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

const resolved = JSON.stringify({ runtimeVersion: 'actual-runtime', fingerprintSources: [] });

describe('immutable iOS capture Metro runtime', () => {
  it('uses the bounded iOS resolver command from the mobile directory', () => {
    vi.mocked(execFileSync).mockReturnValueOnce(resolved);
    captureMetroRuntimeEnv({ CAPTURE: '1' }, '/mobile');
    expect(execFileSync).toHaveBeenCalledWith(
      'vp',
      ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', 'ios'],
      expect.objectContaining({ cwd: '/mobile', env: { CAPTURE: '1', CI: '1' }, timeout: 120_000 }),
    );
  });
  it('resolves once with the exact capture environment and preserves its input', () => {
    const env = Object.freeze({ CI: '0', EXPO_PUBLIC_STORY_MODE: '1', CUSTOM_CAPTURE_FLAG: 'kept' });
    const resolveRuntime = vi.fn(() => resolved);
    const result = captureMetroRuntimeEnv(env, '/mobile', resolveRuntime);
    expect(resolveRuntime).toHaveBeenCalledExactlyOnceWith('/mobile', { ...env, CI: '1' });
    expect(result).toEqual({ ...env, CI: '1', EXPO_UPDATES_FINGERPRINT_OVERRIDE: 'actual-runtime' });
    expect(env).toEqual({ CI: '0', EXPO_PUBLIC_STORY_MODE: '1', CUSTOM_CAPTURE_FLAG: 'kept' });
  });

  it('respects an existing nonempty override without resolving again', () => {
    const resolveRuntime = vi.fn();
    const env = { EXPO_UPDATES_FINGERPRINT_OVERRIDE: ' existing-runtime ' };
    expect(captureMetroRuntimeEnv(env, '/mobile', resolveRuntime)).toEqual({ ...env, CI: '1' });
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it('resolves a whitespace-only override', () => {
    expect(captureMetroRuntimeEnv({ EXPO_UPDATES_FINGERPRINT_OVERRIDE: ' ' }, '/mobile', () => resolved)).toMatchObject(
      { EXPO_UPDATES_FINGERPRINT_OVERRIDE: 'actual-runtime' },
    );
  });

  it.each([
    'not json',
    '{}',
    '{"runtimeVersion":"x"}',
    '{"runtimeVersion":"","fingerprintSources":[]}',
    '{"runtimeVersion":" x ","fingerprintSources":[]}',
  ])('fails closed on malformed output %s', (stdout) => {
    expect(() => captureMetroRuntimeEnv({}, '/mobile', () => stdout)).toThrow();
  });

  it('fails closed without exposing resolver output on command errors', () => {
    expect(() =>
      captureMetroRuntimeEnv({}, '/mobile', () => {
        throw new Error('sensitive child output');
      }),
    ).toThrow('Could not resolve the iOS capture Metro runtime within 120 seconds');
  });
});
