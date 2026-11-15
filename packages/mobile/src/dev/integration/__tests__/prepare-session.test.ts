import { describe, expect, it, vi } from 'vitest';
import { prepareIntegrationSession } from '../prepare-session';

function setup() {
  return {
    preparePreferences: vi.fn().mockResolvedValue(undefined),
    resolveSession: vi.fn().mockResolvedValue({ status: 'anonymous' }),
    signIn: vi.fn().mockResolvedValue({ success: true }),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
}

describe('integration session bootstrap', () => {
  it('preserves an authenticated session without signing in again', async () => {
    const dependencies = setup();
    dependencies.resolveSession.mockResolvedValue({ status: 'authenticated' });
    await prepareIntegrationSession(dependencies);
    expect(dependencies.signIn).not.toHaveBeenCalled();
    expect(dependencies.preparePreferences).toHaveBeenCalledOnce();
  });
  it('requires the real session resolver to confirm a successful sign-in', async () => {
    const dependencies = setup();
    dependencies.resolveSession
      .mockResolvedValueOnce({ status: 'anonymous' })
      .mockResolvedValue({ status: 'authenticated' });
    await prepareIntegrationSession(dependencies);
    expect(dependencies.signIn).toHaveBeenCalledOnce();
    expect(dependencies.resolveSession).toHaveBeenCalledTimes(2);
  });
  it('does not start another sign-in when stored credentials are temporarily unavailable', async () => {
    const dependencies = setup();
    dependencies.resolveSession.mockResolvedValue({ status: 'unavailable' });
    await expect(prepareIntegrationSession(dependencies)).rejects.toThrow('unavailable');
    expect(dependencies.signIn).not.toHaveBeenCalled();
  });
  it('bounds retries for transient failures', async () => {
    const dependencies = setup();
    dependencies.signIn.mockResolvedValue({ success: false, status: 503 });
    await expect(prepareIntegrationSession(dependencies)).rejects.toThrow('three attempts');
    expect(dependencies.signIn).toHaveBeenCalledTimes(3);
    expect(dependencies.sleep.mock.calls).toEqual([[2000], [4000]]);
  });
  it('never retries rejected credentials', async () => {
    const dependencies = setup();
    dependencies.signIn.mockResolvedValue({ success: false, status: 401 });
    await expect(prepareIntegrationSession(dependencies)).rejects.toThrow('401');
    expect(dependencies.signIn).toHaveBeenCalledOnce();
    expect(dependencies.sleep).not.toHaveBeenCalled();
  });
  it('fails instead of releasing the app after an unconfirmed sign-in', async () => {
    const dependencies = setup();
    dependencies.resolveSession
      .mockResolvedValueOnce({ status: 'anonymous' })
      .mockResolvedValue({ status: 'unavailable' });
    await expect(prepareIntegrationSession(dependencies)).rejects.toThrow('unavailable');
  });
});
