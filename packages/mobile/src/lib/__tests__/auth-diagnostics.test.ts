import { afterEach, describe, expect, it } from 'vitest';
import { classifySignInResult, runAuthDiagnostic } from '../auth-diagnostics';
import { getDiagnosticSnapshot, initializeMobileDiagnostics, setDiagnosticSink } from '../mobile-diagnostics';

afterEach(() => setDiagnosticSink(undefined));

describe('auth diagnostic outcomes', () => {
  it.each([
    [{ success: true }, 'success'],
    [{ success: false, status: 401 }, 'failure'],
    [{ success: false, cancelled: true }, 'cancelled'],
    [{ success: false, redirecting: true }, 'superseded'],
  ] as const)('classifies returned result %j as %s', async (result, outcome) => {
    const resolved = await runAuthDiagnostic('test.login', async () => result, classifySignInResult);
    expect(resolved).toBe(result);
    expect(getDiagnosticSnapshot().completed.auth?.outcome).toBe(outcome);
  });

  it('preserves success despite a failed telemetry sink and excludes response secrets', async () => {
    initializeMobileDiagnostics({ launchId: 'auth-test-launch' });
    setDiagnosticSink(() => {
      throw new Error('reporter offline');
    });
    const result = { success: false, status: 503, error: 'private-provider-response', token: 'private-token' };
    expect(
      await runAuthDiagnostic(
        'test.login',
        async (operation) => {
          operation.step('credential_persist');
          return result;
        },
        classifySignInResult,
      ),
    ).toBe(result);
    const completed = getDiagnosticSnapshot().completed.auth;
    expect(completed?.outcome).toBe('failure');
    expect(completed?.attributes).toEqual({ status: 503 });
    expect(JSON.stringify(getDiagnosticSnapshot())).not.toContain('private-');
  });

  it('finishes cancelled while preserving the original rejection', async () => {
    const error = Object.assign(new Error('user cancelled'), { name: 'AbortError' });
    await expect(
      runAuthDiagnostic(
        'test.login',
        async () => {
          throw error;
        },
        classifySignInResult,
      ),
    ).rejects.toBe(error);
    expect(getDiagnosticSnapshot().completed.auth?.outcome).toBe('cancelled');
  });
});
